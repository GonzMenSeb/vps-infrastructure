import { basename } from "node:path";
import type { ComposeResult, ComposeRunner } from "../../src/actions/compose";
import { REGISTRY_HOST, REGISTRY_PASSWORD, REGISTRY_USER, digestOf, registryRows, type RegistryRow } from "./registry-fixture";

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
  imageId?: string;
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
    imageId: digestOf("judicabot/judicabot", "c19ab44"),
    labels: { ...router("judicabot", `judicabot.${D}`, 8000), "org.opencontainers.image.revision": "c19ab44" },
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
    ImageID: s.imageId ?? `sha256:${id(s.image)}`,
    State: s.state ?? "running",
    Status: s.status,
    Labels: {
      "com.docker.compose.project": s.project,
      "com.docker.compose.service": s.name,
      "com.docker.compose.project.working_dir": `/opt/${s.project}`,
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

interface FakeContainer {
  spec: Spec;
  state: "running" | "exited";
  imageId: string;
  startedAt: number | null;
  stoppedAt: number | null;
  touched: boolean;
  hasHealthcheck: boolean;
}

export interface FakeDockerOptions {
  now?: () => number;
  healthDelayMs?: number;
  registry?: () => Record<string, RegistryRow[]>;
}

export interface DockerCall {
  method: string;
  path: string;
  auth?: { username: string; serveraddress: string; accepted: boolean };
}

const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));

export class FakeDocker {
  private containers = new Map<string, FakeContainer>();
  private localTags = new Map<string, string>();
  private now: () => number;
  private healthDelayMs: number;
  private registry: () => Record<string, RegistryRow[]>;
  calls: DockerCall[] = [];
  unhealthyImages = new Set<string>();
  crashImages = new Set<string>();
  pullFailures = new Map<string, string>();
  unreadable = { value: false };
  stalled = { value: false };
  noRepoDigests = { value: false };
  pullsAs = new Map<string, string>();

  constructor(opts: FakeDockerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.healthDelayMs = opts.healthDelayMs ?? 4000;
    const rows = registryRows(this.now());
    this.registry = opts.registry ?? (() => rows);
    for (const spec of SPECS) {
      const imageId = spec.imageId ?? `sha256:${id(spec.image)}`;
      this.containers.set(spec.name, {
        spec,
        state: (spec.state ?? "running") === "running" ? "running" : "exited",
        imageId,
        startedAt: null,
        stoppedAt: null,
        touched: false,
        hasHealthcheck: spec.status.includes("(healthy)"),
      });
      this.localTags.set(spec.image, imageId);
    }
  }

  private health(c: FakeContainer): "healthy" | "unhealthy" | "starting" | "none" {
    if (!c.hasHealthcheck) return "none";
    if (this.unhealthyImages.has(c.imageId)) return this.now() - (c.startedAt ?? 0) >= this.healthDelayMs ? "unhealthy" : "starting";
    if (c.startedAt !== null && this.now() - c.startedAt < this.healthDelayMs) return "starting";
    return "healthy";
  }

  private view(c: FakeContainer): { State: string; Status: string } {
    if (!c.touched) return { State: c.spec.state ?? "running", Status: c.spec.status };
    const t = this.now();
    if (c.state === "exited") return { State: "exited", Status: `Exited (0) ${secs(t - (c.stoppedAt ?? t))} seconds ago` };
    if (this.crashImages.has(c.imageId)) return { State: "restarting", Status: `Restarting (1) ${secs(t - (c.startedAt ?? t))} seconds ago` };
    const h = this.health(c);
    const suffix = h === "healthy" ? " (healthy)" : h === "unhealthy" ? " (unhealthy)" : h === "starting" ? " (health: starting)" : "";
    return { State: "running", Status: `Up ${secs(t - (c.startedAt ?? t))} seconds${suffix}` };
  }

  list(): unknown[] {
    const base = dockerContainers() as { Names: string[]; Image: string; ImageID: string; State: string; Status: string; Labels: Record<string, string> }[];
    return base.map((row) => {
      const c = this.containers.get(row.Names[0]!.slice(1))!;
      const ref = c.spec.image;
      const revision = Object.values(this.registry()).flat().find((r) => r.digest === c.imageId && r.tag !== "latest")?.tag;
      const labels = (row as { Labels: Record<string, string> }).Labels;
      return {
        ...row,
        ...this.view(c),
        ImageID: c.imageId,
        Image: this.localTags.get(ref) === c.imageId ? ref : c.imageId,
        Labels: revision && labels["org.opencontainers.image.revision"] ? { ...labels, "org.opencontainers.image.revision": revision } : labels,
      };
    });
  }

  project(name: string): FakeContainer[] {
    return [...this.containers.values()].filter((c) => c.spec.project === name);
  }

  stopProject(name: string): void {
    const t = this.now();
    for (const c of this.project(name)) {
      if (c.state !== "running") continue;
      Object.assign(c, { state: "exited", stoppedAt: t, touched: true });
    }
  }

  upProject(name: string): void {
    const t = this.now();
    for (const c of this.project(name)) {
      const desired = this.localTags.get(c.spec.image) ?? c.imageId;
      if (c.state === "running" && c.imageId === desired) continue;
      Object.assign(c, { state: "running", imageId: desired, startedAt: t, stoppedAt: null, touched: true });
    }
  }

  container(name: string): { state: string; imageId: string } {
    const c = this.containers.get(name)!;
    return { state: this.view(c).State, imageId: c.imageId };
  }

  tagOf(ref: string): string | undefined {
    return this.localTags.get(ref);
  }

  private resolve(name: string): string | undefined {
    if (this.localTags.has(name)) return this.localTags.get(name);
    return [...this.localTags.values()].includes(name) || [...this.containers.values()].some((c) => c.imageId === name) ? name : undefined;
  }

  private pull(url: URL, authHeader: string | null): Response {
    const image = url.searchParams.get("fromImage") ?? "";
    const tag = url.searchParams.get("tag") ?? "latest";
    let auth: DockerCall["auth"];
    if (authHeader) {
      try {
        const a = JSON.parse(Buffer.from(authHeader.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as { username: string; password: string; serveraddress: string };
        auth = { username: a.username, serveraddress: a.serveraddress, accepted: a.username === REGISTRY_USER && a.password === REGISTRY_PASSWORD };
      } catch {
        auth = { username: "", serveraddress: "", accepted: false };
      }
    }
    this.calls[this.calls.length - 1]!.auth = auth;
    const lines = (...o: object[]) => new Response(o.map((x) => JSON.stringify(x)).join("\n") + "\n", { headers: { "content-type": "application/json" } });
    const slash = image.indexOf("/");
    const repo = image.slice(slash + 1);
    const row = image.slice(0, slash) === REGISTRY_HOST ? this.registry()[repo]?.find((r) => r.tag === tag) : undefined;
    const failure = this.pullFailures.get(tag);
    if (failure) return lines({ status: `Pulling from ${repo}` }, { error: failure, errorDetail: { message: failure } });
    if (!auth?.accepted) return lines({ error: "unauthorized: authentication required", errorDetail: { message: "unauthorized: authentication required" } });
    if (!row) return lines({ error: `manifest for ${image}:${tag} not found: manifest unknown`, errorDetail: { message: "manifest unknown" } });
    this.localTags.set(`${image}:${tag}`, this.pullsAs.get(tag) ?? row.digest);
    return lines({ status: `Pulling from ${repo}`, id: tag }, { status: "Download complete" }, { status: `Status: Downloaded newer image for ${image}:${tag}` });
  }

  handle(req: Request): Response | Promise<Response> {
    const u = new URL(req.url);
    if (this.stalled.value) return new Promise<Response>(() => {});
    if (this.unreadable.value) return Response.json({ message: "daemon unavailable" }, { status: 500 });
    this.calls.push({ method: req.method, path: u.pathname + decodeURIComponent(u.search) });
    if (u.pathname === "/containers/json") return Response.json(this.list());
    if (u.pathname === "/system/df") return Response.json(dockerDf());
    const name = decodeURIComponent(u.pathname.replace(/^\/images\//, "").replace(/\/(json|tag)$/, ""));
    if (req.method === "POST" && u.pathname === "/images/create") return this.pull(u, req.headers.get("x-registry-auth"));
    if (req.method === "GET" && /^\/images\/.+\/json$/.test(u.pathname)) {
      const imageId = this.resolve(name);
      if (!imageId) return Response.json({ message: `No such image: ${name}` }, { status: 404 });
      const tags = [...this.localTags.entries()].filter(([, v]) => v === imageId).map(([k]) => k);
      return Response.json({ Id: imageId, RepoTags: tags, RepoDigests: this.noRepoDigests.value ? [] : [...new Set(tags.map((t) => `${t.replace(/:[^:/]+$/, "")}@${imageId}`))] });
    }
    if (req.method === "POST" && /^\/images\/.+\/tag$/.test(u.pathname)) {
      const imageId = this.resolve(name);
      if (!imageId) return Response.json({ message: `No such image: ${name}` }, { status: 404 });
      this.localTags.set(`${u.searchParams.get("repo")}:${u.searchParams.get("tag")}`, imageId);
      return new Response(null, { status: 201 });
    }
    return Response.json({ message: "page not found" }, { status: 404 });
  }
}

export class FakeCompose implements ComposeRunner {
  commands: { dir: string; args: string[] }[] = [];
  failures: { match: (args: readonly string[]) => boolean; result: ComposeResult }[] = [];

  constructor(private docker: FakeDocker) {}

  async run(dir: string, args: readonly string[]): Promise<ComposeResult> {
    this.commands.push({ dir, args: [...args] });
    const failure = this.failures.find((f) => f.match(args));
    if (failure) return failure.result;
    if (args[0] === "stop") this.docker.stopProject(basename(dir));
    else if (args[0] === "up") this.docker.upProject(basename(dir));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  }
}
