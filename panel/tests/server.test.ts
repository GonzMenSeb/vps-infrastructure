import { describe, expect, setSystemTime, test } from "bun:test";
import { localPath } from "../src/auth/dev";
import { githubClient } from "../src/auth/github";
import { DOCKER_SOURCES } from "../src/collectors/docker";
import { PROM_SOURCES, type AgentHost } from "../src/collectors/prometheus";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Poller } from "../src/poller";
import { createApp, etagMatches } from "../src/server";
import { Store } from "../src/store";
import { agentHost, containers, df, docker, hosts, manifest, series } from "./views-fixtures";

const env = {
  PUBLIC_URL: "https://panel.example.test",
  SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
};

const opts = { ttlMs: 15_000, timeoutMs: 100, failureThreshold: 3, cooldownMs: 15_000 };

async function rig(extra: Record<string, string> = { DEV_AUTH_BYPASS: "1", NODE_ENV: "test" }, agent?: AgentHost[]) {
  const cfg = loadConfig({ ...env, ...extra });
  const store = new Store();
  const calls = { n: 0 };
  const data: Record<string, unknown> = {
    [PROM_SOURCES.hosts]: hosts,
    [PROM_SOURCES.containers]: containers,
    [PROM_SOURCES.series]: series,
    [DOCKER_SOURCES.containers]: docker,
    [DOCKER_SOURCES.df]: df,
    ...(agent ? { [PROM_SOURCES.agent]: agent } : {}),
  };
  const fail = new Set<string>();
  for (const name of Object.keys(data)) {
    store.register(
      name,
      async () => {
        calls.n++;
        if (fail.has(name)) throw new Error(`${name} down`);
        return data[name];
      },
      opts,
    );
    await store.refresh(name);
  }
  calls.n = 0;
  const poller = new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 });
  const db = openDb(":memory:");
  const app = createApp({ cfg, db, store, gh: githubClient(cfg), lagMs: () => 0, manifest, poller });
  return { app, db, store, poller, calls, data, fail };
}

async function signIn(app: Awaited<ReturnType<typeof rig>>["app"]) {
  const res = await app.request("/auth/dev?next=/services");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/services");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).toStartWith("vp_session=");
  return cookie;
}

const PAGES = [
  "/",
  "/hosts/vps",
  "/hosts/jenkins?metric=cpu",
  "/hosts/w1",
  "/hosts/w1?metric=disk",
  "/hosts/vps?metric=disk",
  "/services",
  ...manifest.services.flatMap((s) => ["summary", "config", "auth", "builds", "db"].map((t) => `/services/${s.id}?tab=${t}`)),
];

describe("pages", () => {
  test("every page renders from the snapshot cache without calling an upstream", async () => {
    const { app, calls } = await rig();
    const cookie = await signIn(app);
    for (const path of PAGES) {
      const page = await app.request(path, { headers: { cookie } });
      expect(page.status).toBe(200);
      const full = await page.text();
      expect(full).toStartWith("<!doctype html>");
      const csrf = /name="_csrf" value="([^"]+)"/.exec(full)![1]!;
      const frame = await app.request(path, { headers: { cookie, "turbo-frame": "live" } });
      expect(frame.status).toBe(200);
      const body = await frame.text();
      expect(body).toStartWith('<turbo-frame id="live"');
      expect(body).not.toContain("<html");
      expect(body).not.toContain(csrf);

    }
    expect(calls.n).toBe(0);
  });

  test("pages and fragments sit behind the session", async () => {
    const { app } = await rig();
    for (const path of ["/", "/hosts/vps", "/services", "/services/traefik", "/hosts"]) {
      const res = await app.request(path, { headers: { "turbo-frame": "live" } });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
    }
  });

  test("unknown hosts and services are 404, and /hosts redirects", async () => {
    const { app } = await rig();
    const cookie = await signIn(app);
    expect((await app.request("/hosts/nope", { headers: { cookie } })).status).toBe(404);
    expect((await app.request("/services/nope", { headers: { cookie } })).status).toBe(404);
    const r = await app.request("/hosts", { headers: { cookie } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/hosts/vps");
    const q = await app.request("/hosts?host=jenkins&metric=cpu", { headers: { cookie } });
    expect(q.headers.get("location")).toBe("/hosts/jenkins?metric=cpu");
    expect((await app.request("/hosts/w1", { headers: { cookie } })).status).toBe(200);
    const w = await app.request("/hosts?host=w1", { headers: { cookie } });
    expect(w.headers.get("location")).toBe("/hosts/w1");
  });

  test("ETag answers 304 until the snapshot changes", async () => {
    const { app, store, data } = await rig();
    const cookie = await signIn(app);
    const first = await app.request("/", { headers: { cookie } });
    const etag = first.headers.get("etag")!;
    expect(etag).toStartWith('W/"');
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("Turbo-Frame");
    const again = await app.request("/", { headers: { cookie, "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(etagMatches(`"x", ${etag.slice(2)}`, etag)).toBe(true);

    const frame = await app.request("/", { headers: { cookie, "turbo-frame": "live", "if-none-match": etag } });
    expect(frame.status).toBe(200);
    expect(frame.headers.get("etag")).not.toBe(etag);

    data[DOCKER_SOURCES.containers] = docker.map((c) => (c.name === "judicabot" ? { ...c, state: "exited", status: "Exited (1) 1 second ago" } : c));
    await store.refresh(DOCKER_SOURCES.containers);
    const changed = await app.request("/", { headers: { cookie, "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  test("unchanged data under a new fetch still answers 304, an upstream error does not", async () => {
    const { app, store, fail } = await rig();
    const cookie = await signIn(app);
    const etag = (await app.request("/services", { headers: { cookie } })).headers.get("etag")!;
    await store.refresh(DOCKER_SOURCES.containers);
    expect((await app.request("/services", { headers: { cookie, "if-none-match": etag } })).status).toBe(304);
    fail.add(DOCKER_SOURCES.containers);
    await store.refresh(DOCKER_SOURCES.containers);
    const res = await app.request("/services", { headers: { cookie, "if-none-match": etag } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Stale");
  });

  test("the series only affects the hosts page ETag", async () => {
    const { app, store, data } = await rig();
    const cookie = await signIn(app);
    const tags = async () =>
      Promise.all(["/", "/hosts/vps"].map(async (p) => (await app.request(p, { headers: { cookie } })).headers.get("etag")));
    const [o1, h1] = await tags();
    data[PROM_SOURCES.series] = series.map((s) => ({ ...s, cpu: s.cpu.map((v) => v + 1) }));
    await store.refresh(PROM_SOURCES.series);
    const [o2, h2] = await tags();
    expect(o2).toBe(o1);
    expect(h2).not.toBe(h1);
  });

  describe("agent host", () => {
    const live = () => agentHost({ runTimestampSec: Date.now() / 1000 - 30 });
    const sick = () => agentHost({ runTimestampSec: Date.now() / 1000 - 30, settings: [{ id: "zswap", ok: false }] });

    test("w1 shows the section from the cache, other hosts and the overview follow the same data", async () => {
      const { app, calls } = await rig(undefined, [sick()]);
      const cookie = await signIn(app);
      const w1 = await (await app.request("/hosts/w1", { headers: { cookie } })).text();
      expect(w1).toContain('aria-label="Agent host"');
      expect(w1).toContain("0 of 1 settings in place");
      expect(w1).toContain("Last report 30 s ago");
      for (const host of ["vps", "jenkins"]) {
        expect(await (await app.request(`/hosts/${host}`, { headers: { cookie } })).text()).not.toContain("Agent host");
      }
      const overview = await (await app.request("/", { headers: { cookie } })).text();
      expect(overview).toContain("1 setting is out of place on w1");
      expect(calls.n).toBe(0);
    });

    test("without the source registered nothing changes on w1", async () => {
      const { app } = await rig();
      const cookie = await signIn(app);
      const w1 = await (await app.request("/hosts/w1", { headers: { cookie } })).text();
      expect(w1).not.toContain("Agent host");
    });

    test("the agent data moves the hosts and overview ETags, not the services page", async () => {
      const { app, store, data } = await rig(undefined, [live()]);
      const cookie = await signIn(app);
      const tags = async () =>
        Promise.all(["/", "/hosts/w1", "/services"].map(async (p) => (await app.request(p, { headers: { cookie } })).headers.get("etag")));
      const [o1, h1, s1] = await tags();
      data[PROM_SOURCES.agent] = [{ ...live(), tcpEstablished: 99 }];
      await store.refresh(PROM_SOURCES.agent);
      const [o2, h2, s2] = await tags();
      expect(o2).not.toBe(o1);
      expect(h2).not.toBe(h1);
      expect(s2).toBe(s1);
    });

    test("with agent data the w1 ETag rolls over each minute even if nothing else changed; other hosts keep theirs", async () => {
      const { app } = await rig(undefined, [live()]);
      const t0 = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
      try {
        setSystemTime(new Date(t0));
        const cookie = await signIn(app);
        const tag = async (p: string) => (await app.request(p, { headers: { cookie } })).headers.get("etag");
        const [w1, vps] = [await tag("/hosts/w1"), await tag("/hosts/vps")];
        setSystemTime(new Date(t0 + 30_000));
        expect(await tag("/hosts/w1")).toBe(w1);
        setSystemTime(new Date(t0 + 61_000));
        expect(await tag("/hosts/w1")).not.toBe(w1);
        expect(await tag("/hosts/vps")).toBe(vps);
      } finally {
        setSystemTime();
      }
    });

    test("without agent data the w1 ETag does not depend on the clock", async () => {
      const { app } = await rig();
      const t0 = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
      try {
        setSystemTime(new Date(t0));
        const cookie = await signIn(app);
        const before = (await app.request("/hosts/w1", { headers: { cookie } })).headers.get("etag");
        setSystemTime(new Date(t0 + 61_000));
        expect((await app.request("/hosts/w1", { headers: { cookie } })).headers.get("etag")).toBe(before);
      } finally {
        setSystemTime();
      }
    });

    test("an agent error with older data keeps the section and flags the stale source", async () => {
      const { app, store, fail } = await rig(undefined, [live()]);
      const cookie = await signIn(app);
      fail.add(PROM_SOURCES.agent);
      await store.refresh(PROM_SOURCES.agent);
      const w1 = await (await app.request("/hosts/w1", { headers: { cookie } })).text();
      expect(w1).toContain("Agent host");
      expect(w1).toContain("Stale");
    });
  });

  test("another session never revalidates against this session's page", async () => {
    const { app } = await rig();
    const a = await signIn(app);
    const b = await signIn(app);
    const etag = (await app.request("/", { headers: { cookie: a } })).headers.get("etag")!;
    expect((await app.request("/", { headers: { cookie: b, "if-none-match": etag } })).status).toBe(200);
  });

  test("only authenticated page and fragment requests count as demand", async () => {
    const { app, poller } = await rig();
    await app.request("/healthz");
    await app.request("/public/app.css");
    await app.request("/");
    await app.request("/login");
    expect(poller.active()).toBe(false);
    const cookie = await signIn(app);
    expect(poller.active()).toBe(false);
    await app.request("/hosts/vps", { headers: { cookie, "turbo-frame": "live" } });
    expect(poller.active()).toBe(true);
  });
});

describe("dev auth bypass", () => {
  test("the bypass starts only under NODE_ENV=development or test", () => {
    for (const NODE_ENV of ["production", "Production", "staging", ""]) {
      expect(() => loadConfig({ ...env, DEV_AUTH_BYPASS: "1", NODE_ENV })).toThrow(/DEV_AUTH_BYPASS/);
    }
    expect(() => loadConfig({ ...env, DEV_AUTH_BYPASS: "1" })).toThrow(/DEV_AUTH_BYPASS/);
    for (const NODE_ENV of ["development", "test"]) expect(loadConfig({ ...env, DEV_AUTH_BYPASS: "1", NODE_ENV }).devAuthBypass).toBe(true);
  });

  test("without the flag the bypass route does not exist", async () => {
    const variants: Record<string, string>[] = [{}, { NODE_ENV: "production" }, { DEV_AUTH_BYPASS: "0" }];
    for (const extra of variants) {
      const { app } = await rig(extra);
      const res = await app.request("/auth/dev");
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await (await app.request("/login")).text()).not.toContain("/auth/dev");
    }
  });

  test("the bypass only redirects to local paths", async () => {
    const { app } = await rig();
    for (const next of ["//evil.test/x", "https://evil.test", "/\\evil.test", "/\t/evil.test", "/\n/evil.test", "/\r\n/evil.test", "\\/evil.test"]) {
      const res = await app.request(`/auth/dev?next=${encodeURIComponent(next)}`);
      expect(res.headers.get("location")).toBe("/");
    }
    expect((await app.request("/auth/dev?next=/%09/evil.test")).headers.get("location")).toBe("/");
    expect((await app.request(`/auth/dev?next=${encodeURIComponent("/hosts/vps?metric=cpu")}`)).headers.get("location")).toBe("/hosts/vps?metric=cpu");
    expect(localPath("/services/judicabot?tab=auth#x", "https://panel.example.test")).toBe("/services/judicabot?tab=auth");
  });
});

describe("audit", () => {
  test("anonymous login failures are capped and never push out other rows", async () => {
    const { app, db } = await rig({ DEV_AUTH_BYPASS: "1", NODE_ENV: "test", AUDIT_ANON_MAX_ROWS: "5" });
    await signIn(app);
    for (let i = 0; i < 20; i++) expect((await app.request("/auth/github/callback?state=a&code=b")).status).toBe(400);
    const count = (actor: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM audit WHERE actor = ?").get(actor)!.n;
    expect(count("anonymous")).toBe(5);
    expect(count("owner")).toBe(1);
  });
});

describe("compression and static caching", () => {
  const gz = { "accept-encoding": "gzip, br" };

  test("frames and static files are compressed, full pages are not", async () => {
    const { app } = await rig();
    const cookie = await signIn(app);
    const frame = await app.request("/hosts/vps", { headers: { ...gz, cookie, "turbo-frame": "live" } });
    expect(frame.headers.get("content-encoding")).toBe("gzip");
    expect(frame.headers.get("vary")).toContain("Accept-Encoding");
    expect(frame.headers.get("etag")).toStartWith('W/"');
    const page = await app.request("/hosts/vps", { headers: { ...gz, cookie } });
    expect(page.headers.get("content-encoding")).toBeNull();
    const css = await app.request("/public/app.css", { headers: gz });
    expect(css.headers.get("content-encoding")).toBe("gzip");
    expect((await app.request("/healthz", { headers: gz })).headers.get("content-encoding")).toBeNull();
  });

  test("static files carry an ETag and revalidate to 304", async () => {
    const { app } = await rig();
    const first = await app.request("/public/turbo.js");
    const tag = first.headers.get("etag")!;
    expect(tag).toStartWith('W/"');
    for (const inm of [tag, tag.slice(2)]) {
      const again = await app.request("/public/turbo.js", { headers: { ...gz, "if-none-match": inm } });
      expect(again.status).toBe(304);
      expect(again.headers.get("cache-control")).toBe("public, max-age=3600");
    }
  });
});

describe("rail", () => {
  test("every frame carries the rail state so auto-update can refresh it", async () => {
    const { app } = await rig();
    const cookie = await signIn(app);
    for (const path of ["/", "/hosts/vps", "/services", "/services/judicabot"]) {
      const frame = await (await app.request(path, { headers: { cookie, "turbo-frame": "live" } })).text();
      expect(frame).toMatch(/<span hidden="" data-rail-state="true" data-note="3 hosts · \d+\/7 services up" data-services="7" data-jobs=""><\/span>/);
    }
    const page = await (await app.request("/services", { headers: { cookie } })).text();
    expect(page).toContain('<span class="count" data-rail="services">7</span>');
  });

});
