import { describe, expect, test } from "bun:test";
import { githubClient } from "../src/auth/github";
import { isFresh, reauthHref } from "../src/auth/session";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Poller } from "../src/poller";
import { createApp } from "../src/server";
import { Store } from "../src/store";
import { manifest } from "./views-fixtures";

const base = {
  PUBLIC_URL: "https://panel.example.test",
  SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
};

function rig(login = "Owner") {
  const cfg = loadConfig(base);
  const db = openDb(":memory:");
  const store = new Store();
  const app = createApp({
    cfg,
    db,
    store,
    gh: { loginForCode: async () => ({ login, id: 1 }) },
    lagMs: () => 0,
    manifest,
    poller: new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 }),
  });
  const cookies = (res: Response) => Object.fromEntries((res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!.split("=") as [string, string]));
  async function signIn(existing?: string, next?: string) {
    const start = await app.request(`/auth/github${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`);
    const sc = cookies(start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const jar = [`vp_oauth_state=${sc.vp_oauth_state}`, ...(sc.vp_oauth_next ? [`vp_oauth_next=${sc.vp_oauth_next}`] : []), ...(existing ? [existing] : [])].join("; ");
    const cb = await app.request(`/auth/github/callback?code=c&state=${state}`, { headers: { cookie: jar } });
    return { start, cb, session: cookies(cb).vp_session };
  }
  return { app, db, cfg, signIn };
}

describe("freshness", () => {
  const cfg = { SECRETS_REAUTH_SECONDS: 900 };
  test("is true strictly inside the window and false at and after it", () => {
    expect(isFresh(1000, cfg, 1000)).toBe(true);
    expect(isFresh(1000, cfg, 1000 + 899_999)).toBe(true);
    expect(isFresh(1000, cfg, 1000 + 900_000)).toBe(false);
    expect(isFresh(1000, cfg, 1000 + 3_600_000)).toBe(false);
  });

  test("the way back goes through the dev login in dev and GitHub otherwise, carrying the return path", () => {
    expect(reauthHref({ devAuthBypass: true }, "/services/a?tab=auth")).toBe("/auth/dev?next=%2Fservices%2Fa%3Ftab%3Dauth");
    expect(reauthHref({ devAuthBypass: false }, "/services/a?tab=auth")).toBe("/auth/github?next=%2Fservices%2Fa%3Ftab%3Dauth");
  });

  test("the limit is configurable", () => {
    expect(loadConfig({ ...base, SECRETS_REAUTH_SECONDS: "60" }).SECRETS_REAUTH_SECONDS).toBe(60);
    expect(loadConfig(base).SECRETS_REAUTH_SECONDS).toBe(900);
    expect(() => loadConfig({ ...base, SECRETS_REAUTH_SECONDS: "0" })).toThrow(/SECRETS_REAUTH_SECONDS/);
  });
});

describe("re-authentication through GitHub", () => {
  test("a first sign-in without a return path lands on the overview", async () => {
    const { signIn } = rig();
    const { cb } = await signIn();
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe("/");
  });

  test("the return path survives the round trip and is where the sign-in ends", async () => {
    const { start, cb } = await rig().signIn(undefined, "/services/decabot?tab=auth");
    expect(start.headers.get("set-cookie")).toContain("vp_oauth_next=");
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe("/services/decabot?tab=auth");
  });

  test("a stale session is refreshed in place: same session, newer reauth_at, no second session", async () => {
    const { signIn, db } = rig();
    const first = await signIn();
    const cookie = `vp_session=${first.session}`;
    db.query("UPDATE sessions SET reauth_at = ?").run(Date.now() - 3_600_000);
    const stale = (db.query("SELECT reauth_at AS t FROM sessions").get() as { t: number }).t;
    const again = await signIn(cookie, "/services/decabot?tab=auth");
    expect(again.cb.headers.get("location")).toBe("/services/decabot?tab=auth");
    expect(again.session).toBeUndefined();
    const rows = db.query("SELECT reauth_at AS t FROM sessions").all() as { t: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.t).toBeGreaterThan(stale + 3_000_000);
    expect(db.query("SELECT outcome FROM audit WHERE action = 'login' ORDER BY id").all()).toEqual([{ outcome: "ok" }, { outcome: "reauth" }]);
  });

  test("return paths that leave the site are replaced by the overview", async () => {
    for (const bad of ["https://evil.test/", "//evil.test/x", "javascript:alert(1)", "services", "\\\\evil.test"]) {
      const { signIn } = rig();
      const { cb } = await signIn(undefined, bad);
      expect(cb.headers.get("location")).toBe("/");
    }
  });

  test("the return-path cookie is scoped to the OAuth routes and is cleared after use", async () => {
    const { signIn } = rig();
    const { start, cb } = await signIn(undefined, "/jobs");
    const set = start.headers.getSetCookie().find((c) => c.startsWith("vp_oauth_next="))!;
    expect(set).toContain("Path=/auth/github");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(cb.headers.getSetCookie().find((c) => c.startsWith("vp_oauth_next="))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  test("a different login never refreshes someone else's session", async () => {
    const r = rig("Owner");
    const first = await r.signIn();
    const cookie = `vp_session=${first.session}`;
    const other = createApp({
      cfg: r.cfg,
      db: r.db,
      store: new Store(),
      gh: { loginForCode: async () => ({ login: "intruder", id: 2 }) },
      lagMs: () => 0,
      manifest,
      poller: new Poller(new Store(), { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 }),
    });
    const start = await other.request("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("vp_oauth_state="))!.split(";")[0]!;
    const cb = await other.request(`/auth/github/callback?code=c&state=${state}`, { headers: { cookie: `${stateCookie}; ${cookie}` } });
    expect(cb.status).toBe(403);
  });
});

describe("the GitHub client is untouched", () => {
  test("still exchanges codes through the injected fetch", async () => {
    const cfg = loadConfig(base);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return Response.json(String(url).includes("access_token") ? { access_token: "t" } : { login: "owner", id: 1 });
    }) as unknown as typeof fetch;
    expect(await githubClient(cfg, fetchImpl).loginForCode("c")).toEqual({ login: "owner", id: 1 });
    expect(calls).toHaveLength(2);
  });
});
