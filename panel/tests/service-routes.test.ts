import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SocketEngine } from "../src/actions/engine";
import { RollbackActions } from "../src/actions/rollback";
import { ActionRuntime, ServiceActions, ServiceLocks } from "../src/actions/service";
import { rollbackRepos } from "../src/actions/rollback-select";
import { githubClient } from "../src/auth/github";
import { DOCKER_SOURCES, DockerClient, registerDockerSources } from "../src/collectors/docker";
import { PromClient, registerPrometheusSources } from "../src/collectors/prometheus";
import { ZOT_TAG_SOURCE, ZotTagsClient, registerZotTagSource } from "../src/collectors/zot-tags";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { loadManifest } from "../src/manifest";
import { Poller } from "../src/poller";
import { createApp, type Deps } from "../src/server";
import { Store } from "../src/store";
import { startFixtureUpstreams, type FixtureUpstreams } from "./dev/fixture-upstreams";
import { REGISTRY_HOST, REGISTRY_PASSWORD, REGISTRY_USER } from "./dev/registry-fixture";

const ORIGIN = "https://panel.example.test";
let up: FixtureUpstreams;

beforeEach(async () => {
  up = await startFixtureUpstreams({ healthDelayMs: 0 });
});
afterEach(async () => {
  await up.stop();
});

async function rig(o: { dryRun?: boolean } = {}) {
  const cfg = loadConfig({
    PUBLIC_URL: ORIGIN,
    SERVICES_MANIFEST_PATH: "x",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_ALLOWED_LOGIN: "owner",
    SESSION_SECRET: "x".repeat(40),
    NODE_ENV: "test",
    DEV_AUTH_BYPASS: "1",
  });
  const manifest = await loadManifest("tests/fixtures/dev-services.json");
  const store = new Store();
  const base = { timeoutMs: 2000, failureThreshold: 3, cooldownMs: 15_000 };
  const dockerClient = new DockerClient(up.dockerSocket);
  registerPrometheusSources(store, new PromClient(up.promUrl), base);
  registerDockerSources(store, dockerClient, base);
  const zot = new ZotTagsClient(up.zot.url, REGISTRY_USER, REGISTRY_PASSWORD);
  registerZotTagSource(store, zot, () => rollbackRepos(manifest, REGISTRY_HOST), base);
  const db = openDb(":memory:");
  const locks = new ServiceLocks();
  const runtime = new ActionRuntime({
    db,
    manifest,
    engine: new SocketEngine(dockerClient),
    compose: up.compose,
    locks,
    dryRun: o.dryRun ?? false,
    store,
    pollMs: 10,
    stableMs: 20,
    verifyTimeoutMs: 3000,
  });
  const service: NonNullable<Deps["service"]> = {
    actions: new ServiceActions(runtime),
    rollback: new RollbackActions({ runtime, registryHost: REGISTRY_HOST, tags: (r) => zot.repoTags(r), credentials: { user: REGISTRY_USER, password: REGISTRY_PASSWORD } }),
    locks,
    dryRun: o.dryRun ?? false,
    registryHost: REGISTRY_HOST,
    zotConfigured: true,
    verifyTimeoutMs: 60_000,
  };
  const poller = new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 });
  const app = createApp({ cfg, db, store, gh: githubClient(cfg), lagMs: () => 0, manifest, poller, service });
  const refresh = async () => {
    await Promise.all([...store.names()].map((n) => store.refresh(n)));
  };
  await refresh();
  const login = await app.request("/auth/dev?next=/");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = (path: string, extra = "") => app.request(path, { headers: { cookie: cookie + extra } });
  const page = async (path: string, extra = "") => (await get(path, extra)).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page("/services/judicabot"))![1]!;
  const post = (path: string, fields: Record<string, string>, origin: string | null = ORIGIN, token: string | null = csrf) =>
    app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      body: new URLSearchParams({ ...(token ? { _csrf: token } : {}), ...fields }).toString(),
    });
  const flashOf = (res: Response) => {
    const raw = /vp_flash=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return raw ? (JSON.parse(decodeURIComponent(raw)) as { ok: boolean; text: string }) : null;
  };
  const withFlash = (res: Response) => `; vp_flash=${/vp_flash=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1]}`;
  return { app, db, store, locks, get, page, post, flashOf, withFlash, refresh, cookie };
}

const attr = (html: string, name: string) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1]!.replaceAll("&#39;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">"));

describe("service page controls", () => {
  test("a switchable service offers Switch off with the exact command in the confirmation", async () => {
    const { page } = await rig();
    const html = await page("/services/vaultwarden");
    expect(html).toContain('action="/services/vaultwarden/switch"');
    expect(html).toContain('<input type="hidden" name="to" value="off"/>');
    expect(attr(html, "data-confirm-request-value")).toContain("cd /opt/vaultwarden && docker compose stop");
    const body = attr(html, "data-confirm-body-value").join(" ");
    expect(body).toContain("vps-deploy");
    expect(body).toContain("https://vault.web.example.test");
    expect(html).toContain(">Switch off</button>");
  });

  test("the rollback row shows current and previous with revision and age, and the exact requests", async () => {
    const { page } = await rig();
    const html = await page("/services/judicabot");
    expect(html).toContain("Previous version");
    expect(html).toContain(">3ee016f</b>");
    expect(html).toContain(">c19ab44</b>");
    expect(html).toContain("revision <span class=\"mono\">c19ab44</span>");
    expect(html).toContain("pushed 1 h ago");
    expect(html).toContain("pushed 5 h ago");
    expect(html).toContain('action="/services/judicabot/rollback"');
    expect(html).toContain('name="to" value="3ee016f"');
    expect(html).toMatch(/name="digest" value="sha256:[a-f0-9]{64}"/);
    const request = attr(html, "data-confirm-request-value").find((r) => r.includes("fromImage"))!;
    expect(request.split("\n")).toEqual([
      `POST /images/create?fromImage=${REGISTRY_HOST}/judicabot/judicabot&tag=3ee016f`,
      expect.stringMatching(/^POST \/images\/sha256:[a-f0-9]{64}\/tag\?repo=zot\.web\.example\.test\/judicabot\/judicabot&tag=c19ab44$/),
      `POST /images/${REGISTRY_HOST}/judicabot/judicabot:3ee016f/tag?repo=${REGISTRY_HOST}/judicabot/judicabot&tag=latest`,
      "cd /opt/judicabot && docker compose up -d --pull never",
    ]);
    expect(attr(html, "data-confirm-body-value").join(" ")).toContain("within 60 s");
    expect(html).not.toContain(REGISTRY_PASSWORD);
  });

  test("core services show a disabled button and no form", async () => {
    const { page } = await rig();
    const html = await page("/services/traefik");
    expect(html).toContain('disabled="" title="Needed by the panel and other services">Switch off</button>');
    expect(html).not.toContain("/services/traefik/switch");
    expect(html).not.toContain("/services/traefik/rollback");
    expect(html).toContain("Base services are updated through Ansible");
  });

  test("jenkins host services render no controls", async () => {
    const { page } = await rig();
    const html = await page("/services/jenkins");
    expect(html).not.toContain("/services/jenkins/");
    expect(html).not.toContain(">Switch off<");
    expect(html).toContain("cannot reach");
  });

  test("disabled rollback states carry their reason", async () => {
    const { page } = await rig();
    expect(await page("/services/miplata")).toContain("runs 2 images");
    expect(await page("/services/vaultwarden")).toContain("does not run an image from zot.web.example.test");
    expect(await page("/services/huella")).toContain("No container of Huella is running");
    expect(await page("/services/huella")).toContain("No container of Huella exists yet");
  });

  test("a single build in the registry disables the button with a reason", async () => {
    const { page, refresh } = await rig();
    up.zot.rows["judicabot/judicabot"] = up.zot.rows["judicabot/judicabot"]!.filter((r) => ["latest", "c19ab44"].includes(r.tag));
    await refresh();
    const html = await page("/services/judicabot");
    expect(html).toContain("Only one build is in the registry");
    expect(html).not.toContain("/services/judicabot/rollback");
  });
});

describe("switch route", () => {
  test("switches off, redirects with a flash and the page then offers Switch on", async () => {
    const { post, flashOf, withFlash, page, refresh } = await rig();
    const res = await post("/services/vaultwarden/switch", { to: "off" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/services/vaultwarden");
    expect(flashOf(res)).toMatchObject({ ok: true, text: expect.stringContaining("Vaultwarden switched off") });
    expect(up.compose.commands).toEqual([{ dir: "/opt/vaultwarden", args: ["stop"] }]);
    await refresh();
    const html = await page("/services/vaultwarden", withFlash(res));
    expect(html).toContain("Vaultwarden switched off");
    expect(html).toContain(">Switch on</button>");
    expect(html).toContain("vps-deploy starts it again");
    expect(attr(html, "data-confirm-request-value")).toContain("cd /opt/vaultwarden && docker compose up -d");
    const on = await post("/services/vaultwarden/switch", { to: "on" });
    expect(flashOf(on)).toMatchObject({ ok: true });
  });

  test("core and jenkins-host services are forbidden with 403 and nothing runs", async () => {
    const { post } = await rig();
    expect((await post("/services/traefik/switch", { to: "off" })).status).toBe(403);
    expect((await post("/services/zot/switch", { to: "off" })).status).toBe(403);
    expect((await post("/services/panel/switch", { to: "off" })).status).toBe(403);
    expect((await post("/services/dns/switch", { to: "on" })).status).toBe(403);
    expect((await post("/services/jenkins/switch", { to: "off" })).status).toBe(403);
    expect((await post("/services/jenkins/rollback", { to: "x1", digest: "sha256:" + "0".repeat(64) })).status).toBe(403);
    expect(up.compose.commands).toEqual([]);
    expect(up.docker.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("unknown service is 404, bad target is 400", async () => {
    const { post } = await rig();
    expect((await post("/services/nope/switch", { to: "off" })).status).toBe(404);
    expect((await post("/services/vaultwarden/switch", { to: "restart" })).status).toBe(400);
    expect((await post("/services/vaultwarden/switch", {})).status).toBe(400);
    expect((await post("/services/judicabot/rollback", { to: "../x", digest: "sha256:" + "0".repeat(64) })).status).toBe(400);
    expect((await post("/services/judicabot/rollback", { to: "3ee016f", digest: "nope" })).status).toBe(400);
    expect(up.compose.commands).toEqual([]);
  });

  test("needs the CSRF token and a matching Origin", async () => {
    const { post } = await rig();
    expect((await post("/services/vaultwarden/switch", { to: "off" }, ORIGIN, "wrong")).status).toBe(403);
    expect((await post("/services/vaultwarden/switch", { to: "off" }, ORIGIN, null)).status).toBe(403);
    expect((await post("/services/vaultwarden/switch", { to: "off" }, "https://evil.example.test")).status).toBe(403);
    expect((await post("/services/vaultwarden/switch", { to: "off" }, null)).status).toBe(403);
    expect(up.compose.commands).toEqual([]);
  });

  test("needs a session", async () => {
    const { app } = await rig();
    const res = await app.request("/services/vaultwarden/switch", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "to=off" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(up.compose.commands).toEqual([]);
  });

  test("a second request while one runs is busy and the page shows it", async () => {
    const { post, flashOf, page, app, cookie } = await rig();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = up.compose.run.bind(up.compose);
    up.compose.run = async (dir, args) => {
      await gate;
      return original(dir, args);
    };
    try {
      const first = post("/services/metabase/switch", { to: "off" });
      await Bun.sleep(50);
      expect(flashOf(await post("/services/metabase/switch", { to: "off" }))).toMatchObject({ ok: false, text: expect.stringContaining("still in progress") });
      expect(await page("/services/metabase")).toContain("Another action on Metabase is in progress");
      const etagBusy = (await app.request("/services/metabase", { headers: { cookie } })).headers.get("etag");
      release();
      expect((await first).status).toBe(303);
      expect((await app.request("/services/metabase", { headers: { cookie } })).headers.get("etag")).not.toBe(etagBusy);
    } finally {
      up.compose.run = original;
    }
  });
});

describe("rollback route", () => {
  test("rolls back, then the page follows the running image", async () => {
    const { post, flashOf, withFlash, page, refresh } = await rig();
    const before = await page("/services/judicabot");
    const digest = /name="digest" value="([^"]+)"/.exec(before)![1]!;
    const res = await post("/services/judicabot/rollback", { to: "3ee016f", digest });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({ ok: true, text: expect.stringContaining("now runs 3ee016f (was c19ab44)") });
    expect(up.compose.commands.at(-1)).toEqual({ dir: "/opt/judicabot", args: ["up", "-d", "--pull", "never"] });
    await refresh();
    const html = await page("/services/judicabot", withFlash(res));
    expect(html).toContain("now runs 3ee016f");
    expect(html).toContain(">32f1bd4</b>");
    expect(html).toContain("The registry&#39;s latest is c19ab44, but this service runs 3ee016f.");
  });

  test("a stale form is refused with a flash and changes nothing", async () => {
    const { post, flashOf } = await rig();
    const res = await post("/services/judicabot/rollback", { to: "6597a89", digest: "sha256:" + "1".repeat(64) });
    expect(flashOf(res)).toMatchObject({ ok: false, text: expect.stringContaining("registry changed") });
    expect(up.docker.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("audit rows are written for every attempt", async () => {
    const { post, db } = await rig();
    await post("/services/traefik/switch", { to: "off" });
    await post("/services/judicabot/rollback", { to: "6597a89", digest: "sha256:" + "1".repeat(64) });
    const rows = db.query<{ action: string; target: string; outcome: string; actor: string }, []>("SELECT action, target, outcome, actor FROM audit WHERE action LIKE 'service.%' ORDER BY id").all();
    expect(rows).toEqual([
      { action: "service.switch", target: "traefik", outcome: "rejected", actor: "owner" },
      { action: "service.rollback", target: "judicabot", outcome: "requested", actor: "owner" },
      { action: "service.rollback", target: "judicabot", outcome: "rejected", actor: "owner" },
    ]);
  });
});

describe("dry run", () => {
  test("the page says so, the post is recorded, and nothing is executed", async () => {
    const { page, post, flashOf, db } = await rig({ dryRun: true });
    expect(await page("/services/vaultwarden")).toContain("Dry run is on");
    const res = await post("/services/vaultwarden/switch", { to: "off" });
    expect(flashOf(res)).toMatchObject({ ok: true, text: expect.stringContaining("Dry run: would run `cd /opt/vaultwarden && docker compose stop`") });
    expect(up.compose.commands).toEqual([]);
    expect(up.docker.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(db.query<{ outcome: string }, []>("SELECT outcome FROM audit WHERE action LIKE 'service.%' ORDER BY id").all().map((r) => r.outcome)).toEqual(["requested", "dry-run"]);
  });
});

describe("registry down", () => {
  test("the page keeps rendering and says why rollback is unavailable", async () => {
    up.zot.failing.value = true;
    const { page } = await rig();
    up.zot.failing.value = false;
    const html = await page("/services/judicabot");
    expect(html).toContain("Zot did not answer");
    expect(html).toContain("Switch off");
  });

  test("the docker sources are registered under their usual names", async () => {
    const { store } = await rig();
    expect(store.names()).toContain(DOCKER_SOURCES.containers);
    expect(store.names()).toContain(ZOT_TAG_SOURCE);
  });
});
