import { describe, expect, test } from "bun:test";
import { localPath } from "../src/auth/dev";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Poller } from "../src/poller";
import { createApp } from "../src/server";
import { Store } from "../src/store";
import { manifest } from "./views-fixtures";

const ORIGIN = "https://panel.example.test";
const HOST = "panel.example.test";

const base = {
  PUBLIC_URL: ORIGIN,
  SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
};

function rig(extra: Record<string, string> = {}) {
  const cfg = loadConfig({ ...base, ...extra });
  const store = new Store();
  const app = createApp({
    cfg,
    db: openDb(":memory:"),
    store,
    gh: { loginForCode: async () => ({ login: "owner", id: 1 }) },
    lagMs: () => 0,
    manifest,
    poller: new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 }),
  });
  const cookies = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0]!.split("=") as [string, string]));
  async function githubLocation(rawNextQuery: string): Promise<string> {
    const start = await app.request(`/auth/github?next=${rawNextQuery}`);
    const sc = cookies(start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const jar = [`vp_oauth_state=${sc.vp_oauth_state}`, ...(sc.vp_oauth_next ? [`vp_oauth_next=${sc.vp_oauth_next}`] : [])].join("; ");
    const cb = await app.request(`/auth/github/callback?code=c&state=${state}`, { headers: { cookie: jar } });
    expect(cb.status).toBe(303);
    return cb.headers.get("location")!;
  }
  const devLocation = async (rawNextQuery: string) => {
    const res = await app.request(`/auth/dev?next=${rawNextQuery}`);
    expect(res.status).toBe(303);
    return res.headers.get("location")!;
  };
  return { githubLocation, devLocation };
}

const COLLAPSING = [
  "/.//x",
  "/.//evil.example",
  `/.//${HOST}//evil.example`,
  "/%2e//x",
  "/%2E//x",
  "/a/..//x",
  "/..//x",
  "/./\t/x",
  "/.\t/\n/x",
  "/.//\\x",
  "/./\\x",
];

const DIRECT = ["//x", "//evil.example/x", "/\\x", "/\\\\x", "/\t/x", "/\n/x", "/\r\n/x", "\\/x", "https://evil.example/", `//${HOST}//evil.example`];

const isSafe = (loc: string) => !loc.startsWith("//") && !loc.startsWith("/\\") && new URL(loc, ORIGIN).origin === ORIGIN;

describe("localPath", () => {
  test("falls back to the overview for every path whose final form is protocol-relative", () => {
    for (const bad of [...COLLAPSING, ...DIRECT]) expect(localPath(bad, ORIGIN)).toBe("/");
  });

  test("keeps genuine local paths, queries included", () => {
    expect(localPath("/services/judicabot?tab=auth#x", ORIGIN)).toBe("/services/judicabot?tab=auth");
    expect(localPath("/hosts/vps?metric=cpu", ORIGIN)).toBe("/hosts/vps?metric=cpu");
    expect(localPath("/./a/../services", ORIGIN)).toBe("/services");
    expect(localPath("/%2F%2Fx", ORIGIN)).toBe("/%2F%2Fx");
    expect(localPath(undefined, ORIGIN)).toBe("/");
    expect(localPath("services", ORIGIN)).toBe("/");
  });
});

describe("open redirect through the production sign-in flow", () => {
  test("a next path that collapses to //host is replaced by the overview", async () => {
    for (const bad of COLLAPSING) {
      const loc = await rig().githubLocation(encodeURIComponent(bad));
      expect({ bad, loc }).toEqual({ bad, loc: "/" });
    }
  });

  test("direct protocol-relative and absolute forms are replaced by the overview", async () => {
    for (const bad of DIRECT) {
      const loc = await rig().githubLocation(encodeURIComponent(bad));
      expect({ bad, loc }).toEqual({ bad, loc: "/" });
    }
  });

  test("a percent-encoded double slash arrives as a safe local path or the overview, never as //", async () => {
    for (const raw of ["/%2F%2Fx", encodeURIComponent("/%2F%2Fx"), "%2F%2Fx", "/%252F%252Fx"]) {
      const loc = await rig().githubLocation(raw);
      expect({ raw, safe: isSafe(loc) }).toEqual({ raw, safe: true });
    }
  });

  test("a genuine return path still round-trips", async () => {
    expect(await rig().githubLocation(encodeURIComponent("/services/decabot?tab=auth"))).toBe("/services/decabot?tab=auth");
  });
});

describe("open redirect through the dev login", () => {
  const dev = () => rig({ DEV_AUTH_BYPASS: "1", NODE_ENV: "test" });

  test("a next path that collapses to //host is replaced by the overview", async () => {
    const r = dev();
    for (const bad of [...COLLAPSING, ...DIRECT]) {
      const loc = await r.devLocation(encodeURIComponent(bad));
      expect({ bad, loc }).toEqual({ bad, loc: "/" });
    }
  });

  test("a percent-encoded double slash arrives as a safe local path or the overview, never as //", async () => {
    const r = dev();
    for (const raw of ["/%2F%2Fx", encodeURIComponent("/%2F%2Fx"), "%2F%2Fx", "/%252F%252Fx"]) {
      const loc = await r.devLocation(raw);
      expect({ raw, safe: isSafe(loc) }).toEqual({ raw, safe: true });
    }
  });

  test("a genuine return path still works", async () => {
    expect(await dev().devLocation(encodeURIComponent("/hosts/vps?metric=cpu"))).toBe("/hosts/vps?metric=cpu");
  });
});
