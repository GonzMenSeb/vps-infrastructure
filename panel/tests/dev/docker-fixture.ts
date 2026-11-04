const D = "web.example.test";
const FAKE_HASH = "admin:$apr1$fixture$notarealhashnotarealhash";
const FAKE_TOKEN = "fixture-push-token-not-real";

interface Spec {
  name: string;
  image: string;
  project: string;
  state?: string;
  status: string;
  labels?: Record<string, string>;
  volumes?: string[];
  sizeRw: number;
}

const router = (r: string, host: string, port?: number, extra: Record<string, string> = {}) => ({
  "traefik.enable": "true",
  "traefik.docker.network": "proxy",
  [`traefik.http.routers.${r}.rule`]: `Host(\`${host}\`)`,
  [`traefik.http.routers.${r}.entrypoints`]: "websecure",
  [`traefik.http.routers.${r}.tls.certresolver`]: "letsencrypt",
  ...(port ? { [`traefik.http.services.${r}.loadbalancer.server.port`]: String(port) } : {}),
  ...extra,
});

const bearer = {
  "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.bearerHeader": "true",
  "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.bearerHeaderName": "Authorization",
  "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.removeHeadersOnSuccess": "false",
  "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.tokens[0]": FAKE_TOKEN,
};

const SPECS: Spec[] = [
  {
    name: "traefik", image: "traefik:v3.6.13", project: "traefik", status: "Up 9 days", sizeRw: 0, volumes: ["traefik_letsencrypt"],
    labels: router("dashboard", `traefik.${D}`, undefined, {
      "traefik.http.routers.dashboard.service": "api@internal",
      "traefik.http.routers.dashboard.middlewares": "dashboard-auth",
      "traefik.http.middlewares.dashboard-auth.basicauth.users": FAKE_HASH,
    }),
  },
  { name: "docker-proxy", image: "nginx:alpine", project: "traefik", status: "Up 9 days", sizeRw: 1_200 },
  { name: "pdns-db", image: "mariadb:10.11", project: "dns", status: "Up 9 days (healthy)", sizeRw: 2_100, volumes: ["dns_pdns_db"] },
  { name: "pdns", image: "powerdns/pdns-auth-49:4.9.13", project: "dns", status: "Up 9 days", sizeRw: 0 },
  { name: "pdns-admin", image: "powerdnsadmin/pda-legacy:0.4.2", project: "dns", status: "Up 9 days", sizeRw: 48_000_000, labels: router("pdns-admin", `dns.${D}`, 80) },
  {
    name: "vaultwarden", image: "vaultwarden/server:1.35.7", project: "vaultwarden", status: "Up 9 days (healthy)", sizeRw: 0,
    volumes: ["vaultwarden_data"], labels: router("vaultwarden", `vault.${D}`, 80),
  },
  {
    name: "prometheus", image: "prom/prometheus:v3.11.2", project: "monitoring", status: "Up 4 days", sizeRw: 0, volumes: ["monitoring_prometheus_data"],
    labels: {
      ...router("promwrite", `prom-push.${D}`, 9090, { "traefik.http.routers.promwrite.middlewares": "obs-bearer@docker", "traefik.http.routers.promwrite.service": "promwrite" }),
      ...router("promui", `prometheus.${D}`, 9090, {
        "traefik.http.routers.promui.middlewares": "prom-ui-auth",
        "traefik.http.routers.promui.service": "promui",
        "traefik.http.middlewares.prom-ui-auth.basicauth.users": FAKE_HASH,
      }),
      ...bearer,
    },
  },
  {
    name: "loki", image: "grafana/loki:3.7.1", project: "monitoring", status: "Up 4 days", sizeRw: 0, volumes: ["monitoring_loki_data"],
    labels: router("lokipush", `loki-push.${D}`, 3100, { "traefik.http.routers.lokipush.middlewares": "obs-bearer@docker" }),
  },
  {
    name: "grafana", image: "grafana/grafana:12.4.3", project: "monitoring", status: "Up 4 days", sizeRw: 0, volumes: ["monitoring_grafana_data"],
    labels: router("grafana", `grafana.${D}`, 3000),
  },
  { name: "alloy", image: "grafana/alloy:v1.15.1", project: "monitoring", status: "Up 4 days", sizeRw: 0, volumes: ["monitoring_alloy_data"] },
  { name: "process-exporter", image: "ncabatoff/process-exporter:0.8.7", project: "monitoring", status: "Up 4 days", sizeRw: 0 },
  { name: "cadvisor", image: "ghcr.io/google/cadvisor:0.56.2", project: "monitoring", status: "Up 4 days (healthy)", sizeRw: 0 },
  { name: "blackbox-exporter", image: "prom/blackbox-exporter:v0.28.0", project: "monitoring", status: "Up 4 days", sizeRw: 0 },
  { name: "tempo", image: "grafana/tempo:2.10.4", project: "monitoring", status: "Up 4 days", sizeRw: 0, volumes: ["monitoring_tempo_data"] },
  { name: "alertmanager", image: "prom/alertmanager:v0.32.0", project: "monitoring", status: "Up 4 days", sizeRw: 0, volumes: ["monitoring_alertmanager_data"] },
  {
    name: "zot", image: "ghcr.io/project-zot/zot-linux-amd64:v2.1.16", project: "zot", status: "Up 9 days", sizeRw: 0, volumes: ["zot_data"],
    labels: router("zot", `zot.${D}`, 5000),
  },
  { name: "metabase-db", image: "postgres:16-alpine", project: "metabase", status: "Up 9 days (healthy)", sizeRw: 63_000, volumes: ["metabase_db"] },
  {
    name: "metabase", image: "metabase/metabase:v0.60.1", project: "metabase", status: "Up 9 days", sizeRw: 310_000_000,
    labels: router("metabase", `metabase.${D}`, 3000),
  },
  {
    name: "judicabot", image: `zot.${D}/judicabot/judicabot:latest`, project: "judicabot", status: "Up 2 days (healthy)", sizeRw: 12_000,
    labels: { ...router("judicabot", `judicabot.${D}`, 8000), "org.opencontainers.image.revision": "0f3c9a1" },
  },
  {
    name: "llama-server", image: "ghcr.io/ggml-org/llama.cpp:server", project: "llm_inference", state: "restarting",
    status: "Restarting (1) 41 seconds ago", sizeRw: 0, volumes: ["llm_inference_models"],
  },
];

const VOLUME_BYTES: Record<string, number> = {
  traefik_letsencrypt: 61_000,
  dns_pdns_db: 182_000_000,
  vaultwarden_data: 4_300_000,
  monitoring_prometheus_data: 2_900_000_000,
  monitoring_loki_data: 1_400_000_000,
  monitoring_grafana_data: 61_000_000,
  monitoring_alloy_data: 9_800_000,
  monitoring_tempo_data: 240_000_000,
  monitoring_alertmanager_data: 40_000,
  zot_data: 6_700_000_000,
  metabase_db: 410_000_000,
  llm_inference_models: 4_900_000_000,
};

const id = (name: string) => Bun.hash(name).toString(16).padStart(16, "0").repeat(4);

export function dockerContainers(): unknown[] {
  return SPECS.map((s) => ({
    Id: id(s.name),
    Names: [`/${s.name}`],
    Image: s.image,
    ImageID: `sha256:${id(s.image)}`,
    State: s.state ?? "running",
    Status: s.status,
    Labels: {
      "com.docker.compose.project": s.project,
      "com.docker.compose.service": s.name,
      ...s.labels,
    },
    Mounts: (s.volumes ?? []).map((v) => ({ Type: "volume", Name: v, Destination: `/data/${v}` })),
  }));
}

export function dockerDf(): unknown {
  return {
    LayersSize: 0,
    Images: [],
    BuildCache: [],
    Containers: SPECS.map((s) => ({
      Id: id(s.name),
      Names: [`/${s.name}`],
      SizeRw: s.sizeRw,
      SizeRootFs: s.sizeRw + 100_000_000,
      Mounts: (s.volumes ?? []).map((v) => ({ Type: "volume", Name: v })),
    })),
    Volumes: Object.entries(VOLUME_BYTES).map(([Name, Size]) => ({ Name, UsageData: { RefCount: 1, Size } })),
  };
}
