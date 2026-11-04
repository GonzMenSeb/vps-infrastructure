import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretActions } from "../src/actions/secrets";
import { githubClient } from "../src/auth/github";
import { JenkinsClient } from "../src/collectors/jenkins";
import { DOCKER_SOURCES } from "../src/collectors/docker";
import { PROM_SOURCES } from "../src/collectors/prometheus";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { loadManifest, type Manifest } from "../src/manifest";
import { Poller } from "../src/poller";
import { createApp } from "../src/server";
import { Store } from "../src/store";
import { containers, df, docker, hosts, series } from "./views-fixtures";

const ORIGIN = "https://panel.example.test";
const ENV_VALUE = "env-file-gate-password";
const NEW_VALUE = "Brand-New-Gate-Pass-1";

const env = {
  PUBLIC_URL: ORIGIN,
  SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
  DEV_AUTH_BYPASS: "1",
  NODE_ENV: "test",
};

let jenkins: ReturnType<typeof Bun.serve>;
let manifest: Manifest;
let root: string;
let posts: { path: string; body: string }[];
let db: Database;

beforeAll(async () => {
  manifest = await loadManifest("tests/fixtures/dev-services.json");
  jenkins = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "POST") {
        posts.push({ path: u.pathname, body: await req.text() });
        return new Response(null, { status: 201, headers: { location: "http://j.example.test/queue/item/9/" } });
      }
      if (u.pathname === "/job/panel-secrets/api/json") return Response.json({ buildable: true, property: [{ parameterDefinitions: [{ name: "VAR_NAME" }, { name: "VAR_VALUE" }] }] });
      return new Response("nf", { status: 404 });
    },
  });
  root = mkdtempSync(join(tmpdir(), "secret-routes-"));
  mkdirSync(join(root, "opt/judicabot"), { recursive: true });
  mkdirSync(join(root, "opt/decabot"), { recursive: true });
  writeFileSync(join(root, "opt/judicabot/.env"), `JUDICABOT_PASSWORD=${ENV_VALUE}\nOTHER=hidden-other\n`);
  writeFileSync(join(root, "opt/decabot/.env"), "DECABOT_PASSWORD=decabot-env-pass\nGEMINI_API_KEY=gemini-env-key\n");
});
afterAll(() => {
  void jenkins.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function rig(extra: Record<string, string> = {}, withJenkins = true) {
  posts = [];
  const cfg = loadConfig({ ...env, ENV_FILES_ROOT: root, ...extra });
  db = openDb(":memory:");
  const store = new Store();
  const opts = { ttlMs: 15_000, timeoutMs: 100, failureThreshold: 3, cooldownMs: 15_000 };
  const data: Record<string, unknown> = {
    [PROM_SOURCES.hosts]: hosts,
    [PROM_SOURCES.containers]: containers,
    [PROM_SOURCES.series]: series,
    [DOCKER_SOURCES.containers]: docker,
    [DOCKER_SOURCES.df]: df,
  };
  for (const name of Object.keys(data)) {
    store.register(name, async () => data[name], opts);
    await store.refresh(name);
  }
  const secrets = new SecretActions({
    client: withJenkins ? new JenkinsClient(`http://127.0.0.1:${jenkins.port}`, "admin", "tok") : null,
    db,
    manifest,
    job: cfg.SECRETS_JOB,
    applyJob: cfg.SECRETS_APPLY_JOB,
    trackTimeoutMs: 60_000,
    envRoot: cfg.ENV_FILES_ROOT,
    hashCost: 4,
  });
  const app = createApp({
    cfg,
    db,
    store,
    gh: githubClient(cfg),
    lagMs: () => 0,
    manifest,
    poller: new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 }),
    secrets,
  });
  const res = await app.request("/auth/dev?next=/services");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = await (await app.request("/services/judicabot?tab=auth", { headers: { cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
  const post = (path: string, o: { body?: Record<string, string>; origin?: string | null; token?: string | "none"; json?: boolean } = {}) =>
    app.request(path, {
      method: "POST",
      headers: {
        cookie,
        ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }),
        ...(o.json ? { "x-csrf-token": o.token ?? csrf } : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(o.json ? {} : { body: new URLSearchParams({ ...(o.token === "none" ? {} : { _csrf: o.token ?? csrf }), ...(o.body ?? {}) }).toString() }),
    });
  const frame = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { cookie, "turbo-frame": "live", ...headers } });
  const age = (ms: number) => db.query("UPDATE sessions SET reauth_at = ?").run(Date.now() - ms);
  return { app, cookie, csrf, post, frame, age, secrets };
}

const rows = () => db.query<{ action: string; target: string; outcome: string; detail: string | null }, []>("SELECT action, target, outcome, detail FROM audit WHERE action LIKE 'secret.%' ORDER BY id").all();

describe("reveal", () => {
  test("needs a session, an origin, a csrf header and a fresh sign-in", async () => {
    const r = await rig();
    const url = "/services/judicabot/auth/JUDICABOT_PASSWORD/reveal";
    expect((await r.app.request(url, { method: "POST", headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await r.post(url, { json: true, origin: null })).status).toBe(403);
    expect((await r.post(url, { json: true, token: "wrong" })).status).toBe(403);
    expect((await r.post(url, { token: "none" })).status).toBe(403);
    expect(rows()).toEqual([]);
  });

  test("returns the env file value only for a manifest key, with no-store, and audits without the value", async () => {
    const r = await rig();
    const ok = await r.post("/services/judicabot/auth/JUDICABOT_PASSWORD/reveal", { json: true });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ value: ENV_VALUE });
    expect(rows()).toEqual([{ action: "secret.reveal", target: "judicabot/JUDICABOT_PASSWORD", outcome: "ok", detail: null }]);
    expect(JSON.stringify(db.query("SELECT * FROM audit").all())).not.toContain(ENV_VALUE);
    for (const key of ["OTHER", "vault_judicabot_password", "nope"]) {
      const denied = await r.post(`/services/judicabot/auth/${key}/reveal`, { json: true });
      expect(denied.status).toBe(404);
      expect(JSON.stringify(await denied.json())).not.toContain("hidden-other");
    }
    expect((await r.post("/services/nope/auth/X/reveal", { json: true })).status).toBe(404);
  });

  test("a sign-in older than the limit is answered with the way back through the login, and nothing is read", async () => {
    const r = await rig();
    r.age(16 * 60_000);
    const res = await r.post("/services/judicabot/auth/JUDICABOT_PASSWORD/reveal", { json: true });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "reauth-required", reauth: "/auth/dev?next=%2Fservices%2Fjudicabot%3Ftab%3Dauth" });
    expect(rows()).toEqual([]);
    r.age(14 * 60_000);
    expect((await r.post("/services/judicabot/auth/JUDICABOT_PASSWORD/reveal", { json: true })).status).toBe(200);
  });
});

describe("the Auth tab", () => {
  test("shows masked placeholders only, with no secret value and no csrf token in the live frame", async () => {
    const r = await rig();
    await r.post("/services/judicabot/auth/JUDICABOT_PASSWORD/reveal", { json: true });
    const frame = await (await r.frame("/services/judicabot?tab=auth")).text();
    expect(frame).toContain("••••••••••");
    expect(frame).toContain('data-secret-url-value="/services/judicabot/auth/JUDICABOT_PASSWORD/reveal"');
    expect(frame).not.toContain(ENV_VALUE);
    expect(frame).not.toContain("hidden-other");
    expect(frame).not.toContain(r.csrf);
    const full = await (await r.app.request("/services/judicabot?tab=auth", { headers: { cookie: r.cookie } })).text();
    expect(full).not.toContain(ENV_VALUE);
  });

  test("a stale sign-in disables the controls and offers the sign-in link, and the ETag follows", async () => {
    const r = await rig();
    const first = await r.frame("/services/judicabot?tab=auth");
    const etag = first.headers.get("etag")!;
    expect((await r.frame("/services/judicabot?tab=auth", { "if-none-match": etag })).status).toBe(304);
    r.age(16 * 60_000);
    const stale = await r.frame("/services/judicabot?tab=auth", { "if-none-match": etag });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("etag")).not.toBe(etag);
    const body = await stale.text();
    expect(body).toContain("older than 15 minutes");
    expect(body).toContain('href="/auth/dev?next=%2Fservices%2Fjudicabot%3Ftab%3Dauth"');
    expect(body).toMatch(/data-action="secret#show" disabled=""/);
  });

  test("read-only credentials state why, and the Jenkins host service is read-only", async () => {
    const r = await rig();
    const miplata = await (await r.frame("/services/miplata?tab=auth")).text();
    expect(miplata).toContain("Postgres reads it only when it first creates its database");
    const jenkinsSvc = await (await r.frame("/services/jenkins?tab=auth")).text();
    expect(jenkinsSvc).toContain("runs on the Jenkins host");
    expect(jenkinsSvc).not.toContain('class="acct-edit"');
  });

  test("without a Jenkins connection reveal still works and editing says why it is off", async () => {
    const r = await rig({}, false);
    const body = await (await r.frame("/services/judicabot?tab=auth")).text();
    expect(body).toContain("Editing needs the Jenkins connection");
    expect((await r.post("/services/judicabot/auth/JUDICABOT_PASSWORD/reveal", { json: true })).status).toBe(200);
    const edit = await r.post("/services/judicabot/auth/JUDICABOT_PASSWORD", { body: { value: NEW_VALUE } });
    expect(edit.status).toBe(503);
  });
});

describe("edit", () => {
  const url = "/services/decabot/auth/DECABOT_PASSWORD";

  test("needs origin, csrf and a fresh sign-in", async () => {
    const r = await rig();
    expect((await r.post(url, { body: { value: NEW_VALUE }, origin: null })).status).toBe(403);
    expect((await r.post(url, { body: { value: NEW_VALUE }, token: "wrong" })).status).toBe(403);
    expect((await r.post(url, { body: { value: NEW_VALUE }, token: "none" })).status).toBe(403);
    r.age(16 * 60_000);
    const stale = await r.post(url, { body: { value: NEW_VALUE } });
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/auth/dev?next=%2Fservices%2Fdecabot%3Ftab%3Dauth");
    expect(posts).toEqual([]);
  });

  test("starts the job, redirects to the tab, and shows the change as pending without the value anywhere", async () => {
    const r = await rig();
    const res = await r.post(url, { body: { value: NEW_VALUE } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/services/decabot?tab=auth");
    expect(posts).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(posts[0]!.body))).toEqual({ VAR_NAME: "vault_decabot_password", VAR_VALUE: NEW_VALUE });
    const frame = await (await r.frame("/services/decabot?tab=auth")).text();
    expect(frame).toContain("Pending");
    expect(frame).toContain("Waiting for a Jenkins executor");
    expect(frame).toContain("Locked while pending");
    expect(frame).not.toContain(NEW_VALUE);
    expect(JSON.stringify([rows(), db.query("SELECT * FROM secret_edits").all(), db.query("SELECT * FROM sessions").all()])).not.toContain(NEW_VALUE);
  });

  test("a pending change changes the ETag so a 304 cannot hide it", async () => {
    const r = await rig();
    const before = (await r.frame("/services/decabot?tab=auth")).headers.get("etag")!;
    await r.post(url, { body: { value: NEW_VALUE } });
    const after = await r.frame("/services/decabot?tab=auth", { "if-none-match": before });
    expect(after.status).toBe(200);
    r.secrets.store.update(1, { stage: "editing", edit_build: 3 }, Date.now());
    expect((await r.frame("/services/decabot?tab=auth", { "if-none-match": after.headers.get("etag")! })).status).toBe(200);
  });

  test("rejections and conflicts render a page with the reason and change nothing", async () => {
    const r = await rig();
    const bad = await r.post(url, { body: { value: "{{ nope }}" } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("template");
    const locked = await r.post("/services/miplata/auth/POSTGRES_PASSWORD", { body: { value: NEW_VALUE } });
    expect(locked.status).toBe(400);
    expect(await locked.text()).toContain("Postgres reads it only");
    const missing = await r.post("/services/decabot/auth/NOPE", { body: { value: NEW_VALUE } });
    expect(missing.status).toBe(404);
    expect(posts).toEqual([]);
    expect((await r.post(url, { body: { value: NEW_VALUE } })).status).toBe(303);
    const busy = await r.post("/services/decabot/auth/GEMINI_API_KEY", { body: { value: "gemini-key-9999" } });
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain("still pending");
  });

  test("a hash credential sends the bcrypt line and nothing else", async () => {
    const r = await rig();
    const res = await r.post("/services/traefik/auth/traefik_dashboard_auth", { body: { value: "dashboard-password-1" } });
    expect(res.status).toBe(303);
    const sent = new URLSearchParams(posts[0]!.body);
    expect(sent.get("VAR_NAME")).toBe("traefik_dashboard_auth");
    expect(sent.get("VAR_VALUE")).toMatch(/^admin:\$2y\$04\$/);
    expect(posts[0]!.body).not.toContain("dashboard-password-1");
  });
});

describe("rotate", () => {
  test("refuses credentials that are not on the rotation list", async () => {
    const r = await rig();
    const res = await r.post("/services/decabot/auth/GEMINI_API_KEY/rotate");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not on the rotation list");
    expect(posts).toEqual([]);
  });

  test("generates a long random value server-side, sends it, and shows it once on a no-store page", async () => {
    const r = await rig();
    const res = await r.post("/services/decabot/auth/DECABOT_PASSWORD/rotate");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    const sent = new URLSearchParams(posts[0]!.body).get("VAR_VALUE")!;
    expect(sent).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(html).toContain(`>${sent}</code>`);
    expect(html).toContain("only time the panel shows");
    const frame = await (await r.frame("/services/decabot?tab=auth")).text();
    expect(frame).not.toContain(sent);
    expect(JSON.stringify([rows(), db.query("SELECT * FROM secret_edits").all()])).not.toContain(sent);
    const again = await r.post("/services/decabot/auth/DECABOT_PASSWORD/rotate");
    expect(again.status).toBe(409);
    expect(await again.text()).not.toContain(sent);
  });

  test("the dashboard login rotates to a random password whose hash is what Jenkins gets", async () => {
    const r = await rig();
    const html = await (await r.post("/services/traefik/auth/traefik_dashboard_auth/rotate")).text();
    const line = new URLSearchParams(posts[0]!.body).get("VAR_VALUE")!;
    const shown = /<code[^>]*data-once-target="value">([A-Za-z0-9]{24})<\/code>/.exec(html)![1]!;
    expect(line).toMatch(/^admin:\$2y\$04\$/);
    expect(await Bun.password.verify(shown, line.slice("admin:".length).replace("$2y$", "$2b$"))).toBe(true);
    expect(html).not.toContain(line);
  });
});

describe("the jobs page", () => {
  beforeEach(() => undefined);
  test("panel-secrets cannot be started by hand from the jobs page", async () => {
    const { buildJobs } = await import("../src/views/model");
    const { input } = await import("./views-fixtures");
    const base = input();
    const view = {
      baseUrl: "https://j.example.test",
      actions: true,
      ttlMs: 5000,
      noRun: ["panel-secrets"],
      snapshot: {
        data: { jobs: ["panel-secrets", "vps-deploy"], builds: [], queue: [], executors: null, parameterized: ["panel-secrets"] },
        fetchedAt: Date.now(),
        hash: "h",
        breaker: "closed",
        error: null,
      },
    } as never;
    const vm = buildJobs({ ...base, csrf: "tok", jenkins: view });
    expect(vm.jobs.find((j) => j.name === "panel-secrets")!.run).toBeNull();
    expect(vm.jobs.find((j) => j.name === "vps-deploy")!.run).not.toBeNull();
  });
});
