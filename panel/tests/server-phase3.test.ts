import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JobActions } from "../src/actions/jobs";
import { githubClient } from "../src/auth/github";
import { JENKINS_SOURCES, jenkinsClientFromConfig, registerJenkinsSources } from "../src/collectors/jenkins";
import { LokiClient, registerLokiSources } from "../src/collectors/loki";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { TailHub } from "../src/logs/hub";
import { loadManifest } from "../src/manifest";
import { Poller } from "../src/poller";
import { createApp } from "../src/server";
import { Store } from "../src/store";
import { startFakeJenkins, type FakeJenkins } from "./dev/jenkins-fixture";
import { startFakeLoki, type FakeLoki } from "./dev/loki-fixture";

let jenkins: FakeJenkins;
let loki: FakeLoki;

beforeAll(() => {
  jenkins = startFakeJenkins({ startDelayMs: 50 });
  loki = startFakeLoki({ intervalMs: 50 });
});
afterAll(async () => {
  await jenkins.stop();
  await loki.stop();
});

const ORIGIN = "https://panel.example.test";

async function rig(jenkinsUrl = jenkins.url) {
  const cfg = loadConfig({
    PUBLIC_URL: ORIGIN,
    SERVICES_MANIFEST_PATH: "x",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_ALLOWED_LOGIN: "owner",
    SESSION_SECRET: "x".repeat(40),
    NODE_ENV: "test",
    DEV_AUTH_BYPASS: "1",
    JENKINS_URL: jenkinsUrl,
    JENKINS_USER: "admin",
    JENKINS_TOKEN: "t",
    LOKI_URL: loki.url,
  });
  const manifest = await loadManifest("tests/fixtures/dev-services.json");
  const store = new Store();
  const base = { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 15_000 };
  const client = jenkinsClientFromConfig(cfg)!;
  registerJenkinsSources(store, client, base);
  const lokiClient = new LokiClient(loki.url, { timeoutMs: 1000 });
  registerLokiSources(store, lokiClient, base);
  await store.refresh(JENKINS_SOURCES.jobs);
  await store.refresh("loki:targets").catch(() => {});
  const db = openDb(":memory:");
  const knownJobs = () => new Set(manifest.services.flatMap((s) => (s.jenkins_job ? [s.jenkins_job] : [])));
  const actions = new JobActions({ client, db, knownJobs, store, pollMs: 20, verifyTimeoutMs: 3000 });
  const hub = new TailHub(lokiClient, { backoffBaseMs: 20, backoffMaxMs: 50 });
  const poller = new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 });
  const app = createApp({ cfg, db, store, gh: githubClient(cfg), lagMs: () => 0, manifest, poller, jenkins: { client, actions, knownJobs }, loki: { client: lokiClient, hub } });
  const res = await app.request("/auth/dev?next=/");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = await (await app.request("/jobs", { headers: { cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
  const post = (path: string, body = `_csrf=${csrf}`, origin: string | null = ORIGIN) =>
    app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      body,
    });
  return { app, db, store, hub, cookie, csrf, post };
}

describe("jobs routes", () => {
  test("pages render the running build, queue and rail count from Jenkins", async () => {
    const { app, cookie } = await rig();
    const jobs = await (await app.request("/jobs", { headers: { cookie } })).text();
    expect(jobs).toContain("vps-deploy");
    expect(jobs).toContain("Waiting for next available executor");
    expect(jobs).toContain('data-rail="jobs">1<');
    const overview = await (await app.request("/", { headers: { cookie } })).text();
    expect(overview).toContain("Building now");
    expect(overview).toContain("vps-deploy");
    const builds = await (await app.request("/services/judicabot?tab=builds", { headers: { cookie } })).text();
    expect(builds).toContain("Run now");
  });

  test("run now needs origin and csrf, triggers the fake, audits, and flashes the result", async () => {
    const { post, db, app, cookie } = await rig();
    expect((await post("/jobs/miplata-deploy/build", undefined, null)).status).toBe(403);
    expect((await post("/jobs/miplata-deploy/build", "_csrf=bad")).status).toBe(403);
    const before = jenkins.requests.filter((r) => r.method === "POST").length;
    const res = await post("/jobs/miplata-deploy/build");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/jobs\?job=miplata-deploy&build=\d+$/);
    expect(jenkins.requests.filter((r) => r.method === "POST").length).toBe(before + 1);
    const rows = db.query<{ outcome: string }, []>("SELECT outcome FROM audit WHERE action = 'jenkins.build' ORDER BY id").all().map((r) => r.outcome);
    expect(rows).toEqual(["requested", "verified"]);
    const flashCookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await app.request(res.headers.get("location")!, { headers: { cookie: `${cookie}; ${flashCookie}` } })).text();
    expect(page).toMatch(/build #\d+ started/);
  });

  test("an unknown job is rejected without touching Jenkins", async () => {
    const { post, db } = await rig();
    const before = jenkins.requests.filter((r) => r.method === "POST").length;
    const res = await post("/jobs/not-a-job/build");
    expect(res.status).toBe(303);
    expect(jenkins.requests.filter((r) => r.method === "POST").length).toBe(before);
    expect(db.query<{ outcome: string }, []>("SELECT outcome FROM audit WHERE target = 'not-a-job' ORDER BY id DESC").get()?.outcome).toBe("rejected");
  });

  test("stop aborts a running build and verifies it", async () => {
    const { post, db } = await rig();
    const res = await post("/jobs/vps-deploy/39/stop");
    expect(res.status).toBe(303);
    const last = db.query<{ outcome: string }, []>("SELECT outcome FROM audit WHERE action = 'jenkins.stop' ORDER BY id DESC").get();
    expect(last?.outcome).toBe("verified");
    expect((await post("/jobs/vps-deploy/abc/stop")).status).toBe(400);
  });

  test("console proxies bounded chunks with the offset headers and needs a session", async () => {
    const { app, cookie } = await rig();
    expect((await app.request("/jobs/vps-deploy/38/console")).status).toBe(401);
    const res = await app.request("/jobs/vps-deploy/38/console?start=0", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("x-text-size"))).toBeGreaterThan(0);
    expect(res.headers.get("x-more-data")).toBeNull();
    expect((await res.text()).includes("Finished:")).toBe(true);
    expect((await app.request("/jobs/nope/1/console", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/jobs/vps-deploy/1/console?start=-1", { headers: { cookie } })).status).toBe(400);
  });

  test("a dead Jenkins leaves every other page up with a stale or error note", async () => {
    const { app, cookie } = await rig("http://127.0.0.1:9");
    for (const p of ["/", "/hosts/vps", "/services", "/services/judicabot?tab=builds", "/jobs"]) {
      const res = await app.request(p, { headers: { cookie } });
      expect(res.status).toBe(200);
    }
    const jobs = await (await app.request("/jobs", { headers: { cookie } })).text();
    expect(jobs).toContain("Jenkins is not answering");
  });
});

describe("logs routes", () => {
  test("stream needs a session and rejects bad filters", async () => {
    const { app, cookie } = await rig();
    expect((await app.request("/logs/stream")).status).toBe(401);
    expect((await app.request("/logs/stream?container=a%22b", { headers: { cookie } })).status).toBe(400);
  });

  test("stream sends backlog then live lines", async () => {
    const { app, cookie, hub } = await rig();
    const ac = new AbortController();
    const res = await app.request("/logs/stream?host=vps&container=traefik", { headers: { cookie }, signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    const until = Date.now() + 4000;
    while (Date.now() < until && !(text.includes("event: ready") && text.includes("event: lines"))) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("event: backlog");
    expect(text).toContain("event: lines");
    ac.abort();
    await reader.cancel().catch(() => {});
    await Bun.sleep(100);
    expect(hub.stats().subscribers).toBe(0);
    hub.closeAll();
  });

  test("with Loki down the page renders and the stream reports a reconnecting state", async () => {
    const { app, cookie, hub } = await rig();
    loki.setDown(true);
    try {
      expect((await app.request("/logs", { headers: { cookie } })).status).toBe(200);
      const ac = new AbortController();
      const res = await app.request("/logs/stream", { headers: { cookie }, signal: ac.signal });
      const reader = res.body!.getReader();
      let text = "";
      const until = Date.now() + 4000;
      while (Date.now() < until && !text.includes("reconnecting")) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain('"state":"reconnecting"');
      ac.abort();
      await reader.cancel().catch(() => {});
    } finally {
      loki.setDown(false);
      hub.closeAll();
    }
  });
});
