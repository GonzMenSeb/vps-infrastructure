import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { githubClient } from "../src/auth/github";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { SESSION_TOUCH_EVERY_MS } from "../src/auth/session";
import { Poller } from "../src/poller";
import { createApp, type Deps } from "../src/server";
import { Store } from "../src/store";
import { manifest } from "./views-fixtures";

const env = {
  PUBLIC_URL: "https://panel.example.test",
  SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
};

const pollerOpts = { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 };

function deps(o: Partial<Deps> = {}): Deps {
  const cfg = o.cfg ?? loadConfig(env);
  const store = o.store ?? new Store();
  return {
    cfg,
    db: openDb(":memory:"),
    store,
    gh: githubClient(cfg),
    lagMs: () => 0,
    manifest,
    poller: new Poller(store, pollerOpts),
    ...o,
  };
}

function setup(lag = 0) {
  const d = deps({ lagMs: () => lag });
  const app = createApp(d);
  return { app, db: d.db as Database, cfg: d.cfg, store: d.store };
}

describe("config", () => {
  test("rejects missing and short secrets", () => {
    expect(() => loadConfig({ ...env, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({})).toThrow(/invalid configuration/);
  });
});

describe("app", () => {
  test("healthz is ok and unauthenticated", async () => {
    const { app } = setup();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  test("healthz fails on event loop lag", async () => {
    const { app } = setup(10_000);
    expect((await app.request("/healthz")).status).toBe(503);
  });

  test("healthz fails when a snapshot poller stopped", async () => {
    const { app, store } = setup();
    store.register("p", async () => 1, { ttlMs: 1, timeoutMs: 50, failureThreshold: 1, cooldownMs: 1 });
    await store.refresh("p");
    const real = Date.now;
    Date.now = () => real() + 10 * 60_000;
    try {
      expect((await app.request("/healthz")).status).toBe(503);
    } finally {
      Date.now = real;
    }
  });

  test("anonymous visitors are redirected to login", async () => {
    const { app } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("oauth start sets a Lax state cookie and redirects to github", async () => {
    const { app } = setup();
    const res = await app.request("/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("https://github.com/login/oauth/authorize");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("HttpOnly");
  });

  test("callback with a forged state is rejected", async () => {
    const { app } = setup();
    const res = await app.request("/auth/github/callback?code=c&state=forged", {
      headers: { cookie: "vp_oauth_state=forged.deadbeef" },
    });
    expect(res.status).toBe(400);
  });

  test("callback only admits the allowed login", async () => {
    const d = deps({ gh: { loginForCode: async () => ({ login: "intruder", id: 2 }) } });
    const db = d.db;
    const app = createApp(d);
    const start = await app.request("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const signedCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { cookie: signedCookie },
    });
    expect(res.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  async function login() {
    const d = deps({ gh: { loginForCode: async () => ({ login: "Owner", id: 1 }) } });
    const db = d.db;
    const app = createApp(d);
    const start = await app.request("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const cb = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { cookie: stateCookie },
    });
    const session = (cb.headers.get("set-cookie") ?? "").split(",").map((c) => c.trim()).find((c) => c.startsWith("vp_session="))!;
    return { app, db, cookie: session.split(";")[0]!, cb };
  }

  test("owner login creates a session and reaches the overview", async () => {
    const { app, cookie, cb } = await login();
    expect(cb.status).toBe(303);
    expect(cb.headers.get("set-cookie")).toContain("SameSite=Lax");
    const res = await app.request("/", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Overview");
  });

  test("session last-seen is written at most once a minute", async () => {
    const { app, db, cookie } = await login();
    const seen = () => (db.query("SELECT last_seen_at AS t FROM sessions").get() as { t: number }).t;
    const first = seen();
    const real = Date.now;
    try {
      Date.now = () => first + 30_000;
      expect((await app.request("/", { headers: { cookie } })).status).toBe(200);
      expect(seen()).toBe(first);
      Date.now = () => first + SESSION_TOUCH_EVERY_MS;
      await app.request("/", { headers: { cookie } });
      expect(seen()).toBe(first + SESSION_TOUCH_EVERY_MS);
    } finally {
      Date.now = real;
    }
  });

  test("POST requires matching Origin and a CSRF token", async () => {
    const { app, cookie } = await login();
    const page = await (await app.request("/", { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
    const form = (token: string) => new URLSearchParams({ _csrf: token }).toString();
    const post = (origin: string | null, token: string) =>
      app.request("/logout", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          ...(origin ? { origin } : {}),
        },
        body: form(token),
      });

    expect((await post(null, csrf)).status).toBe(403);
    expect((await post("https://evil.test", csrf)).status).toBe(403);
    expect((await post("https://panel.example.test", "wrong")).status).toBe(403);
    const ok = await post("https://panel.example.test", csrf);
    expect(ok.status).toBe(303);
    expect((await app.request("/", { headers: { cookie } })).status).toBe(303);
  });

  test("security headers include a strict CSP", async () => {
    const { app } = setup();
    const res = await app.request("/login");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
