import type { DiskUsage, DockerContainer } from "../src/collectors/docker";
import type { ContainerMetrics, HostMetrics, HostSeries } from "../src/collectors/prometheus";
import { parseManifest, type Manifest } from "../src/manifest";
import type { Snapshot } from "../src/store";
import type { Sources, ViewInput } from "../src/views/model";

export const SECRET_HASH = "admin:$apr1$fixture$notarealhash";
export const SECRET_TOKEN = "fixture-push-token-not-real";

const svc = (o: Record<string, unknown>) => ({
  tags: [o.id],
  playbook: "playbook.yml",
  host: "vps",
  dir: `/opt/${o.id}`,
  images: [],
  hostname: null,
  jenkins_job: "vps-deploy",
  db: [],
  core: false,
  auth: { kind: "none", vault_vars: [], env_keys: [] },
  role: o.id,
  ...o,
});

export const manifest: Manifest = parseManifest({
  services: [
    svc({
      id: "traefik", name: "Traefik", containers: ["traefik", "docker-proxy"], images: ["traefik:v3.6.13", "nginx:alpine"],
      hostname: "traefik.web.example.test", core: true, auth: { kind: "basic-auth-hash", vault_vars: [], env_keys: [] },
    }),
    svc({
      id: "miplata", name: "Miplata", containers: ["miplata-api", "miplata-postgres"], images: ["zot.web.example.test/miplata/api:latest"],
      hostname: "miplata.web.example.test", jenkins_job: "miplata-deploy", db: [{ kind: "postgres", container: "miplata-postgres" }],
      auth: { kind: "env", vault_vars: ["vault_miplata_db_password"], env_keys: ["POSTGRES_PASSWORD"] },
    }),
    svc({
      id: "judicabot", name: "Judicabot", containers: ["judicabot"], images: ["zot.web.example.test/judicabot/judicabot:latest"],
      hostname: "judicabot.web.example.test", jenkins_job: "judicabot-deploy",
      auth: { kind: "env", vault_vars: ["vault_judicabot_password"], env_keys: ["JUDICABOT_PASSWORD"] },
    }),
    svc({ id: "monitoring", name: "Monitoring", containers: ["prometheus", "grafana"], hostname: "grafana.web.example.test" }),
    svc({ id: "llm_inference", name: "LLM inference", containers: ["llama-server"] }),
    svc({ id: "huella", name: "Huella", containers: ["huella"], hostname: "huella.web.example.test" }),
    svc({
      id: "jenkins", name: "Jenkins", tags: [], playbook: "jenkins-playbook.yml", host: "jenkins", containers: ["jenkins"],
      images: ["jenkins-ansible:latest"], hostname: "jenkins.web.example.test", jenkins_job: null, core: true,
      auth: { kind: "vault", vault_vars: ["vault_jenkins_admin_password"], env_keys: [] },
    }),
  ],
});

const dc = (o: Partial<DockerContainer> & { name: string }): DockerContainer => ({
  id: `id-${o.name}`,
  image: `${o.name}:1`,
  imageId: "sha256:0123456789abcdef0123456789abcdef",
  state: "running",
  status: "Up 7 hours",
  health: "none",
  composeProject: null,
  composeService: null,
  revision: null,
  traefik: {},
  volumes: [],
  ...o,
});

export const docker: DockerContainer[] = [
  dc({
    name: "traefik", image: "traefik:v3.6.13",
    traefik: {
      "traefik.enable": "true",
      "traefik.http.routers.dashboard.rule": "Host(`traefik.web.example.test`)",
      "traefik.http.routers.dashboard.entrypoints": "websecure",
      "traefik.http.routers.dashboard.tls.certresolver": "letsencrypt",
      "traefik.http.routers.dashboard.middlewares": "dashboard-auth",
      "traefik.http.routers.dashboard.service": "api@internal",
      "traefik.http.middlewares.dashboard-auth.basicauth.users": SECRET_HASH,
    },
  }),
  dc({ name: "docker-proxy", image: "nginx:alpine" }),
  dc({
    name: "judicabot", image: "zot.web.example.test/judicabot/judicabot:latest", status: "Up 45 minutes (healthy)", health: "healthy",
    traefik: {
      "traefik.enable": "true",
      "traefik.http.routers.judicabot.rule": "Host(`judicabot.web.example.test`)",
      "traefik.http.routers.judicabot.entrypoints": "websecure",
      "traefik.http.routers.judicabot.tls.certresolver": "letsencrypt",
      "traefik.http.services.judicabot.loadbalancer.server.port": "8000",
    },
  }),
  dc({
    name: "prometheus", image: "prom/prometheus:v3.11.2",
    traefik: {
      "traefik.http.routers.promwrite.rule": "Host(`prom-push.web.example.test`)",
      "traefik.http.routers.promwrite.middlewares": "obs-bearer",
      "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.tokens[0]": SECRET_TOKEN,
      "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.bearerHeaderName": "Authorization",
    },
  }),
  dc({ name: "grafana", image: "grafana/grafana:12.4.3", state: "exited", status: "Exited (1) 2 hours ago" }),
  dc({ name: "llama-server", image: "ghcr.io/ggml-org/llama.cpp:server", state: "restarting", status: "Restarting (1) 36 seconds ago" }),
  dc({ name: "huella", image: "zot.web.example.test/coros/huella:latest", state: "exited", status: "Exited (0) 3 days ago" }),
  dc({ name: "stray", image: "busybox:1" }),
];

const cm = (host: string, name: string, memBytes: number | null, cpuPct: number | null, rxBps = 1000, txBps = 500): ContainerMetrics => ({
  host, name, memBytes, cpuPct, rxBps, txBps,
});

export const containers: ContainerMetrics[] = [
  cm("vps", "traefik", 40e6, 1.2, 90_000, 80_000),
  cm("vps", "docker-proxy", 7e6, 0.1),
  cm("vps", "judicabot", 47e6, 0.4),
  cm("vps", "prometheus", 195e6, 3.1),
  cm("vps", "stray", 10e6, 0.2),
  cm("jenkins", "jenkins", 818e6, 5),
  cm("jenkins", "alloy", 156e6, 1),
];

const hm = (o: Partial<HostMetrics> & { host: string }): HostMetrics => ({
  cpuPct: 23.4, cores: 4, memTotal: 8e9, memUsed: 3e9, swapTotal: 0, swapUsed: 0, diskTotal: 100e9, diskUsed: 40e9,
  load1: 0.84, load5: 0.71, load15: 0.66, uptimeSec: 3 * 86400 + 4 * 3600 + 60, os: "Ubuntu 24.04.3 LTS",
  rxBps: 2.4e6, txBps: 0.9e6, containers: 19, ...o,
});

export const hosts: HostMetrics[] = [
  hm({ host: "jenkins", cores: null, memTotal: 4e9, memUsed: 2e9, swapTotal: 1e9, swapUsed: 1e8, diskTotal: 50e9, diskUsed: 20e9, containers: 9, uptimeSec: null }),
  hm({ host: "vps", diskUsed: 80e9 }),
];

const line = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
export const SERIES_START = 1_800_000_000 - 24 * 3600;

export const series: HostSeries[] = ["jenkins", "vps"].map((host) => ({
  host, startSec: SERIES_START, stepSec: 288, dataStartSec: host === "vps" ? SERIES_START : SERIES_START + 3600,
  cpu: line(301, (i) => 20 + (i % 7)), mem: line(301, () => 40), rx: line(301, (i) => 1e5 * (1 + (i % 3))),
  tx: line(301, () => 5e4), load: line(301, () => 0.7), containers: line(301, () => (host === "vps" ? 19 : 9)),
}));

export const df: DiskUsage = {
  containers: [
    { name: "judicabot", sizeRw: 2e6, sizeRootFs: null, volumes: [] },
    { name: "prometheus", sizeRw: 1e6, sizeRootFs: null, volumes: ["promdata"] },
    { name: "traefik", sizeRw: 4096, sizeRootFs: null, volumes: ["acme", "shared"] },
    { name: "grafana", sizeRw: 3e6, sizeRootFs: null, volumes: ["shared"] },
  ],
  volumes: [
    { name: "acme", sizeBytes: 12, refCount: 1 },
    { name: "promdata", sizeBytes: 5e9, refCount: 1 },
    { name: "shared", sizeBytes: 2e6, refCount: 2 },
  ],
};

export function snap<T>(data: T | undefined, o: Partial<Snapshot<T>> = {}): Snapshot<T> {
  const fetched = data !== undefined;
  return {
    data,
    fetchedAt: fetched ? 1 : null,
    ageMs: fetched ? 4000 : null,
    stale: false,
    lastError: null,
    lastAttemptAt: 1,
    breaker: "closed",
    hash: fetched ? "fixture" : null,
    cadenceMs: 0,
    ...o,
  };
}

export function fullSources(): Sources {
  return {
    hosts: snap(hosts),
    containers: snap(containers),
    series: snap(series),
    docker: snap(docker),
    df: snap(df),
  };
}

export const input = (sources: Sources = fullSources()): ViewInput => ({ manifest, sources });

export const emptySources = (): Sources => ({
  hosts: snap<HostMetrics[]>(undefined),
  containers: snap<ContainerMetrics[]>(undefined),
  series: snap<HostSeries[]>(undefined),
  docker: snap<DockerContainer[]>(undefined),
  df: snap<DiskUsage>(undefined),
});

export const downSources = (): Sources => {
  const err = { lastError: "prometheus /api/v1/query: HTTP 503", breaker: "open" as const };
  return {
    hosts: snap<HostMetrics[]>(undefined, err),
    containers: snap<ContainerMetrics[]>(undefined, err),
    series: snap<HostSeries[]>(undefined, err),
    docker: snap(docker, { lastError: "docker /containers/json: HTTP 500", ageMs: 90_000 }),
    df: null,
  };
};

export const chrome = { login: "owner", csrf: "csrf-token" };

export async function render(node: unknown): Promise<string> {
  return String(await (node as { toString(): string | Promise<string> }).toString());
}

export function styleAttrs(html: string): string[] {
  return [...html.matchAll(/<([a-z]+)[^>]*\sstyle="([^"]*)"/g)]
    .filter((m) => !(m[1] === "span" && /^--c:var\(--[a-z]+\)$/.test(m[2]!)))
    .map((m) => m[0]);
}
