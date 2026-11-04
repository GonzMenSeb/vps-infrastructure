import type { DockerContainer } from "../collectors/docker";
import type { PostgresMetrics, RedisMetrics } from "../collectors/databases";
import type { PdnsStats } from "../collectors/pdns";
import type { Service } from "../manifest";
import {
  DOCKER_HOST,
  bytesParts,
  fmtBytes,
  fmtNum,
  fmtUptime,
  imageTag,
  snapshotStatus,
  sourceStatus,
  upOf,
  type ChipTone,
  type SourceStatus,
  type UpVM,
  type ViewInput,
} from "./model";
import type { DatabasesView } from "./phase4-input";

export const CONN_WARN_RATIO = 0.8;
export const MEM_WARN_RATIO = 0.9;
const NA = "—";

export interface DbMetricVM {
  label: string;
  value: string;
  unit: string;
  sub: string | null;
  title: string | null;
}

export interface DbHealthVM {
  label: string;
  tone: ChipTone;
  detail: string | null;
}

export interface DbCardVM {
  container: string;
  serviceId: string;
  serviceName: string;
  kind: "postgres" | "redis" | "mariadb";
  engine: string;
  health: DbHealthVM;
  source: "prometheus" | "powerdns" | "none";
  sourceStatus: SourceStatus | null;
  note: string | null;
  metrics: DbMetricVM[];
}

export interface DatabasesVM {
  cards: DbCardVM[];
  docker: SourceStatus;
  up: UpVM;
}

export interface ServiceDatabasesVM {
  cards: DbCardVM[];
  docker: SourceStatus;
}

const KIND_LABEL = { postgres: "Postgres", redis: "Redis", mariadb: "MariaDB" } as const;

const metric = (label: string, value: string | null, unit = "", sub: string | null = null, title: string | null = null): DbMetricVM => ({
  label,
  value: value ?? NA,
  unit: value === null ? "" : unit,
  sub,
  title,
});

function containerHealth(c: DockerContainer | undefined, service: Service, docker: SourceStatus): DbHealthVM | null {
  if (service.host !== DOCKER_HOST) return { label: "Not visible", tone: "", detail: `The panel cannot read Docker on the ${service.host} host.` };
  if (docker.state !== "fresh" && docker.state !== "stale") return null;
  if (!c) return { label: "Missing", tone: "", detail: "No container with this name exists on the host." };
  if (c.state === "restarting" || c.state === "dead") return { label: c.state === "dead" ? "Dead" : "Restarting", tone: "bad", detail: c.status };
  if (c.health === "unhealthy") return { label: "Unhealthy", tone: "bad", detail: c.status };
  if (c.state !== "running") return { label: c.state ? c.state[0]!.toUpperCase() + c.state.slice(1) : "Stopped", tone: "", detail: c.status };
  if (c.health === "starting") return { label: "Starting", tone: "warn", detail: c.status };
  return { label: c.health === "healthy" ? "Up · healthy" : "Up", tone: "ok", detail: c.status };
}

const containerBlocks = (h: DbHealthVM | null): h is DbHealthVM => h !== null && (h.tone === "bad" || h.label === "Stopped" || h.label === "Exited" || h.label === "Missing" || h.label === "Created" || h.label === "Paused");

function postgresCard(m: PostgresMetrics | undefined): { health: DbHealthVM | null; metrics: DbMetricVM[]; version: string | null } {
  if (!m) return { health: null, metrics: [], version: null };
  const ratio = m.connections !== null && m.maxConnections ? m.connections / m.maxConnections : null;
  const [size, sizeUnit] = m.sizeBytes === null ? [null, ""] : bytesParts(m.sizeBytes);
  const metrics = [
    metric("Size", size ?? null, sizeUnit, "all databases except templates"),
    metric("Connections", m.connections === null ? null : fmtNum(m.connections), "", m.maxConnections ? `of ${fmtNum(m.maxConnections)}` : null),
    metric("Cache hit", m.cacheHitPct === null ? null : m.cacheHitPct.toFixed(1), "%", "last 5 min"),
    metric("Transactions", m.tps === null ? null : fmtNum(m.tps), "/s", "last 5 min"),
  ];
  let health: DbHealthVM;
  if (m.scrapeUp === false) {
    health = { label: "No metrics", tone: "warn", detail: "Prometheus cannot scrape the Postgres exporter, so the numbers are missing or old." };
  } else if (m.pgUp === false) {
    health = { label: "Not answering", tone: "bad", detail: "The exporter is up but cannot connect to Postgres." };
  } else if (ratio !== null && ratio >= CONN_WARN_RATIO) {
    health = { label: "Near connection limit", tone: "warn", detail: `${fmtNum(m.connections!)} of ${fmtNum(m.maxConnections!)} connections in use.` };
  } else if (m.pgUp === true) {
    health = { label: "Healthy", tone: "ok", detail: null };
  } else {
    health = { label: "Unknown", tone: "", detail: "The exporter reports no pg_up value." };
  }
  return { health, metrics, version: m.version };
}

function redisCard(m: RedisMetrics | undefined): { health: DbHealthVM | null; metrics: DbMetricVM[]; version: string | null } {
  if (!m) return { health: null, metrics: [], version: null };
  const ratio = m.memUsedBytes !== null && m.memMaxBytes ? m.memUsedBytes / m.memMaxBytes : null;
  const [mem, memUnit] = m.memUsedBytes === null ? [null, ""] : bytesParts(m.memUsedBytes);
  const metrics = [
    metric("Memory", mem ?? null, memUnit, m.memMaxBytes ? `of ${fmtBytes(m.memMaxBytes)}` : m.memUsedBytes === null ? null : "no limit set"),
    metric("Keys", m.keys === null ? null : fmtNum(m.keys)),
    metric("Clients", m.clients === null ? null : fmtNum(m.clients)),
    metric("Uptime", m.uptimeSec === null ? null : fmtUptime(m.uptimeSec)),
  ];
  let health: DbHealthVM;
  if (m.scrapeUp === false) {
    health = { label: "No metrics", tone: "warn", detail: "Prometheus cannot scrape the Redis exporter, so the numbers are missing or old." };
  } else if (m.redisUp === false) {
    health = { label: "Not answering", tone: "bad", detail: "The exporter is up but cannot connect to Redis." };
  } else if (ratio !== null && ratio >= MEM_WARN_RATIO) {
    health = { label: "Near memory limit", tone: "warn", detail: `${fmtBytes(m.memUsedBytes!)} of ${fmtBytes(m.memMaxBytes!)} in use.` };
  } else if (m.redisUp === true) {
    health = { label: "Healthy", tone: "ok", detail: null };
  } else {
    health = { label: "Unknown", tone: "", detail: "The exporter reports no redis_up value." };
  }
  return { health, metrics, version: m.version };
}

function pdnsCard(s: PdnsStats, zones: { zones: number; rrsets: number } | null): { health: DbHealthVM; metrics: DbMetricVM[] } {
  const metrics = [
    metric("Backend queries", s.backendQueries === null ? null : fmtNum(s.backendQueries), "", "since PowerDNS started"),
    metric("Backend latency", s.backendLatencyUs === null ? null : fmtNum(s.backendLatencyUs), "µs", "moving average", "Average time of a PowerDNS lookup in its database"),
    metric("SERVFAIL answers", s.servfailPackets === null ? null : fmtNum(s.servfailPackets), "", "since PowerDNS started"),
    metric("PowerDNS uptime", s.uptimeSec === null ? null : fmtUptime(s.uptimeSec)),
  ];
  if (zones) metrics.push(metric("Zones · record sets", `${fmtNum(zones.zones)} · ${fmtNum(zones.rrsets)}`));
  const health: DbHealthVM =
    s.servfailPackets !== null && s.servfailPackets > 0
      ? { label: "SERVFAIL seen", tone: "warn", detail: `PowerDNS has sent ${fmtNum(s.servfailPackets)} SERVFAIL answers since it started; these usually mean it could not read its database.` }
      : { label: "Answering", tone: "ok", detail: "PowerDNS answers queries from this database." };
  return { health, metrics };
}

export function buildCards(input: ViewInput, services: readonly Service[]): { cards: DbCardVM[]; docker: SourceStatus } {
  const view: DatabasesView | undefined = input.databases;
  const dockerSnap = input.sources.docker;
  const docker = sourceStatus("docker", dockerSnap);
  const containers = new Map<string, DockerContainer>((dockerSnap?.data ?? []).map((c) => [c.name, c]));
  const promStatus = snapshotStatus("databases", "Prometheus", view?.promTtlMs ?? 15_000, view?.prom ?? null);
  const pdnsStatus = snapshotStatus("pdns", "PowerDNS", view?.pdnsTtlMs ?? 30_000, view?.pdnsStats ?? null);
  const zonesData = view?.zones?.data;
  const zoneCounts = zonesData ? { zones: zonesData.zones.length, rrsets: zonesData.zones.reduce((n, z) => n + z.rrsets.length, 0) } : null;
  const cards: DbCardVM[] = [];
  for (const svc of services) {
    for (const d of svc.db) {
      const same = svc.db.filter((x) => x.kind === d.kind).length;
      const c = containers.get(d.container);
      const base = { container: d.container, serviceId: svc.id, serviceName: svc.name, kind: d.kind };
      const tag = c?.image ? imageTag(c.image) : null;
      const fallback = containerHealth(c, svc, docker);
      let engine: string = KIND_LABEL[d.kind];
      let health: DbHealthVM | null = null;
      let metrics: DbMetricVM[] = [];
      let source: DbCardVM["source"] = "none";
      let status: SourceStatus | null = null;
      let note: string | null = null;
      let version: string | null = null;
      if (d.kind === "mariadb") {
        if (view?.pdnsConfigured && d.container === view.pdnsDbContainer) {
          source = "powerdns";
          status = pdnsStatus;
          const stats = view.pdnsStats?.data;
          if (stats) {
            const p = pdnsCard(stats, zoneCounts);
            health = p.health;
            metrics = p.metrics;
          }
          note = "MariaDB has no exporter. These counters come from PowerDNS's own statistics, not from MariaDB.";
        } else {
          note = "MariaDB has no exporter and the PowerDNS API is not connected, so only the container state is shown.";
        }
      } else if (same > 1) {
        note = `${svc.name} has several ${KIND_LABEL[d.kind]} databases, so exporter series cannot be matched to one container.`;
      } else {
        source = "prometheus";
        status = promStatus;
        const data = view?.prom?.data;
        const hit = d.kind === "postgres" ? postgresCard(data?.postgres[svc.id]) : redisCard(data?.redis[svc.id]);
        health = hit.health;
        metrics = hit.metrics;
        version = hit.version;
        if (!hit.health) {
          source = "none";
          note =
            promStatus.state === "off"
              ? "Prometheus is not configured, so only the container state is shown."
              : data
                ? `No ${KIND_LABEL[d.kind]} exporter reports for ${svc.name}, so only the container state is shown.`
                : "Waiting for Prometheus; only the container state is shown meanwhile.";
        }
      }
      const detail = version ?? tag;
      engine = detail ? `${KIND_LABEL[d.kind]} ${detail}` : KIND_LABEL[d.kind];
      const merged = containerBlocks(fallback) ? fallback : (health ?? fallback ?? { label: "Unknown", tone: "" as ChipTone, detail: "Docker has not answered yet." });
      cards.push({ ...base, engine, health: merged, source, sourceStatus: status, note, metrics });
    }
  }
  return { cards, docker };
}

export function buildDatabases(input: ViewInput): DatabasesVM {
  const { cards, docker } = buildCards(input, input.manifest.services);
  return { cards, docker, up: upOf(input) };
}

export function buildServiceDatabases(input: ViewInput, svc: Service): ServiceDatabasesVM {
  return buildCards(input, [svc]);
}
