import { DOCKER_SOURCES, DOCKER_TTL, type DiskUsage, type DockerContainer, type Health } from "../collectors/docker";
import {
  PROM_SOURCES,
  PROM_TTL,
  type ContainerMetrics,
  type HostMetrics,
  type HostSeries,
} from "../collectors/prometheus";
import { hourLabels } from "../lib/charts";
import { squarify } from "../lib/treemap";
import { indexManifest, type Manifest, type ManifestIndex, type Service, type ServiceHost } from "../manifest";
import type { Snapshot, Store } from "../store";
import { buildServiceActions, type ServiceActionsVM, type ServiceView } from "./service-actions-model";
import { buildAuthTab, type AuthTabVM, type SecretsView } from "./auth-model";
import { buildServiceDatabases, type ServiceDatabasesVM } from "./databases-model";
import type { DatabasesView, DnsView, RegistryView } from "./phase4-input";

export const HOSTS: readonly ServiceHost[] = ["vps", "jenkins"];
export const DOCKER_HOST: ServiceHost = "vps";
export const HOST_ROLE: Record<ServiceHost, string> = { vps: "Public web host", jenkins: "CI/CD host" };
export const STALE_TTL_FACTOR = 3;
export const DISK_WARN_RATIO = 0.75;
export const TOP_TILES = 7;
export const TINY_WIDTH_PCT = 5;
export const DEFAULT_TIME_ZONE = "UTC";

export type SourceKey = "hosts" | "containers" | "series" | "docker" | "df";

const SOURCE_META: Record<SourceKey, { name: string; label: string; ttlMs: number }> = {
  hosts: { name: PROM_SOURCES.hosts, label: "Prometheus", ttlMs: PROM_TTL.instantMs },
  containers: { name: PROM_SOURCES.containers, label: "Prometheus", ttlMs: PROM_TTL.instantMs },
  series: { name: PROM_SOURCES.series, label: "Prometheus", ttlMs: PROM_TTL.seriesMs },
  docker: { name: DOCKER_SOURCES.containers, label: "Docker", ttlMs: DOCKER_TTL.containersMs },
  df: { name: DOCKER_SOURCES.df, label: "Docker disk usage", ttlMs: DOCKER_TTL.dfMs },
};

export interface Sources {
  hosts: Snapshot<HostMetrics[]> | null;
  containers: Snapshot<ContainerMetrics[]> | null;
  series: Snapshot<HostSeries[]> | null;
  docker: Snapshot<DockerContainer[]> | null;
  df: Snapshot<DiskUsage> | null;
}

export function readSources(store: Store): Sources {
  const names = new Set(store.names());
  const get = <T>(k: SourceKey): Snapshot<T> | null => (names.has(SOURCE_META[k].name) ? store.peek<T>(SOURCE_META[k].name) : null);
  return {
    hosts: get("hosts"),
    containers: get("containers"),
    series: get("series"),
    docker: get("docker"),
    df: get("df"),
  };
}

export type SourceState = "fresh" | "stale" | "loading" | "error" | "off";

export interface UpVM {
  running: number;
  total: number;
  building: number;
}

export type ExtraSourceKey = "jenkins" | "loki" | "registry" | "dns" | "pdns" | "databases";

export interface SourceStatus {
  key: SourceKey | ExtraSourceKey;
  label: string;
  state: SourceState;
  ageMs: number | null;
  error: string | null;
}

export function sourceStatus(key: SourceKey, snap: Snapshot<unknown> | null): SourceStatus {
  const { label, ttlMs } = SOURCE_META[key];
  return snapshotStatus(key, label, ttlMs, snap);
}

export function snapshotStatus(key: SourceStatus["key"], label: string, ttlMs: number, snap: Snapshot<unknown> | null): SourceStatus {
  if (!snap) return { key, label, state: "off", ageMs: null, error: null };
  const base = { key, label, ageMs: snap.ageMs, error: snap.lastError };
  if (snap.data === undefined) return { ...base, state: snap.lastError ? "error" : "loading" };
  const old = snap.ageMs !== null && snap.ageMs > STALE_TTL_FACTOR * Math.max(ttlMs, snap.cadenceMs);
  return { ...base, state: snap.lastError || old ? "stale" : "fresh" };
}

export const hasData = (s: SourceStatus) => s.state === "fresh" || s.state === "stale";

export function fmtNum(v: number, digits = 1): string {
  return v >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(digits).replace(/\.0+$/, "");
}

export function bytesParts(b: number): [string, string] {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = Math.max(b, 0);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return [fmtNum(v), units[i]!];
}

export const fmtBytes = (b: number) => bytesParts(b).join(" ");
export const fmtRate = (bps: number) => `${fmtBytes(bps)}/s`;
export const fmtPct = (p: number) => `${Math.round(p)}%`;

export function fmtUptime(sec: number): string {
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function shortImage(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash < 0) return ref;
  const first = ref.slice(0, slash);
  return /[.:]/.test(first) || first === "localhost" ? ref.slice(slash + 1) : ref;
}

export function imageTag(ref: string): string | null {
  const name = ref.split("@")[0]!;
  const i = name.lastIndexOf(":");
  return i > name.lastIndexOf("/") ? name.slice(i + 1) : null;
}

export function commonSuffix(hostnames: string[]): string | null {
  if (hostnames.length < 2) return null;
  const parts = hostnames.map((h) => h.split(".").reverse());
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const label = parts[0]![i];
    if (label === undefined || !parts.every((p) => p[i] === label && p.length > i + 1)) break;
    out.push(label);
  }
  return out.length >= 2 ? out.reverse().join(".") : null;
}

export function shortHostname(h: string, suffix: string | null): string {
  if (!suffix || !h.endsWith(`.${suffix}`)) return h;
  return `${h.slice(0, -suffix.length - 1)}.${suffix.split(".")[0]}`;
}

export type ServiceState = "running" | "degraded" | "failing" | "stopped" | "absent" | "reporting" | "unknown";

export type CpuBasis = "host" | "core";

export interface ContainerRow {
  name: string;
  found: boolean;
  state: string | null;
  status: string | null;
  health: Health | null;
  image: string | null;
  imageId: string | null;
  revision: string | null;
  metricsSeen: boolean;
  cpuPct: number | null;
  cpuBasis: CpuBasis;
  memBytes: number | null;
  rxBps: number | null;
  txBps: number | null;
  diskBytes: number | null;
}

export interface MiddlewareVM {
  ref: string;
  kind: string | null;
}

export interface RouterVM {
  name: string;
  container: string;
  rule: string | null;
  entrypoints: string | null;
  certresolver: string | null;
  middlewares: MiddlewareVM[];
  port: string | null;
}

export interface LabelVM {
  key: string;
  value: string;
  hidden: boolean;
}

export interface ProtectionVM {
  label: string;
  tone: "ok" | "warn" | "";
  detail: string | null;
}

export interface ServiceSummary {
  id: string;
  name: string;
  host: ServiceHost;
  hostname: string | null;
  dir: string;
  core: boolean;
  readOnly: boolean;
  state: ServiceState;
  image: string | null;
  imageFromDocker: boolean;
  memBytes: number | null;
  cpuPct: number | null;
  cpuBasis: CpuBasis;
  cores: number | null;
  rxBps: number | null;
  txBps: number | null;
  diskBytes: number | null;
  protection: ProtectionVM;
}

export interface HostCardVM {
  host: ServiceHost;
  role: string;
  metrics: HostMetrics | null;
  status: SourceStatus;
}

export type UsageMetric = "mem" | "cpu" | "disk" | "net";

export const USAGE_METRICS: readonly { id: UsageMetric; label: string }[] = [
  { id: "mem", label: "Memory" },
  { id: "cpu", label: "CPU" },
  { id: "disk", label: "Disk" },
  { id: "net", label: "Network" },
];

export interface TileLine {
  text: string;
  sans: boolean;
  dot: ServiceState | null;
}

export interface TileVM {
  i: number;
  name: string;
  valueText: string;
  pctText: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tier: number;
  color: string;
  free: boolean;
  href: string | null;
  serviceName: string | null;
  lines: TileLine[];
}

export interface TreemapVM {
  host: ServiceHost;
  metric: UsageMetric;
  compact: boolean;
  headValue: string;
  headLabel: string;
  tiles: TileVM[];
  empty: string | null;
  status: SourceStatus;
}

export interface PathItemVM {
  id: string;
  name: string;
  short: string;
  hostname: string;
  state: ServiceState;
}

export interface AttentionVM {
  tone: "bad" | "warn" | "";
  tag: string;
  title: string;
  detail: string;
  href: string;
}

export interface OverviewVM {
  traefik: { label: string; tls: string | null };
  path: PathItemVM[];
  hosts: HostCardVM[];
  treemap: TreemapVM;
  attention: AttentionVM[];
  up: UpVM;
  building: BuildingNowVM;
  sources: { prom: SourceStatus; docker: SourceStatus };
}

export interface BuildingNowVM {
  status: SourceStatus;
  rows: BuildRowVM[];
  queued: number;
}

export interface ChartsVM {
  series: HostSeries | null;
  stepSec: number | null;
  xLabels: string[];
  timeZone: string;
  dataSince: string | null;
  status: SourceStatus;
}

export interface HostsVM {
  host: ServiceHost;
  hosts: readonly ServiceHost[];
  metric: UsageMetric;
  card: HostCardVM;
  charts: ChartsVM;
  treemap: TreemapVM;
  up: UpVM;
}

export interface ServicesVM {
  rows: ServiceSummary[];
  up: UpVM;
  sources: { prom: SourceStatus; docker: SourceStatus };
}

export type ServiceTab = "summary" | "config" | "auth" | "builds" | "db";

export interface ServiceVM {
  service: Service;
  summary: ServiceSummary;
  tab: ServiceTab;
  tabs: { id: ServiceTab; label: string }[];
  containers: ContainerRow[];
  routers: RouterVM[];
  labels: LabelVM[];
  hostMemTotal: number | null;
  revision: string | null;
  tlsDaysLeft: number | null;
  up: UpVM;
  sources: { prom: SourceStatus; docker: SourceStatus; df: SourceStatus };
  builds: ServiceBuildsVM | null;
  logsHref: string | null;
  actions: ServiceActionsVM | null;
  auth: AuthTabVM | null;
  databases: ServiceDatabasesVM | null;
}

export interface ViewInput {
  manifest: Manifest;
  sources: Sources;
  timeZone?: string;
  csrf?: string;
  jenkins?: JenkinsView;
  logs?: LogsView;
  service?: ServiceView;
  secrets?: SecretsView;
  registry?: RegistryView;
  dns?: DnsView;
  databases?: DatabasesView;
}

const AUTH_MIDDLEWARE: Record<string, string> = {
  basicauth: "Traefik basic-auth",
  digestauth: "Traefik digest auth",
  forwardauth: "Traefik forward auth",
};

const SECRET_SEGMENT = /user|pass|secret|token|credential|key|auth/i;

export const isSecretLabel = (key: string) => SECRET_SEGMENT.test(key.slice(key.lastIndexOf(".") + 1).replace(/\[\d+\]$/, ""));

class Ctx {
  idx: ManifestIndex;
  docker: Map<string, DockerContainer> | null;
  metrics: Map<string, ContainerMetrics>;
  hostMetrics: Map<string, HostMetrics>;
  disk: Map<string, number> | null;
  middlewareKinds: Map<string, string>;
  status: Record<SourceKey, SourceStatus>;
  summaries = new Map<string, ServiceSummary>();
  rows = new Map<string, ContainerRow[]>();

  constructor(public input: ViewInput) {
    const s = input.sources;
    this.idx = indexManifest(input.manifest);
    this.status = {
      hosts: sourceStatus("hosts", s.hosts),
      containers: sourceStatus("containers", s.containers),
      series: sourceStatus("series", s.series),
      docker: sourceStatus("docker", s.docker),
      df: sourceStatus("df", s.df),
    };
    this.docker = s.docker?.data ? new Map(s.docker.data.map((c) => [c.name, c])) : null;
    this.metrics = new Map((s.containers?.data ?? []).map((m) => [`${m.host}/${m.name}`, m]));
    this.hostMetrics = new Map((s.hosts?.data ?? []).map((h) => [h.host, h]));
    this.disk = s.df?.data ? containerDisk(s.df.data) : null;
    this.middlewareKinds = new Map();
    for (const c of s.docker?.data ?? []) {
      for (const k of Object.keys(c.traefik)) {
        const m = /^traefik\.http\.middlewares\.([^.]+)\.([^.]+)\.([^.[]+)/.exec(k);
        if (m) this.middlewareKinds.set(m[1]!, m[2]!.toLowerCase() === "plugin" ? `plugin ${m[3]}` : m[2]!.toLowerCase());
      }
    }
  }

  cpuShare(host: string, raw: number | null): { value: number | null; basis: CpuBasis } {
    const cores = this.hostMetrics.get(host)?.cores ?? null;
    if (!cores) return { value: raw, basis: "core" };
    return { value: raw === null ? null : raw / cores, basis: "host" };
  }

  containerRows(svc: Service): ContainerRow[] {
    const cached = this.rows.get(svc.id);
    if (cached) return cached;
    const onDocker = svc.host === DOCKER_HOST;
    const out = svc.containers.map((name): ContainerRow => {
      const d = onDocker ? this.docker?.get(name) : undefined;
      const m = this.metrics.get(`${svc.host}/${name}`);
      const cpu = this.cpuShare(svc.host, m?.cpuPct ?? null);
      return {
        name,
        found: d !== undefined,
        state: d?.state ?? null,
        status: d?.status ?? null,
        health: d?.health ?? null,
        image: d?.image ?? null,
        imageId: d?.imageId ?? null,
        revision: d?.revision ?? null,
        metricsSeen: m !== undefined,
        cpuPct: cpu.value,
        cpuBasis: cpu.basis,
        memBytes: m?.memBytes ?? null,
        rxBps: m?.rxBps ?? null,
        txBps: m?.txBps ?? null,
        diskBytes: onDocker && this.disk ? (this.disk.get(name) ?? null) : null,
      };
    });
    this.rows.set(svc.id, out);
    return out;
  }

  serviceState(svc: Service): ServiceState {
    const rows = this.containerRows(svc);
    if (svc.host !== DOCKER_HOST) return rows.some((r) => r.metricsSeen) ? "reporting" : "unknown";
    if (!this.docker) return "unknown";
    const found = rows.filter((r) => r.found);
    if (found.length === 0) return "absent";
    if (found.some((r) => r.state === "restarting" || r.state === "dead" || r.health === "unhealthy")) return "failing";
    const running = found.filter((r) => r.state === "running");
    if (running.length === 0) return "stopped";
    if (running.length < rows.length || found.some((r) => r.health === "starting")) return "degraded";
    return "running";
  }

  routers(svc: Service): RouterVM[] {
    const out: RouterVM[] = [];
    if (svc.host !== DOCKER_HOST || !this.docker) return out;
    for (const name of svc.containers) {
      const c = this.docker.get(name);
      if (!c) continue;
      const l = c.traefik;
      const services = new Set<string>();
      const routers = new Set<string>();
      for (const k of Object.keys(l)) {
        const r = /^traefik\.http\.routers\.([^.]+)\./.exec(k);
        if (r) routers.add(r[1]!);
        const s = /^traefik\.http\.services\.([^.]+)\./.exec(k);
        if (s) services.add(s[1]!);
      }
      for (const r of [...routers].sort()) {
        const p = `traefik.http.routers.${r}.`;
        const svcName = l[`${p}service`] ?? (services.size === 1 ? [...services][0]! : null);
        out.push({
          name: r,
          container: name,
          rule: l[`${p}rule`] ?? null,
          entrypoints: l[`${p}entrypoints`] ?? null,
          certresolver: l[`${p}tls.certresolver`] ?? null,
          middlewares: (l[`${p}middlewares`] ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map((ref) => {
              const [mw, provider] = ref.split("@");
              const local = provider === undefined || provider === "docker";
              return { ref, kind: local ? (this.middlewareKinds.get(mw!) ?? null) : null };
            }),
          port: svcName ? (l[`traefik.http.services.${svcName}.loadbalancer.server.port`] ?? null) : null,
        });
      }
    }
    return out;
  }

  labels(svc: Service): LabelVM[] {
    if (svc.host !== DOCKER_HOST || !this.docker) return [];
    const out: LabelVM[] = [];
    for (const name of svc.containers) {
      const c = this.docker.get(name);
      if (!c) continue;
      for (const [key, value] of Object.entries(c.traefik)) {
        const hidden = isSecretLabel(key);
        out.push({ key, value: hidden ? "" : value, hidden });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  protection(svc: Service): ProtectionVM {
    if (svc.host !== DOCKER_HOST) {
      return { label: "Not visible", tone: "", detail: `The panel cannot read Docker labels on the ${svc.host} host.` };
    }
    if (!this.docker) return { label: "Unknown", tone: "", detail: "Docker has not answered yet." };
    if (!this.containerRows(svc).some((r) => r.found)) {
      return { label: "Unknown", tone: "", detail: "No container to read Traefik labels from." };
    }
    const routers = this.routers(svc);
    if (routers.length === 0) {
      return svc.hostname
        ? { label: "No router found", tone: "warn", detail: `${svc.hostname} is in the manifest, but no container carries a Traefik router.` }
        : { label: "No public route", tone: "", detail: null };
    }
    const auth = routers.flatMap((r) => r.middlewares.filter((m) => m.kind && AUTH_MIDDLEWARE[m.kind]));
    if (auth.length) {
      return { label: AUTH_MIDDLEWARE[auth[0]!.kind!]!, tone: "ok", detail: `Middleware ${[...new Set(auth.map((m) => m.ref))].join(", ")}` };
    }
    const plugins = routers.flatMap((r) => r.middlewares.filter((m) => m.kind?.startsWith("plugin ")));
    if (plugins.length) {
      return {
        label: `Traefik ${plugins[0]!.kind}`,
        tone: "",
        detail: `Middleware ${[...new Set(plugins.map((m) => m.ref))].join(", ")}; the panel cannot tell what this plugin checks.`,
      };
    }
    return { label: "No Traefik gate", tone: "", detail: "Traefik forwards requests without a login; any login is the app's own." };
  }

  summary(svc: Service): ServiceSummary {
    const cached = this.summaries.get(svc.id);
    if (cached) return cached;
    const rows = this.containerRows(svc);
    const sum = (f: (r: ContainerRow) => number | null) => {
      const v = rows.map(f).filter((x): x is number => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    };
    const first = rows.find((r) => r.found && r.image);
    const out: ServiceSummary = {
      id: svc.id,
      name: svc.name,
      host: svc.host,
      hostname: svc.hostname,
      dir: svc.dir,
      core: svc.core,
      readOnly: svc.host !== DOCKER_HOST,
      state: this.serviceState(svc),
      image: first?.image ?? svc.images[0] ?? null,
      imageFromDocker: first !== undefined,
      memBytes: sum((r) => r.memBytes),
      cpuPct: sum((r) => r.cpuPct),
      cpuBasis: this.cpuShare(svc.host, null).basis,
      cores: this.hostMetrics.get(svc.host)?.cores ?? null,
      rxBps: sum((r) => r.rxBps),
      txBps: sum((r) => r.txBps),
      diskBytes: sum((r) => r.diskBytes),
      protection: this.protection(svc),
    };
    this.summaries.set(svc.id, out);
    return out;
  }

  up(): UpVM {
    const all = this.input.manifest.services.map((s) => this.summary(s));
    const building = (this.input.jenkins?.snapshot?.data?.builds ?? []).filter((b) => b.building).length;
    return { running: all.filter((s) => s.state === "running" || s.state === "reporting").length, total: all.length, building };
  }

  hostCard(host: ServiceHost): HostCardVM {
    return { host, role: HOST_ROLE[host], metrics: this.hostMetrics.get(host) ?? null, status: this.status.hosts };
  }

  promStatus(): SourceStatus {
    const order: SourceState[] = ["off", "error", "loading", "stale", "fresh"];
    const both = [this.status.hosts, this.status.containers];
    return both.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0]!;
  }
}

function containerDisk(df: DiskUsage): Map<string, number> {
  const users = new Map<string, number>();
  for (const c of df.containers) for (const v of c.volumes) users.set(v, (users.get(v) ?? 0) + 1);
  const sizes = new Map(df.volumes.map((v) => [v.name, v.sizeBytes]));
  const out = new Map<string, number>();
  for (const c of df.containers) {
    let total = c.sizeRw;
    for (const v of c.volumes) total += (sizes.get(v) ?? 0) / (users.get(v) ?? 1);
    out.set(c.name, total);
  }
  return out;
}

interface UsageRow {
  name: string;
  value: number;
  svc: Service | undefined;
  metrics: ContainerMetrics | undefined;
}

const METRIC_FMT: Record<UsageMetric, (v: number) => string> = {
  mem: fmtBytes,
  cpu: fmtPct,
  disk: fmtBytes,
  net: fmtRate,
};

function usageRows(ctx: Ctx, host: ServiceHost, metric: UsageMetric): UsageRow[] | string {
  if (metric === "disk") {
    if (host !== DOCKER_HOST) return `Per-container disk comes from the Docker API, which the panel can only reach on ${DOCKER_HOST}.`;
    if (!ctx.disk) return "";
    return [...ctx.disk.entries()].map(([name, value]) => ({
      name,
      value,
      svc: ctx.idx.byContainer.get(`${host}/${name}`),
      metrics: ctx.metrics.get(`${host}/${name}`),
    }));
  }
  if (!ctx.input.sources.containers?.data) return "";
  return ctx.input.sources.containers.data
    .filter((m) => m.host === host)
    .map((m) => {
      const cpu = ctx.cpuShare(host, m.cpuPct).value;
      const v = metric === "mem" ? m.memBytes : metric === "cpu" ? cpu : m.rxBps === null && m.txBps === null ? null : (m.rxBps ?? 0) + (m.txBps ?? 0);
      return { name: m.name, value: v ?? 0, svc: ctx.idx.byContainer.get(`${host}/${m.name}`), metrics: m };
    });
}

function tileLines(ctx: Ctx, row: UsageRow | undefined, tier: number): TileLine[] {
  if (!row?.svc || tier < 3) return [];
  const s = ctx.summary(row.svc);
  const label = STATE_LABEL[s.state];
  const c = ctx.docker?.get(row.name);
  const tag = c ? imageTag(c.image) : null;
  const ctxText = row.svc.containers.length > 1 ? `part of ${row.svc.name}` : [tag, c?.status].filter(Boolean).join(" · ");
  const lines: TileLine[] = [{ text: ctxText ? `${label} · ${ctxText}` : label, sans: true, dot: s.state }];
  const m = row.metrics;
  if (m) {
    const cpu = ctx.cpuShare(s.host, m.cpuPct).value;
    const parts = [
      cpu !== null ? `CPU ${fmtPct(cpu)}` : null,
      m.memBytes !== null ? fmtBytes(m.memBytes) : null,
      m.rxBps !== null || m.txBps !== null ? fmtRate((m.rxBps ?? 0) + (m.txBps ?? 0)) : null,
    ].filter(Boolean);
    if (parts.length) lines.push({ text: parts.join(" · "), sans: false, dot: null });
  }
  if (tier >= 4) lines.push({ text: `Protection: ${s.protection.label}`, sans: true, dot: null });
  return lines;
}

export const STATE_LABEL: Record<ServiceState, string> = {
  running: "Running",
  degraded: "Degraded",
  failing: "Failing",
  stopped: "Stopped",
  absent: "No container",
  reporting: "Reporting",
  unknown: "Unknown",
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function treemap(ctx: Ctx, host: ServiceHost, metric: UsageMetric, compact: boolean): TreemapVM {
  const status = metric === "disk" ? ctx.status.df : ctx.status.containers;
  const fmt = METRIC_FMT[metric];
  const base = { host, metric, compact, status, tiles: [] as TileVM[], headValue: "", headLabel: "" };
  const rows = usageRows(ctx, host, metric);
  if (typeof rows === "string") return { ...base, empty: rows || null };
  const sorted = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return { ...base, empty: `No container on ${host} reports ${metric === "mem" ? "memory" : metric === "cpu" ? "CPU" : metric === "disk" ? "disk" : "network"} use.` };
  const hm = ctx.hostMetrics.get(host);
  const cpuCapped = metric === "cpu" && !!hm?.cores && hm.cpuPct !== null;
  const cap = metric === "mem" ? (hm?.memTotal ?? null) : metric === "disk" ? (hm?.diskTotal ?? null) : cpuCapped ? 100 : null;
  const usedHost = metric === "mem" ? (hm?.memUsed ?? null) : metric === "disk" ? (hm?.diskUsed ?? null) : cpuCapped ? hm!.cpuPct : null;
  const sum = sorted.reduce((a, r) => a + r.value, 0);
  const segs: { name: string; v: number; color: string; row?: UsageRow; free?: boolean }[] = sorted
    .slice(0, TOP_TILES)
    .map((r, i) => ({ name: r.name, v: r.value, color: `tc-${i}`, row: r }));
  const rest = sorted.slice(TOP_TILES);
  if (rest.length) segs.push({ name: `${rest.length} others`, v: rest.reduce((a, r) => a + r.value, 0), color: `tc-${TOP_TILES}` });
  const capped = cap !== null && usedHost !== null;
  if (capped && usedHost! > sum) segs.push({ name: "System & other", v: usedHost! - sum, color: "tc-sys" });
  if (capped) segs.push({ name: "Free", v: Math.max(cap! - Math.max(usedHost!, sum), 0), color: "tc-free", free: true });
  const total = capped ? cap! : sum;
  const used = capped ? usedHost! : sum;
  const H = compact ? 30 : 36;
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  const items = segs.map((s, i) => ({ ...s, i }));
  const tiles = squarify(items, 0, 0, 100, H).map((r): TileVM => {
    const a = r.w * r.h;
    let tier = a < 55 ? 0 : a < 150 ? 1 : a < 260 ? 2 : a < 420 ? 3 : 4;
    if (r.w < 13) tier = Math.min(tier, 2);
    if (r.w < TINY_WIDTH_PCT) tier = 0;
    if (compact) tier = Math.min(tier, r.w < 17 ? 1 : 2);
    const svc = r.row?.svc;
    return {
      i: r.i,
      name: r.name,
      valueText: fmt(r.v),
      pctText: pct(r.v),
      x: r3(r.x),
      y: r3((r.y / H) * 100),
      w: r3(r.w),
      h: r3((r.h / H) * 100),
      tier,
      color: r.color,
      free: r.free === true,
      href: svc ? `/services/${encodeURIComponent(svc.id)}` : null,
      serviceName: svc?.name ?? null,
      lines: tileLines(ctx, r.row, tier),
    };
  });
  const headLabel = capped
    ? metric === "cpu"
      ? `of ${hm!.cores} cores busy`
      : `of ${fmt(total)} used`
    : metric === "cpu"
      ? "combined · 100% is one core"
      : "combined";
  return { ...base, empty: null, tiles, headValue: fmt(used), headLabel };
}

function attention(ctx: Ctx): AttentionVM[] {
  const out: AttentionVM[] = [];
  const seen = new Set<string>();
  for (const k of ["hosts", "containers", "docker", "df"] as SourceKey[]) {
    const s = ctx.status[k];
    if ((s.state === "error" || s.state === "stale") && !seen.has(s.label)) {
      seen.add(s.label);
      out.push({
        tone: s.state === "error" ? "bad" : "warn",
        tag: s.state === "error" ? "Source" : "Stale",
        title: s.state === "error" ? `${s.label} is not answering` : `${s.label} data is stale`,
        detail: `${s.error ?? "No error was reported."}${s.state === "stale" ? ` Showing data from ${fmtAge(s.ageMs)}.` : ""}`,
        href: `/hosts/${DOCKER_HOST}`,
      });
    }
  }
  for (const svc of ctx.input.manifest.services) {
    const s = ctx.summary(svc);
    const rows = ctx.containerRows(svc);
    const href = `/services/${encodeURIComponent(svc.id)}`;
    if (s.state === "failing") {
      const r = rows.find((x) => x.state === "restarting" || x.state === "dead" || x.health === "unhealthy")!;
      const why = r.state === "restarting" ? `${r.name} keeps restarting` : r.state === "dead" ? `${r.name} is dead` : `${r.name} reports unhealthy`;
      out.push({ tone: "bad", tag: "Down", title: `${svc.name} is failing`, detail: `${why} · ${r.status ?? ""}`.replace(/ · $/, ""), href });
    } else if (s.state === "degraded") {
      const bad = rows.filter((x) => x.state !== "running" || x.health === "starting").map((x) => `${x.name} ${x.found ? (x.health === "starting" ? "is starting" : `is ${x.state}`) : "is missing"}`);
      out.push({ tone: "warn", tag: "Partial", title: `${svc.name} is degraded`, detail: bad.join(", "), href });
    }
  }
  for (const host of HOSTS) {
    const h = ctx.hostMetrics.get(host);
    if (h && h.diskTotal && h.diskUsed !== null && h.diskUsed / h.diskTotal >= DISK_WARN_RATIO) {
      out.push({
        tone: "warn",
        tag: "Space",
        title: `${host} disk is ${fmtPct((h.diskUsed / h.diskTotal) * 100)} full`,
        detail: `${fmtBytes(h.diskUsed)} of ${fmtBytes(h.diskTotal)} on /`,
        href: `/hosts/${host}?metric=disk`,
      });
    }
  }
  for (const svc of ctx.input.manifest.services) {
    const s = ctx.summary(svc);
    const href = `/services/${encodeURIComponent(svc.id)}`;
    if (s.state === "stopped") {
      out.push({ tone: "", tag: "Off", title: `${svc.name} is switched off`, detail: "The next deploy of its role starts it again.", href });
    } else if (s.state === "absent") {
      out.push({ tone: "", tag: "Missing", title: `${svc.name} has no container`, detail: `None of ${svc.containers.join(", ")} exists on ${svc.host}.`, href });
    }
  }
  return out;
}

function buildingNow(input: ViewInput): BuildingNowVM {
  const jc = new JenkinsCtx(input, input.jenkins);
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  return {
    status: jc.status,
    rows: jc.recent().filter((b) => b.building).map((b) => jc.row(b, tz)),
    queued: jc.data?.queue.length ?? 0,
  };
}

export function buildOverview(input: ViewInput): OverviewVM {
  const ctx = new Ctx(input);
  const vpsWeb = input.manifest.services.filter((s) => s.host === DOCKER_HOST && s.hostname);
  const suffix = commonSuffix(vpsWeb.map((s) => s.hostname!));
  const traefikSvc = input.manifest.services.find((s) => s.host === DOCKER_HOST && s.role === "traefik");
  const traefikContainer = traefikSvc ? ctx.docker?.get(traefikSvc.containers[0]!) : undefined;
  const version = traefikContainer ? imageTag(traefikContainer.image) : null;
  const resolvers = new Set<string>();
  for (const s of vpsWeb) for (const r of ctx.routers(s)) if (r.certresolver) resolvers.add(r.certresolver);
  return {
    traefik: {
      label: version ? `Traefik ${version}` : "Traefik",
      tls: resolvers.size ? `TLS via ${[...resolvers].sort().join(", ")}` : null,
    },
    path: vpsWeb.map((s) => ({
      id: s.id,
      name: s.name,
      hostname: s.hostname!,
      short: shortHostname(s.hostname!, suffix),
      state: ctx.summary(s).state,
    })),
    hosts: HOSTS.map((h) => ctx.hostCard(h)),
    treemap: treemap(ctx, DOCKER_HOST, "mem", true),
    attention: attention(ctx),
    up: ctx.up(),
    building: buildingNow(input),
    sources: { prom: ctx.promStatus(), docker: ctx.status.docker },
  };
}

export function parseHost(v: string | undefined): ServiceHost {
  return HOSTS.find((h) => h === v) ?? DOCKER_HOST;
}

export function parseMetric(v: string | undefined): UsageMetric {
  return USAGE_METRICS.find((m) => m.id === v)?.id ?? "mem";
}

export function buildHosts(input: ViewInput, query: { host?: string; metric?: string } = {}): HostsVM {
  const ctx = new Ctx(input);
  const host = parseHost(query.host);
  const metric = parseMetric(query.metric);
  const series = input.sources.series?.data?.find((s) => s.host === host) ?? null;
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  const endMs = series ? (series.startSec + series.stepSec * (series.cpu.length - 1)) * 1000 : null;
  const since =
    series && series.dataStartSec !== null && series.dataStartSec > series.startSec
      ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(
          new Date(series.dataStartSec * 1000),
        )
      : null;
  return {
    host,
    hosts: HOSTS,
    metric,
    card: ctx.hostCard(host),
    charts: {
      series,
      stepSec: series?.stepSec ?? null,
      xLabels: endMs !== null ? hourLabels(endMs, endMs - series!.startSec * 1000, 5, tz) : [],
      timeZone: tz,
      dataSince: since,
      status: ctx.status.series,
    },
    treemap: treemap(ctx, host, metric, false),
    up: ctx.up(),
  };
}

export function buildServices(input: ViewInput): ServicesVM {
  const ctx = new Ctx(input);
  return {
    rows: input.manifest.services.map((s) => ctx.summary(s)),
    up: ctx.up(),
    sources: { prom: ctx.promStatus(), docker: ctx.status.docker },
  };
}

export function serviceTabs(svc: Service): { id: ServiceTab; label: string }[] {
  const tabs: { id: ServiceTab; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "config", label: "Configuration" },
    { id: "auth", label: "Auth" },
    { id: "builds", label: "Builds" },
  ];
  if (svc.db.length) tabs.push({ id: "db", label: "Database" });
  return tabs;
}

export function buildService(input: ViewInput, id: string, tab?: string, flash: Flash | null = null): ServiceVM | null {
  const svc = input.manifest.services.find((s) => s.id === id);
  if (!svc) return null;
  const ctx = new Ctx(input);
  const tabs = serviceTabs(svc);
  return {
    service: svc,
    summary: ctx.summary(svc),
    tab: tabs.find((t) => t.id === tab)?.id ?? "summary",
    tabs,
    containers: ctx.containerRows(svc),
    routers: ctx.routers(svc),
    labels: ctx.labels(svc),
    hostMemTotal: ctx.hostMetrics.get(svc.host)?.memTotal ?? null,
    revision: ctx.containerRows(svc).find((r) => r.found && r.revision)?.revision ?? null,
    tlsDaysLeft: null,
    up: ctx.up(),
    sources: { prom: ctx.promStatus(), docker: ctx.status.docker, df: ctx.status.df },
    builds: tab === "builds" ? buildServiceBuilds(input, svc) : null,
    logsHref: logsHref(svc.host, svc.containers[0]!),
    actions: buildServiceActions(input, svc, ctx.containerRows(svc), flash, hasData(ctx.status.docker)),
    auth: tab === "auth" ? buildAuthTab(input, svc, ctx.summary(svc).protection.label) : null,
    databases: tab === "db" ? buildServiceDatabases(input, svc) : null,
  };
}

export const upOf = (input: ViewInput): UpVM => new Ctx(input).up();

export interface JenkinsBuildData {
  job: string;
  number: number;
  result: string | null;
  building: boolean;
  timestamp: number;
  duration: number;
  estimatedDuration: number | null;
  cause: string | null;
}

export interface JenkinsQueueData {
  id: number;
  job: string;
  why: string | null;
  since: number | null;
}

export interface JenkinsData {
  jobs: string[];
  builds: JenkinsBuildData[];
  queue: JenkinsQueueData[];
  executors: { busy: number; total: number } | null;
  parameterized?: string[];
}

export interface JenkinsView {
  snapshot: Snapshot<JenkinsData> | null;
  baseUrl: string | null;
  actions: boolean;
  ttlMs: number;
  now?: number;
  noRun?: readonly string[];
}

export interface LogContainer {
  host: string;
  container: string;
}

export interface LogsView {
  configured: boolean;
  snapshot: Snapshot<LogContainer[]> | null;
  ttlMs: number;
}

export const HISTORY_LIMIT = 10;
export const HISTORY_ALL_LIMIT = 50;
export const SERVICE_BUILDS_LIMIT = 10;
export const PROGRESS_CAP_PCT = 99;
export const LOG_LINE_CAP = 1000;
export const LOG_PAUSE_CAP = 5000;
export const LOG_UNSHIPPED_CONTAINERS: readonly string[] = ["cadvisor", "alloy", "blackbox-exporter", "process-exporter", "tempo", "promtail"];
export const LOGS_STREAM_PATH = "/logs/stream";

export type ChipTone = "ok" | "warn" | "bad" | "info" | "";

export interface ResultChip {
  label: string;
  tone: ChipTone;
  title: string | null;
}

export interface ActionVM {
  label: string;
  action: string;
  csrf: string;
  title: string;
  body: string;
  request: string;
  ok: string;
  danger: boolean;
}

export interface BuildRowVM {
  job: string;
  number: number;
  result: ResultChip;
  running: boolean;
  progressPct: number | null;
  startedText: string;
  startedTitle: string;
  tookText: string;
  cause: string | null;
  consoleHref: string;
  jenkinsHref: string | null;
  serviceId: string | null;
  serviceName: string | null;
  stop: ActionVM | null;
}

export interface QueueRowVM {
  job: string;
  why: string;
  waitedText: string | null;
}

export interface JobRowVM {
  name: string;
  serviceId: string | null;
  serviceName: string | null;
  running: number;
  queued: number;
  last: BuildRowVM | null;
  run: ActionVM | null;
  jenkinsHref: string | null;
}

export interface ConsoleVM {
  job: string;
  number: number;
  src: string;
  running: boolean;
  result: ResultChip | null;
  jenkinsHref: string | null;
}

export interface Flash {
  ok: boolean;
  text: string;
}

export interface JobsVM {
  status: SourceStatus;
  host: string | null;
  executors: { busy: number; total: number | null };
  running: BuildRowVM[];
  queue: QueueRowVM[];
  history: BuildRowVM[];
  historyMore: string | null;
  jobs: JobRowVM[];
  missing: string[];
  actionsEnabled: boolean;
  console: ConsoleVM | null;
  consoleNote: string | null;
  flash: Flash | null;
  up: UpVM;
}

export interface ServiceBuildsVM {
  job: string | null;
  status: SourceStatus;
  inJenkins: boolean;
  rows: BuildRowVM[];
  run: ActionVM | null;
  queued: number;
  allHref: string | null;
  jenkinsHref: string | null;
}

export interface LogGroupVM {
  host: string;
  containers: string[];
}

export interface LogsVM {
  configured: boolean;
  status: SourceStatus | null;
  listing: "loki" | "manifest";
  groups: LogGroupVM[];
  total: number;
  selected: string;
  selectedKnown: boolean;
  streamPath: string;
  lineCap: number;
  pauseCap: number;
  timeZone: string;
  up: UpVM;
}

const enc = encodeURIComponent;

export const jobsHref = (job?: string | null, build?: number | null) =>
  job ? `/jobs?job=${enc(job)}${build ? `&build=${build}` : ""}` : "/jobs";

export const logsHref = (host: string, container: string) => `/logs?host=${enc(host)}&container=${enc(container)}`;

export const logChoice = (host: string, container: string) => `${host}/${container}`;

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function fmtSince(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function resultChip(b: Pick<JenkinsBuildData, "result" | "building">): ResultChip {
  if (b.building) return { label: "Running", tone: "info", title: null };
  switch (b.result) {
    case "SUCCESS":
      return { label: "Passed", tone: "ok", title: null };
    case "FAILURE":
      return { label: "Failed", tone: "bad", title: null };
    case "UNSTABLE":
      return { label: "Unstable", tone: "warn", title: null };
    case "ABORTED":
      return { label: "Stopped", tone: "", title: "Aborted before it finished" };
    case "NOT_BUILT":
      return { label: "Not built", tone: "", title: null };
    case null:
      return { label: "Unknown", tone: "", title: "Jenkins reports no result" };
    default:
      return { label: "Unknown", tone: "", title: `Jenkins result: ${b.result}` };
  }
}

class JenkinsCtx {
  readonly now: number;
  readonly base: string | null;
  readonly host: string | null;
  readonly status: SourceStatus;
  readonly data: JenkinsData | undefined;
  readonly services: Map<string, Service[]>;
  readonly parameterized: ReadonlySet<string>;
  readonly noRun: ReadonlySet<string>;

  constructor(
    private input: ViewInput,
    private jv: JenkinsView | undefined,
  ) {
    this.now = jv?.now ?? Date.now();
    this.base = jv?.baseUrl ? jv.baseUrl.replace(/\/+$/, "") : null;
    this.host = this.base ? safeHost(this.base) : null;
    this.status = snapshotStatus("jenkins", "Jenkins", jv?.ttlMs ?? 5000, jv?.snapshot ?? null);
    this.data = jv?.snapshot?.data;
    this.parameterized = new Set(this.data?.parameterized ?? []);
    this.noRun = new Set(jv?.noRun ?? []);
    this.services = new Map();
    for (const s of input.manifest.services) {
      if (!s.jenkins_job) continue;
      this.services.set(s.jenkins_job, [...(this.services.get(s.jenkins_job) ?? []), s]);
    }
  }

  get csrf(): string {
    return this.input.csrf ?? "";
  }

  get actionsEnabled(): boolean {
    return Boolean(this.jv?.actions && this.base && this.status.state !== "off");
  }

  owner(job: string): Service | null {
    const list = this.services.get(job);
    return list && list.length === 1 ? list[0]! : null;
  }

  jobHref(job: string): string | null {
    return this.base ? `${this.base}/job/${enc(job)}/` : null;
  }

  buildHref(job: string, n: number): string | null {
    return this.base ? `${this.base}/job/${enc(job)}/${n}/` : null;
  }

  request(path: string): string {
    return `POST ${path}${this.host ? `\nHost: ${this.host}` : ""}`;
  }

  runAction(job: string, running: number): ActionVM | null {
    if (!this.actionsEnabled || this.noRun.has(job)) return null;
    const busy = running > 0 ? ` ${running === 1 ? "A run is" : `${running} runs are`} already in progress.` : "";
    return {
      label: "Run now",
      action: `/jobs/${enc(job)}/build`,
      csrf: this.csrf,
      title: `Run ${job}?`,
      body: `Jenkins queues a new run of ${job} with its default parameters.${busy}`,
      request: this.request(`/job/${enc(job)}/${this.parameterized.has(job) ? "buildWithParameters" : "build"}`),
      ok: "Run job",
      danger: false,
    };
  }

  stopAction(job: string, n: number): ActionVM | null {
    if (!this.actionsEnabled) return null;
    return {
      label: "Stop",
      action: `/jobs/${enc(job)}/${n}/stop`,
      csrf: this.csrf,
      title: `Stop ${job} #${n}?`,
      body: "The build ends immediately and is marked aborted.",
      request: this.request(`/job/${enc(job)}/${n}/stop`),
      ok: "Stop build",
      danger: true,
    };
  }

  row(b: JenkinsBuildData, tz: string): BuildRowVM {
    const owner = this.owner(b.job);
    const elapsed = Math.max(0, this.now - b.timestamp);
    const est = b.estimatedDuration;
    const progress =
      b.building && est !== null && est > 0 ? Math.min(PROGRESS_CAP_PCT, Math.max(0, Math.round((elapsed / est) * 100))) : null;
    return {
      job: b.job,
      number: b.number,
      result: resultChip(b),
      running: b.building,
      progressPct: progress,
      startedText: fmtSince(elapsed),
      startedTitle: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23", timeZone: tz }).format(
        new Date(b.timestamp),
      ),
      tookText: fmtDuration(b.building ? elapsed : b.duration),
      cause: b.cause,
      consoleHref: jobsHref(b.job, b.number),
      jenkinsHref: this.buildHref(b.job, b.number),
      serviceId: owner?.id ?? null,
      serviceName: owner?.name ?? null,
      stop: b.building ? this.stopAction(b.job, b.number) : null,
    };
  }

  recent(job?: string): JenkinsBuildData[] {
    const all = (this.data?.builds ?? []).filter((b) => job === undefined || b.job === job);
    return [...all].sort((a, b) => b.timestamp - a.timestamp);
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

const parseBuildNumber = (v: string | undefined): number | null => (v !== undefined && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null);

export function buildJobs(input: ViewInput, query: { job?: string; build?: string; flash?: Flash | null; all?: boolean } = {}): JobsVM {
  const ctx = new JenkinsCtx(input, input.jenkins);
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  const data = ctx.data;
  const recent = ctx.recent();
  const rows = recent.map((b) => ctx.row(b, tz));
  const running = rows.filter((r) => r.running);
  const finished = rows.filter((r) => !r.running);
  const moreHref = `/jobs?history=all${query.job ? `&job=${enc(query.job)}` : ""}${query.build ? `&build=${enc(query.build)}` : ""}`;
  const queue: QueueRowVM[] = (data?.queue ?? []).map((q) => ({
    job: q.job,
    why: q.why ?? "Waiting",
    waitedText: q.since !== null ? fmtDuration(ctx.now - q.since) : null,
  }));
  const names = data ? [...data.jobs].sort() : [];
  const known = new Set(names);
  const missing = data ? [...ctx.services.keys()].filter((j) => !known.has(j)).sort() : [];
  const jobs: JobRowVM[] = names.map((name) => {
    const runs = running.filter((r) => r.job === name).length;
    return {
      name,
      serviceId: ctx.owner(name)?.id ?? null,
      serviceName: ctx.owner(name)?.name ?? null,
      running: runs,
      queued: queue.filter((q) => q.job === name).length,
      last: rows.find((r) => r.job === name && !r.running) ?? null,
      run: ctx.runAction(name, runs),
      jenkinsHref: ctx.jobHref(name),
    };
  });
  const wantedBuild = parseBuildNumber(query.build);
  let consoleVm: ConsoleVM | null = null;
  let consoleNote: string | null = null;
  if (query.job) {
    if (!data) consoleNote = "Jenkins has not answered yet, so the console cannot be opened.";
    else if (!known.has(query.job)) consoleNote = `Jenkins has no job called ${query.job}.`;
    else if (wantedBuild === null) consoleNote = "Pick a run from the lists to read its console.";
    else {
      const b = recent.find((x) => x.job === query.job && x.number === wantedBuild);
      consoleVm = {
        job: query.job,
        number: wantedBuild,
        src: `/jobs/${enc(query.job)}/${wantedBuild}/console`,
        running: b?.building ?? false,
        result: b ? resultChip(b) : null,
        jenkinsHref: ctx.buildHref(query.job, wantedBuild),
      };
    }
  }
  const ui = new Ctx(input);
  return {
    status: ctx.status,
    host: ctx.host,
    executors: data?.executors ?? { busy: running.length, total: null },
    running,
    queue,
    history: finished.slice(0, query.all ? HISTORY_ALL_LIMIT : HISTORY_LIMIT),
    historyMore: query.all ? null : finished.length > HISTORY_LIMIT ? moreHref : null,
    jobs,
    missing,
    actionsEnabled: ctx.actionsEnabled,
    console: consoleVm,
    consoleNote,
    flash: query.flash ?? null,
    up: ui.up(),
  };
}

export function buildServiceBuilds(input: ViewInput, svc: Service): ServiceBuildsVM {
  const ctx = new JenkinsCtx(input, input.jenkins);
  const job = svc.jenkins_job;
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  const inJenkins = job !== null && ctx.data !== undefined && ctx.data.jobs.includes(job);
  const rows = job ? ctx.recent(job).map((b) => ctx.row(b, tz)) : [];
  const running = rows.filter((r) => r.running).length;
  return {
    job,
    status: ctx.status,
    inJenkins,
    rows: rows.slice(0, SERVICE_BUILDS_LIMIT),
    run: job && inJenkins ? ctx.runAction(job, running) : null,
    queued: job ? (ctx.data?.queue ?? []).filter((q) => q.job === job).length : 0,
    allHref: job ? jobsHref(job) : null,
    jenkinsHref: job ? ctx.jobHref(job) : null,
  };
}

export function buildLogs(input: ViewInput, query: { host?: string; container?: string } = {}): LogsVM {
  const lv = input.logs;
  const fromLoki = lv?.snapshot?.data;
  const byHost = new Map<string, Set<string>>();
  const add = (host: string, container: string) => {
    if (!byHost.has(host)) byHost.set(host, new Set());
    byHost.get(host)!.add(container);
  };
  if (fromLoki) {
    for (const c of fromLoki) add(c.host, c.container);
  } else {
    for (const s of input.manifest.services) {
      for (const c of s.containers) if (!LOG_UNSHIPPED_CONTAINERS.includes(c)) add(s.host, c);
    }
  }
  const order = [...HOSTS, ...[...byHost.keys()].filter((h) => !HOSTS.includes(h as ServiceHost)).sort()];
  const groups = order
    .filter((h) => byHost.has(h))
    .map((host) => ({ host, containers: [...byHost.get(host)!].sort() }));
  const total = groups.reduce((n, g) => n + g.containers.length, 0);
  let selected = "all";
  let known = true;
  if (query.container) {
    const host = query.host ?? groups.find((g) => g.containers.includes(query.container!))?.host;
    const hit = host !== undefined && byHost.get(host)?.has(query.container);
    if (hit) selected = logChoice(host!, query.container);
    else known = false;
  }
  return {
    configured: lv?.configured ?? false,
    status: lv?.configured && lv.snapshot ? snapshotStatus("loki", "Loki", lv.ttlMs, lv.snapshot) : null,
    listing: fromLoki ? "loki" : "manifest",
    groups,
    total,
    selected,
    selectedKnown: known,
    streamPath: LOGS_STREAM_PATH,
    lineCap: LOG_LINE_CAP,
    pauseCap: LOG_PAUSE_CAP,
    timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
    up: new Ctx(input).up(),
  };
}
