import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
import { secureHeaders } from "hono/secure-headers";
import { devAuthRoutes } from "./auth/dev";
import { authRoutes, githubClient, type GithubClient } from "./auth/github";
import { type AppEnv, type AuthedSession, csrfGuard, originGuard, requireSession } from "./auth/session";
import { ActionRuntime, ServiceActions, ServiceLocks } from "./actions/service";
import { RollbackActions } from "./actions/rollback";
import { noCompose, SpawnComposeRunner, type ComposeRunner } from "./actions/compose";
import { SocketEngine } from "./actions/engine";
import { rollbackRepos } from "./actions/rollback-select";
import { DockerClient, registerDockerSources } from "./collectors/docker";
import { ZOT_TAG_SOURCE, ZotTagsClient, registerZotTagSource, type ZotRepoTags } from "./collectors/zot-tags";
import { serviceActionRoutes, type ServiceDeps } from "./routes/service-actions";
import type { ServiceView } from "./views/service-actions-model";
import {
  JENKINS_SOURCES,
  JENKINS_TTL,
  JenkinsError,
  fetchConsole,
  jenkinsClientFromConfig,
  registerJenkinsSources,
  type JenkinsClient,
  type JenkinsJobs,
} from "./collectors/jenkins";
import { FilterError, LOKI_SOURCES, LOKI_TTL, LokiClient, normalizeFilter, registerLokiSources, type LogTargets } from "./collectors/loki";
import { PROM_SOURCES, PromClient, registerPrometheusSources, type AgentHost } from "./collectors/prometheus";
import { type Config, configWarnings, loadConfig } from "./config";
import { openDataDb } from "./db";
import { JobActions } from "./actions/jobs";
import { SecretActions, isActive as isActiveEdit } from "./actions/secrets";
import { TailHub } from "./logs/hub";
import { serveLogStream } from "./logs/sse";
import { loadManifest, type Manifest } from "./manifest";
import { Poller } from "./poller";
import { secretRoutes, secretsSignature, secretsView } from "./routes/secrets";
import { buildPhase4, registerPhase4Routes, type Phase4 } from "./routes/phase4";
import { Store } from "./store";
import type { SecretsView } from "./views/auth-model";
import { HostsFrame, HostsPage } from "./views/hosts";
import { jenkinsSnapshot, lokiSnapshot } from "./views/jenkins-data";
import { JobsFrame, JobsPage } from "./views/jobs";
import { LogsPage } from "./views/logs";
import {
  HOSTS,
  buildHosts,
  buildJobs,
  buildLogs,
  buildOverview,
  buildService,
  buildServices,
  fmtAge,
  jobsHref,
  parseMetric,
  readSources,
  serviceTabs,
  snapshotStatus,
  sourceStatus,
  type Flash,
  type JenkinsView,
  type LogsView,
  type SourceKey,
  type Sources,
  type ViewInput,
} from "./views/model";
import { OverviewFrame, OverviewPage, type Chrome } from "./views/overview";
import { NotFoundPage, loginHtml } from "./views/pages";
import { ServiceFrame, ServicePage } from "./views/service";
import { ServicesFrame, ServicesPage } from "./views/services";

export interface Deps {
  cfg: Config;
  db: Database;
  store: Store;
  gh: GithubClient;
  lagMs: () => number;
  manifest: Manifest;
  poller: Poller;
  jenkins?: JenkinsDeps;
  loki?: { client: LokiClient; hub: TailHub };
  service?: ServiceDeps;
  secrets?: SecretActions;
  phase4?: Phase4;
}

export interface JenkinsDeps {
  client: JenkinsClient;
  actions: JobActions | null;
  knownJobs: () => Set<string>;
}

const SERVER_IDLE_TIMEOUT_S = 60;
const SECRET_TRACK_INTERVAL_MS = 4000;

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

export const FLASH_COOKIE = "vp_flash";
const FLASH_MAX = 300;
const CLOCK_BUCKET_MS = 5000;
const IDLE_CLOCK_BUCKET_MS = 60_000;
const CONSOLE_START = /^\d{1,15}$/;
const BUILD_NUMBER = /^[1-9]\d{0,8}$/;

export const LIVE_FRAME = "live";
const DOCTYPE = "<!doctype html>";
export const TURBO_PROGRESS_STYLE_HASH = "'sha256-WAyOw4V+FqDc35lQPyRADLBWbuNK8ahvYEaQIYF1+Ps='";
const BUILD_ID = Date.now().toString(36);
const BASE_SOURCES: readonly SourceKey[] = ["hosts", "containers", "docker", "df"];
const OVERVIEW_SOURCES: readonly SourceKey[] = [...BASE_SOURCES, "agent"];
const HOSTS_SOURCES: readonly SourceKey[] = [...OVERVIEW_SOURCES, "series"];

export function monitorLoopLag(intervalMs = 250): { read: () => number; stop: () => void } {
  let expected = performance.now() + intervalMs;
  let lag = 0;
  const t = setInterval(() => {
    const now = performance.now();
    lag = Math.max(0, now - expected);
    expected = now + intervalMs;
  }, intervalMs);
  t.unref();
  return { read: () => lag, stop: () => clearInterval(t) };
}

const sha = (parts: readonly string[]) => createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 27);

function sourceSig(key: SourceKey, sources: Sources): string {
  const snap = sources[key];
  const st = sourceStatus(key, snap);
  return [key, st.state, st.error ?? "", snap?.hash ?? "", snap?.breaker ?? "", st.state === "stale" ? fmtAge(st.ageMs) : ""].join("\u0001");
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

type Node = { toString(): string | Promise<string> };

const html = async (node: Node) => String(await node.toString());

export interface LiveSpec {
  key: string;
  sources: readonly SourceKey[];
  page: (input: ViewInput, chrome: Chrome) => Node;
  frame: (input: ViewInput) => Node;
  clock?: boolean;
  clockMs?: number;
  extra?: readonly string[];
  secrets?: (s: AuthedSession) => SecretsView;
}

export function createApp(deps: Deps): Hono<AppEnv> {
  const { cfg, db, store, gh, lagMs, manifest, poller, jenkins, loki, service, phase4 } = deps;
  const secrets = deps.secrets ?? null;
  const app = new Hono<AppEnv>();
  const manifestHash = sha([JSON.stringify(manifest)]);

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", TURBO_PROGRESS_STYLE_HASH],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
      referrerPolicy: "same-origin",
    }),
  );

  app.get("/healthz", (c) => {
    const lag = lagMs();
    const stale = poller.overdue(cfg.HEALTH_MIN_SNAPSHOT_AGE_MS);
    const ok = lag <= cfg.HEALTH_MAX_LOOP_LAG_MS && stale.length === 0;
    return c.json(
      { status: ok ? "ok" : "unhealthy", loopLagMs: Math.round(lag), staleSnapshots: stale },
      ok ? 200 : 503,
    );
  });

  const gzip = compress();
  app.use(
    "/public/*",
    gzip,
    etag({ weak: true }),
    serveStatic({ root: "./", onFound: (_p, c) => c.header("cache-control", "public, max-age=3600") }),
  );
  app.use("*", (c, next) => (c.req.header("turbo-frame") === LIVE_FRAME ? gzip(c, next) : next()));


  app.use("*", originGuard(cfg));
  app.route("/", authRoutes(db, cfg, gh));
  app.route("/", devAuthRoutes(db, cfg));

  app.get("/login", async (c) => c.html(DOCTYPE + (await html(loginHtml(undefined, cfg.devAuthBypass)))));

  const session = requireSession(db, cfg);
  const demand = async (_c: Context<AppEnv>, next: () => Promise<void>) => {
    poller.touch();
    await next();
  };

  const registered = new Set(store.names());

  const jenkinsView = (): JenkinsView | undefined => {
    if (!jenkins) return undefined;
    const raw = registered.has(JENKINS_SOURCES.jobs) ? store.peek<JenkinsJobs>(JENKINS_SOURCES.jobs) : null;
    return {
      snapshot: raw ? jenkinsSnapshot(raw) : null,
      baseUrl: cfg.JENKINS_URL ?? null,
      actions: jenkins.actions !== null,
      ttlMs: JENKINS_TTL.jobsMs,
      noRun: [cfg.SECRETS_JOB],
    };
  };

  const lokiView = (): LogsView => {
    const raw = loki && registered.has(LOKI_SOURCES.targets) ? store.peek<LogTargets>(LOKI_SOURCES.targets) : null;
    return { configured: loki !== undefined, snapshot: raw ? lokiSnapshot(raw) : null, ttlMs: LOKI_TTL.targetsMs };
  };

  const jobsActive = (): boolean => {
    const data = jenkinsView()?.snapshot?.data;
    return !data || data.queue.length > 0 || data.builds.some((b) => b.building);
  };

  const extraSig = (): string => {
    const v = jenkinsView();
    const snap = v?.snapshot;
    const st = snapshotStatus("jenkins", "Jenkins", JENKINS_TTL.jobsMs, snap ?? null);
    return ["jenkins", st.state, st.error ?? "", snap?.hash ?? "", snap?.breaker ?? "", st.state === "stale" ? fmtAge(st.ageMs) : ""].join("\u0001");
  };

  const serviceView = (): ServiceView | undefined =>
    service
      ? {
          dryRun: service.dryRun,
          registryHost: service.registryHost,
          zotConfigured: service.zotConfigured,
          zot: registered.has(ZOT_TAG_SOURCE) ? store.peek<ZotRepoTags>(ZOT_TAG_SOURCE) : null,
          locked: (id) => service.locks.has(id),
          verifyTimeoutMs: service.verifyTimeoutMs,
        }
      : undefined;

  const agentClock = (host: string): string[] => {
    const data = registered.has(PROM_SOURCES.agent) ? store.peek<AgentHost[]>(PROM_SOURCES.agent).data : undefined;
    return data?.some((a) => a.host === host) ? [`agent:${Math.floor(Date.now() / IDLE_CLOCK_BUCKET_MS)}`] : [];
  };

  const serviceSig = (id: string): string => {
    const z = service && registered.has(ZOT_TAG_SOURCE) ? store.peek<ZotRepoTags>(ZOT_TAG_SOURCE) : null;
    return ["service", service?.locks.has(id) ? "locked" : "", z?.hash ?? "", z?.lastError ?? "", z?.breaker ?? ""].join("\u0001");
  };

  const viewInput = (csrf: string, sources: Sources): ViewInput => ({
    manifest,
    sources,
    timeZone: cfg.TIME_ZONE,
    csrf,
    jenkins: jenkinsView(),
    logs: lokiView(),
    service: serviceView(),
    ...phase4?.views(),
  });

  const live = async (c: Context<AppEnv>, spec: LiveSpec): Promise<Response> => {
    const s = c.get("session");
    const sources = readSources(store);
    const frame = c.req.header("turbo-frame") === LIVE_FRAME;
    const sv = spec.secrets?.(s);
    const active = Boolean(sv?.edits.some((e) => isActiveEdit({ stage: e.stage })));
    const ticks = spec.clock || Boolean(sv?.edits.length);
    const clockMs = spec.clockMs ?? (sv && !active ? IDLE_CLOCK_BUCKET_MS : CLOCK_BUCKET_MS);
    const clock = ticks ? String(Math.floor(Date.now() / clockMs)) : "";
    const etag = `W/"${sha([BUILD_ID, manifestHash, cfg.TIME_ZONE, spec.key, frame ? "frame" : "page", s.csrf, extraSig(), clock, ...(spec.extra ?? []), ...(sv ? secretsSignature(sv) : []), ...spec.sources.map((k) => sourceSig(k, sources))])}"`;
    c.header("etag", etag);
    c.header("cache-control", "private, no-cache");
    c.header("vary", "Turbo-Frame, Cookie");
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    const input = viewInput(s.csrf, sources);
    if (sv) input.secrets = sv;
    if (frame) return c.html(await html(spec.frame(input)));
    return c.html(DOCTYPE + (await html(spec.page(input, { login: s.login, csrf: s.csrf }))));
  };

  const notFound = async (c: Context<AppEnv>, what: string) => {
    const s = c.get("session");
    return c.html(DOCTYPE + (await html(NotFoundPage({ chrome: { login: s.login, csrf: s.csrf }, what }))), 404);
  };

  app.get("/", session, demand, (c) =>
    live(c, {
      key: "overview",
      clock: true,
      sources: OVERVIEW_SOURCES,
      page: (input, chrome) => OverviewPage({ chrome, vm: buildOverview(input) }),
      frame: (input) => OverviewFrame({ vm: buildOverview(input) }),
    }),
  );

  app.get("/hosts", session, (c) => {
    const host = HOSTS.find((h) => h === c.req.query("host")) ?? HOSTS[0]!;
    const metric = c.req.query("metric");
    return c.redirect(`/hosts/${host}${metric ? `?metric=${encodeURIComponent(parseMetric(metric))}` : ""}`, 302);
  });

  app.get("/hosts/:host", session, demand, (c) => {
    const host = HOSTS.find((h) => h === c.req.param("host"));
    if (!host) return notFound(c, `There is no host called ${c.req.param("host")}.`);
    const metric = parseMetric(c.req.query("metric"));
    const q = { host, metric };
    return live(c, {
      key: `hosts:${host}:${metric}`,
      extra: agentClock(host),
      sources: HOSTS_SOURCES,
      page: (input, chrome) => HostsPage({ chrome, vm: buildHosts(input, q) }),
      frame: (input) => HostsFrame({ vm: buildHosts(input, q) }),
    });
  });

  app.get("/services", session, demand, (c) =>
    live(c, {
      key: "services",
      sources: BASE_SOURCES,
      page: (input, chrome) => ServicesPage({ chrome, vm: buildServices(input) }),
      frame: (input) => ServicesFrame({ vm: buildServices(input) }),
    }),
  );

  app.get("/services/:id", session, demand, (c) => {
    const id = c.req.param("id");
    const svc = manifest.services.find((s) => s.id === id);
    if (!svc) return notFound(c, `There is no service called ${id} in the manifest.`);
    const tab = serviceTabs(svc).find((t) => t.id === c.req.query("tab"))?.id ?? "summary";
    const flash = readFlash(c);
    return live(c, {
      key: `service:${id}:${tab}`,
      clock: tab === "builds" || tab === "summary",
      clockMs: tab === "builds" ? undefined : IDLE_CLOCK_BUCKET_MS,
      extra: [serviceSig(id), ...(tab === "db" ? (phase4?.databaseSig() ?? []) : []), ...(flash ? [`flash:${flash.ok}:${flash.text}`] : [])],
      secrets: tab === "auth" ? (sess) => secretsView({ cfg, manifest, secrets }, id, sess) : undefined,
      sources: BASE_SOURCES,
      page: (input, chrome) => ServicePage({ chrome, vm: buildService(input, id, tab, flash)! }),
      frame: (input) => ServiceFrame({ vm: buildService(input, id, tab, flash)! }),

    });
  });

  const apiSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    let passed = false;
    await session(c, async () => {
      passed = true;
      await next();
    });
    if (!passed) return c.text("unauthorized", 401);
  };

  const readFlash = (c: Context<AppEnv>): Flash | null => {
    const raw = getCookie(c, FLASH_COOKIE);
    if (!raw) return null;
    deleteCookie(c, FLASH_COOKIE, { path: "/" });
    try {
      const v = JSON.parse(raw) as Partial<Flash>;
      return typeof v.text === "string" ? { ok: v.ok === true, text: v.text.slice(0, FLASH_MAX) } : null;
    } catch {
      return null;
    }
  };

  const setFlash = (c: Context<AppEnv>, r: { ok: boolean; message: string }) =>
    setCookie(c, FLASH_COOKIE, JSON.stringify({ ok: r.ok, text: r.message.slice(0, FLASH_MAX) }), {
      httpOnly: true,
      secure: cfg.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 60,
    });

  app.get("/jobs", session, demand, (c) => {
    const job = c.req.query("job");
    const build = c.req.query("build");
    const flash = readFlash(c);
    const all = c.req.query("history") === "all";
    return live(c, {
      key: `jobs:${job ?? ""}:${build ?? ""}:${all ? "all" : ""}`,
      clock: true,
      clockMs: jobsActive() ? CLOCK_BUCKET_MS : IDLE_CLOCK_BUCKET_MS,
      extra: flash ? [`flash:${flash.ok}:${flash.text}`] : [],
      sources: BASE_SOURCES,
      page: (input, chrome) => JobsPage({ chrome, vm: buildJobs(input, { job, build, flash, all }) }),
      frame: (input) => JobsFrame({ vm: buildJobs(input, { job, build, flash, all }) }),
    });
  });

  app.post("/jobs/:job/build", session, csrfGuard(), async (c) => {
    if (!jenkins?.actions) return c.text("job actions are not configured", 503);
    const job = c.req.param("job");
    const r = await jenkins.actions.trigger(job, c.get("session").login);
    setFlash(c, r);
    return c.redirect(r.build ? jobsHref(job, r.build) : "/jobs", 303);
  });

  app.post("/jobs/:job/:n/stop", session, csrfGuard(), async (c) => {
    if (!jenkins?.actions) return c.text("job actions are not configured", 503);
    const job = c.req.param("job");
    const n = c.req.param("n");
    if (!BUILD_NUMBER.test(n)) return c.text("invalid build number", 400);
    const r = await jenkins.actions.stop(job, Number(n), c.get("session").login);
    setFlash(c, r);
    return c.redirect(jobsHref(job, Number(n)), 303);
  });

  app.get("/jobs/:job/:n/console", apiSession, async (c) => {
    if (!jenkins) return c.text("jenkins is not configured", 503);
    const job = c.req.param("job");
    const n = c.req.param("n");
    const start = c.req.query("start") ?? "0";
    if (!BUILD_NUMBER.test(n) || !CONSOLE_START.test(start)) return c.text("invalid request", 400);
    if (!jenkins.knownJobs().has(job)) return c.text("unknown job", 404);
    try {
      const chunk = await fetchConsole(jenkins.client, job, Number(n), Number(start));
      return c.body(chunk.text, 200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-text-size": String(chunk.nextOffset),
        ...(chunk.more ? { "x-more-data": "true" } : {}),
      });
    } catch (err) {
      if (err instanceof JenkinsError && err.status === 404) return c.text("no such build", 404);
      return c.text("jenkins did not answer", 502);
    }
  });

  if (service) app.route("/", serviceActionRoutes({ session, service, flash: setFlash }));

  app.get("/logs", session, demand, async (c) => {
    const s = c.get("session");
    const vm = buildLogs(viewInput(s.csrf, readSources(store)), { host: c.req.query("host"), container: c.req.query("container") });
    c.header("cache-control", "private, no-store");
    return c.html(DOCTYPE + (await html(LogsPage({ chrome: { login: s.login, csrf: s.csrf }, vm }))));
  });

  app.get("/logs/stream", apiSession, (c) => {
    if (!loki) return c.text("loki is not configured", 503);
    let filter;
    try {
      filter = normalizeFilter({ host: c.req.query("host"), container: c.req.query("container") });
    } catch (err) {
      if (err instanceof FilterError) return c.text(err.message, 400);
      throw err;
    }
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");
    return serveLogStream(c, {
      hub: loki.hub,
      filter,
      backlog: (after) =>
        loki.client.backlog(filter, { limit: 200, ...(after ? { afterNs: after } : {}) }).catch(() => []),
    });
  });

  app.route("/", secretRoutes({ cfg, db, manifest, session, apiSession, secrets }));

  if (phase4) registerPhase4Routes(app, phase4, { session, demand, live, readFlash, setFlash, baseSources: BASE_SOURCES });

  return app;
}

export interface Running {
  cfg: Config;
  url: string;
  stop: () => Promise<void>;
}

export interface StartOverrides {
  compose?: ComposeRunner;
}

function serviceDeps(cfg: Config, manifest: Manifest, db: Database, store: Store, dockerClient: DockerClient, base: { timeoutMs: number; failureThreshold: number; cooldownMs: number }, overrides: StartOverrides): ServiceDeps {
  const dryRun = cfg.dryRunActions || (cfg.devAuthBypass && !overrides.compose);
  if (dryRun && !cfg.dryRunActions) console.warn("DEV_AUTH_BYPASS=1 without an injected compose runner: switch and rollback run as a dry run");
  const compose = overrides.compose ?? (dryRun ? noCompose : new SpawnComposeRunner(cfg.DOCKER_SOCKET));
  const registryHost = cfg.ZOT_REGISTRY_HOST ?? manifest.services.find((s) => s.id === "zot")?.hostname ?? null;
  const zotConfigured = Boolean(cfg.ZOT_URL && cfg.ZOT_USER && cfg.ZOT_PASSWORD);
  const zot = zotConfigured ? new ZotTagsClient(cfg.ZOT_URL!, cfg.ZOT_USER, cfg.ZOT_PASSWORD) : null;
  if (zot) registerZotTagSource(store, zot, () => rollbackRepos(manifest, registryHost), base);
  const locks = new ServiceLocks();
  const runtime = new ActionRuntime({
    db,
    manifest,
    engine: new SocketEngine(dockerClient),
    compose,
    locks,
    dryRun,
    store,
    verifyTimeoutMs: cfg.ACTION_VERIFY_TIMEOUT_MS,
    composeTimeoutMs: cfg.COMPOSE_TIMEOUT_MS,
    pullTimeoutMs: cfg.ACTION_PULL_TIMEOUT_MS,
  });
  return {
    actions: new ServiceActions(runtime),
    rollback: new RollbackActions({
      runtime,
      registryHost,
      tags: zot ? (repo) => zot.repoTags(repo) : null,
      credentials: zotConfigured ? { user: cfg.ZOT_USER!, password: cfg.ZOT_PASSWORD! } : null,
    }),
    locks,
    dryRun,
    registryHost,
    zotConfigured,
    verifyTimeoutMs: cfg.ACTION_VERIFY_TIMEOUT_MS,
  };
}

export async function start(env: Record<string, string | undefined> = process.env, overrides: StartOverrides = {}): Promise<Running> {
  const cfg = loadConfig(env);
  const manifest = await loadManifest(cfg.SERVICES_MANIFEST_PATH);
  const db = openDataDb(cfg.DATA_DIR);
  const store = new Store();
  const base = { timeoutMs: cfg.UPSTREAM_TIMEOUT_MS, failureThreshold: cfg.BREAKER_FAILURE_THRESHOLD, cooldownMs: cfg.BREAKER_COOLDOWN_MS };
  registerPrometheusSources(store, new PromClient(cfg.PROMETHEUS_URL), base);
  const dockerClient = new DockerClient(cfg.DOCKER_SOCKET);
  registerDockerSources(store, dockerClient, base);
  const jenkinsClient = jenkinsClientFromConfig(cfg);
  let jenkinsDeps: JenkinsDeps | undefined;
  if (jenkinsClient) {
    registerJenkinsSources(store, jenkinsClient, base);
    const knownJobs = () =>
      new Set([
        ...manifest.services.flatMap((s) => (s.jenkins_job ? [s.jenkins_job] : [])),
        ...(store.peek<JenkinsJobs>(JENKINS_SOURCES.jobs).data?.jobs.map((j) => j.name) ?? []),
      ]);
    const mutable = !cfg.devAuthBypass || isLoopbackUrl(cfg.JENKINS_URL!);
    if (!mutable) console.warn("DEV_AUTH_BYPASS=1 with a non-local JENKINS_URL: build and stop actions are disabled");
    jenkinsDeps = { client: jenkinsClient, knownJobs, actions: mutable ? new JobActions({ client: jenkinsClient, db, knownJobs: () => [...knownJobs()].filter((j) => j !== cfg.SECRETS_JOB), store }) : null };
  }
  const secretActions = new SecretActions({
    client: jenkinsClient,
    editBlocked: jenkinsDeps && !jenkinsDeps.actions ? "DEV_AUTH_BYPASS=1 with a non-local JENKINS_URL: editing is disabled so a dev session cannot start a real build." : null,
    db,
    manifest,
    job: cfg.SECRETS_JOB,
    applyJob: cfg.SECRETS_APPLY_JOB,
    trackTimeoutMs: cfg.SECRETS_TRACK_TIMEOUT_SECONDS * 1000,
    envRoot: cfg.ENV_FILES_ROOT,
  });
  const secretTimer = setInterval(() => void secretActions.tick(), SECRET_TRACK_INTERVAL_MS);
  secretTimer.unref();
  let lokiDeps: { client: LokiClient; hub: TailHub } | undefined;
  if (cfg.LOKI_URL) {
    const client = new LokiClient(cfg.LOKI_URL, { timeoutMs: cfg.UPSTREAM_TIMEOUT_MS });
    registerLokiSources(store, client, base);
    lokiDeps = { client, hub: new TailHub(client) };
  }
  const service = serviceDeps(cfg, manifest, db, store, dockerClient, base, overrides);
  const poller = new Poller(store, {
    demandWindowMs: cfg.POLL_DEMAND_WINDOW_MS,
    idleIntervalMs: cfg.POLL_IDLE_INTERVAL_MS,
    tickMs: cfg.POLL_TICK_MS,
  });
  const phase4 = buildPhase4({ cfg, db, store, base, isLoopbackUrl });
  const lag = monitorLoopLag();
  const app = createApp({ cfg, db, store, gh: githubClient(cfg), lagMs: lag.read, manifest, poller, jenkins: jenkinsDeps, loki: lokiDeps, service, secrets: secretActions, phase4 });
  const server = Bun.serve({ port: cfg.PORT, idleTimeout: SERVER_IDLE_TIMEOUT_S, ...(cfg.devAuthBypass ? { hostname: "127.0.0.1" } : {}), fetch: app.fetch });


  poller.start();
  for (const warning of configWarnings(cfg)) console.warn(warning);
  if (cfg.devAuthBypass) console.warn(`DEV_AUTH_BYPASS=1: ${cfg.origin}/auth/dev signs anyone in as ${cfg.GITHUB_ALLOWED_LOGIN}`);
  return {
    cfg,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      poller.stop();
      lag.stop();
      clearInterval(secretTimer);
      lokiDeps?.hub.closeAll();
      await server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const running = await start();
  console.log(`panel listening on :${running.cfg.PORT}`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => void running.stop().then(() => process.exit(0)));
  }
}
