import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubClient, type GithubClient } from "../src/auth/github";
import { configWarnings, loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Poller } from "../src/poller";
import { createApp, start, type Running } from "../src/server";
import { Store } from "../src/store";
import { startFixtureUpstreams, type FixtureUpstreams } from "./dev/fixture-upstreams";
import { manifest } from "./views-fixtures";

const OWNER_ID = 88598670;

const base = {
  PUBLIC_URL: "https://panel.example.test",
  SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
};

function rig(user: { login: string; id: number }, extra: Record<string, string> = {}) {
  const cfg = loadConfig({ ...base, ...extra });
  const db = openDb(":memory:");
  const store = new Store();
  const gh = { loginForCode: async () => user } as unknown as GithubClient;
  const app = createApp({
    cfg,
    db,
    store,
    gh,
    lagMs: () => 0,
    manifest,
    poller: new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 }),
  });
  async function callback() {
    const start = await app.request("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("vp_oauth_state="))!.split(";")[0]!;
    return app.request(`/auth/github/callback?code=c&state=${state}`, { headers: { cookie: stateCookie } });
  }
  const sessions = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n;
  const audits = () => db.query<{ actor: string; outcome: string; detail: string | null }, []>("SELECT actor, outcome, detail FROM audit WHERE action = 'login' ORDER BY id").all();
  return { callback, sessions, audits, db };
}

describe("GITHUB_ALLOWED_ID configuration", () => {
  test("is optional, blank counts as unset, and is a positive integer when given", () => {
    expect(loadConfig(base).GITHUB_ALLOWED_ID).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_ALLOWED_ID: "" }).GITHUB_ALLOWED_ID).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_ALLOWED_ID: String(OWNER_ID) }).GITHUB_ALLOWED_ID).toBe(OWNER_ID);
    for (const bad of ["abc", "0", "-5", "1.5"]) expect(() => loadConfig({ ...base, GITHUB_ALLOWED_ID: bad })).toThrow(/GITHUB_ALLOWED_ID/);
  });

  test("an unset id produces one startup warning and a set id none", () => {
    expect(configWarnings(loadConfig(base))).toEqual([expect.stringContaining("GITHUB_ALLOWED_ID")]);
    expect(configWarnings(loadConfig({ ...base, GITHUB_ALLOWED_ID: String(OWNER_ID) }))).toEqual([]);
  });
});

describe("the GitHub client", () => {
  test("returns the login and the numeric account id", async () => {
    const fetchImpl = (async (url: string) => Response.json(String(url).includes("access_token") ? { access_token: "t" } : { login: "owner", id: OWNER_ID })) as unknown as typeof fetch;
    expect(await githubClient(loadConfig(base), fetchImpl).loginForCode("c")).toEqual({ login: "owner", id: OWNER_ID });
  });

  test("a user lookup without a numeric id is an error", async () => {
    const fetchImpl = (async (url: string) => Response.json(String(url).includes("access_token") ? { access_token: "t" } : { login: "owner" })) as unknown as typeof fetch;
    await expect(githubClient(loadConfig(base), fetchImpl).loginForCode("c")).rejects.toThrow("user lookup failed");
  });
});

describe("allowlist", () => {
  const pinned = { GITHUB_ALLOWED_ID: String(OWNER_ID) };

  test("with the id pinned, the allowed login with the matching id signs in", async () => {
    const r = rig({ login: "Owner", id: OWNER_ID }, pinned);
    expect((await r.callback()).status).toBe(303);
    expect(r.sessions()).toBe(1);
  });

  test("with the id pinned, the allowed login with another id is refused and audited", async () => {
    const r = rig({ login: "owner", id: OWNER_ID + 1 }, pinned);
    const res = await r.callback();
    expect(res.status).toBe(403);
    expect(r.sessions()).toBe(0);
    expect(r.audits()).toEqual([{ actor: "owner", outcome: "denied", detail: expect.stringContaining("id") }]);
  });

  test("with the id pinned, the allowed id under another login is refused", async () => {
    const r = rig({ login: "renamed", id: OWNER_ID }, pinned);
    expect((await r.callback()).status).toBe(403);
    expect(r.sessions()).toBe(0);
  });

  test("without a pinned id the login alone decides, as before", async () => {
    const ok = rig({ login: "OWNER", id: 7 });
    expect((await ok.callback()).status).toBe(303);
    const no = rig({ login: "intruder", id: 7 });
    expect((await no.callback()).status).toBe(403);
  });
});

describe("denied logins are bounded", () => {
  test("the denied rows are trimmed whatever logins they come under, and other rows survive", async () => {
    const cfg = loadConfig({ ...base, AUDIT_ANON_MAX_ROWS: "5" });
    const db = openDb(":memory:");
    db.query("INSERT INTO audit (ts, actor, action, outcome) VALUES (1, 'owner', 'service.switch', 'verified')").run();
    let who = "";
    const store = new Store();
    const app = createApp({
      cfg,
      db,
      store,
      gh: { loginForCode: async () => ({ login: who, id: 1 }) } as unknown as GithubClient,
      lagMs: () => 0,
      manifest,
      poller: new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 }),
    });
    for (let i = 0; i < 20; i++) {
      who = `intruder-${i}`;
      const start = await app.request("/auth/github");
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("vp_oauth_state="))!.split(";")[0]!;
      expect((await app.request(`/auth/github/callback?code=c&state=${state}`, { headers: { cookie: stateCookie } })).status).toBe(403);
    }
    const denied = db.query<{ actor: string }, []>("SELECT actor FROM audit WHERE action = 'login' AND outcome = 'denied' ORDER BY id").all();
    expect(denied.map((d) => d.actor)).toEqual(["intruder-15", "intruder-16", "intruder-17", "intruder-18", "intruder-19"]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit WHERE action = 'service.switch'").get()!.n).toBe(1);
  });
});

describe("startup", () => {
  let up: FixtureUpstreams;
  let running: Running | null = null;
  let dataDir = "";
  afterEach(async () => {
    await running?.stop();
    await up?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    running = null;
  });

  async function freePort(): Promise<number> {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = s.port!;
    await s.stop(true);
    return port;
  }

  async function boot(extra: Record<string, string>) {
    const port = await freePort();
    up = await startFixtureUpstreams({ healthDelayMs: 0 });
    dataDir = mkdtempSync(join(tmpdir(), "vesp-allow-"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      running = await start({
        NODE_ENV: "test",
        DEV_AUTH_BYPASS: "1",
        PUBLIC_URL: `http://localhost:${port}`,
        PORT: String(port),
        DATA_DIR: dataDir,
        SERVICES_MANIFEST_PATH: "tests/fixtures/dev-services.json",
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_ALLOWED_LOGIN: "owner",
        SESSION_SECRET: "x".repeat(40),
        PROMETHEUS_URL: up.promUrl,
        DOCKER_SOCKET: up.dockerSocket,
        ...extra,
      });
      return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("GITHUB_ALLOWED_ID"));
    } finally {
      warn.mockRestore();
    }
  }

  test("start() warns once when no id is pinned", async () => {
    expect(await boot({})).toHaveLength(1);
  });

  test("start() stays quiet when the id is pinned", async () => {
    expect(await boot({ GITHUB_ALLOWED_ID: String(OWNER_ID) })).toEqual([]);
  });
});
