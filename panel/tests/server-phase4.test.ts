import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { githubClient } from "../src/auth/github";
import { DB_SOURCES } from "../src/collectors/databases";
import { DockerClient, registerDockerSources } from "../src/collectors/docker";
import { PDNS_SOURCES } from "../src/collectors/pdns";
import { PromClient, registerPrometheusSources } from "../src/collectors/prometheus";
import { ZOT_SOURCES } from "../src/collectors/zot";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { loadManifest } from "../src/manifest";
import { Poller } from "../src/poller";
import { buildPhase4 } from "../src/routes/phase4";
import { createApp, isLoopbackUrl, start } from "../src/server";
import { Store } from "../src/store";
import { startFixtureUpstreams, type FixtureUpstreams } from "./dev/fixture-upstreams";
import { startFakePdns } from "./dev/pdns-fixture";
import { startFakeZot } from "./dev/zot-fixture";

let up: FixtureUpstreams;

beforeAll(async () => {
  up = await startFixtureUpstreams();
});
afterAll(async () => {
  await up.stop();
});

beforeEach(() => {
  up.zot.setDown(false);
  up.pdns.setDown(false);
});

const ORIGIN = "https://panel.example.test";
const base = { timeoutMs: 1500, failureThreshold: 3, cooldownMs: 15_000 };

async function rig(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PUBLIC_URL: ORIGIN,
    SERVICES_MANIFEST_PATH: "x",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_ALLOWED_LOGIN: "owner",
    SESSION_SECRET: "x".repeat(40),
    NODE_ENV: "test",
    DEV_AUTH_BYPASS: "1",
    PROMETHEUS_URL: up.promUrl,
    ZOT_URL: up.zot.url,
    ZOT_USER: "ci",
    ZOT_PASSWORD: "dev-password",
    PDNS_API_URL: up.pdns.url,
    PDNS_API_KEY: up.pdns.apiKey,
    ...env,
  });
  const manifest = await loadManifest("tests/fixtures/dev-services.json");
  const store = new Store();
  registerPrometheusSources(store, new PromClient(cfg.PROMETHEUS_URL), base);
  registerDockerSources(store, new DockerClient(up.dockerSocket), base);
  const db = openDb(":memory:");
  const phase4 = buildPhase4({ cfg, db, store, base, isLoopbackUrl });
  await Promise.all(store.names().map((n) => store.refresh(n)));
  const poller = new Poller(store, { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 });
  const app = createApp({ cfg, db, store, gh: githubClient(cfg), lagMs: () => 0, manifest, poller, phase4 });
  const res = await app.request("/auth/dev?next=/");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { cookie, ...headers } });
  const text = async (path: string) => (await get(path)).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await text("/registry"))![1]!;
  const post = (path: string, fields: Record<string, string> = {}, o: { csrf?: string | null; origin?: string | null } = {}) =>
    app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }) },
      body: new URLSearchParams({ ...(o.csrf === null ? {} : { _csrf: o.csrf ?? csrf }), ...fields }).toString(),
    });
  return { app, db, store, cookie, get, text, post, csrf };
}

const audit = (db: ReturnType<typeof openDb>, action: string) =>
  db.query<{ outcome: string; target: string }, [string]>("SELECT outcome, target FROM audit WHERE action = ? ORDER BY id").all(action);

describe("registry page and action", () => {
  test("lists repositories and tags, marks tags sharing latest, shows the GC schedule and no GC button", async () => {
    const { text } = await rig();
    const html = await text("/registry?repo=judicabot%2Fjudicabot");
    expect(html).toContain("judicabot/judicabot");
    expect(html).toContain("miplata/api");
    expect(html).toContain("same as latest");
    expect(html).toContain("build cache");
    expect(html).toContain("every 24h");
    expect(html).toContain("1h grace period");
    expect(html).toContain("no manual trigger");
    expect(html.toLowerCase()).not.toContain("run garbage collection");
    expect(html).toContain('aria-current="page">Registry<');
  });

  test("latest and its twin offer no delete, other tags carry the exact request in the confirmation", async () => {
    const { text } = await rig();
    const html = await text("/registry?repo=judicabot%2Fjudicabot");
    expect(html).toContain("latest is never deleted from here");
    expect(html).toContain("Same manifest as latest");
    const dialogs = [...html.matchAll(/data-confirm-request-value="([^"]+)"/g)].map((m) => m[1]!.replaceAll("&#10;", "\n").replaceAll("&#39;", "'"));
    expect(dialogs.length).toBe(3);
    for (const d of dialogs) expect(d).toMatch(/^DELETE \/v2\/judicabot\/judicabot\/manifests\/sha256:[0-9a-f]{64}\nHost: 127\.0\.0\.1:\d+$/);
    expect(html).toContain("/registry/delete?repo=judicabot%2Fjudicabot&amp;tag=3ee016f");
  });

  test("deleting a tag needs origin and CSRF, deletes in the fake, audits, and flashes the result", async () => {
    const { post, db, get, text, cookie } = await rig();
    const tag = up.zot.state.get("miplata/api")!.find((t) => t.tag === "410")!;
    const url = `/registry/delete?repo=miplata%2Fapi&tag=410&digest=${tag.digest}`;
    expect((await post(url, {}, { origin: null })).status).toBe(403);
    expect((await post(url, {}, { csrf: "bad" })).status).toBe(403);
    expect(up.zot.deletes).toEqual([]);
    const res = await post(url);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/registry?repo=miplata%2Fapi");
    expect(up.zot.deletes).toEqual([{ repo: "miplata/api", ref: tag.digest }]);
    expect(audit(db, "registry.delete").map((r) => r.outcome)).toEqual(["requested", "verified"]);
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await get(res.headers.get("location")!, { cookie: `${cookie}; ${flash}` })).text();
    expect(page).toContain("deleted tag 410 from miplata/api");
    const after = await text("/registry?repo=miplata%2Fapi");
    expect(after).not.toContain(">410<");
  });

  test("a delete aimed at the manifest latest points to is refused without a DELETE reaching Zot", async () => {
    const { post, db } = await rig();
    const latest = up.zot.state.get("judicabot/judicabot")!.find((t) => t.tag === "latest")!;
    const before = up.zot.deletes.length;
    const res = await post(`/registry/delete?repo=judicabot%2Fjudicabot&tag=latest&digest=${latest.digest}`);
    expect(res.status).toBe(303);
    expect(up.zot.deletes.length).toBe(before);
    expect(audit(db, "registry.delete").at(-1)!.outcome).toBe("rejected");
  });

  test("Zot going away leaves the page up with a stale note, other pages untouched", async () => {
    const { text, store } = await rig();
    up.zot.setDown(true);
    await store.refresh(ZOT_SOURCES.repos);
    const html = await text("/registry");
    expect(html).toContain("judicabot/judicabot");
    expect(html).toContain("Stale");
    expect(await text("/dns")).toContain("web.example.test");
    expect(await text("/services")).toContain("Miplata");
  });

  test("an unreachable Zot with no data shows an error panel, not a crash", async () => {
    up.zot.setDown(true);
    const { text } = await rig();
    const html = await text("/registry");
    expect(html).toContain("Zot is not answering");
  });

  test("an unconfigured Zot says so", async () => {
    const { text } = await rig({ ZOT_URL: "", ZOT_USER: "", ZOT_PASSWORD: "" });
    expect(await text("/registry")).toContain("Zot is not configured");
  });
});

describe("databases page and the service tab", () => {
  test("shows exporter-backed Postgres and Redis, PowerDNS counters for MariaDB, and container state only for the rest", async () => {
    const { text } = await rig();
    const html = await text("/databases");
    expect(html).toContain("Postgres 16.13.0");
    expect(html).toContain("Redis 7.4.12");
    expect(html).toContain(">99.2<");
    expect(html).toContain("of 100");
    expect(html).toContain("of 256 MB");
    expect(html).toContain("MariaDB");
    expect(html).toContain("PowerDNS&#39;s own statistics");
    expect(html).toContain("No Postgres exporter reports for Metabase");
    expect(html).toContain("No Postgres exporter reports for Categorizer");
    expect(html).not.toContain("Last backup");
    expect(html).not.toContain("Largest tables");
  });

  test("the service Database tab carries the same cards", async () => {
    const { text } = await rig();
    const html = await text("/services/miplata?tab=db");
    expect(html).toContain("Postgres 16.13.0");
    expect(html).toContain("Redis 7.4.12");
    expect(html).not.toContain("Phase 4");
    expect(await text("/services/dns?tab=db")).toContain("MariaDB");
  });

  test("the Database tab ETag follows the database sources, other tabs do not", async () => {
    const { get, store } = await rig();
    const tab = async (t: string) => (await get(`/services/miplata?tab=${t}`, { "turbo-frame": "live" })).headers.get("etag");
    const dbBefore = await tab("db");
    const sumBefore = await tab("summary");
    expect((await get("/services/miplata?tab=db", { "turbo-frame": "live", "if-none-match": dbBefore! })).status).toBe(304);
    up.pdns.setDown(true);
    await store.refresh(PDNS_SOURCES.stats);
    expect(await tab("db")).not.toBe(dbBefore);
    expect(await tab("summary")).toBe(sumBefore);
  });

  test("a dead Prometheus source degrades the cards instead of failing the page", async () => {
    const { get, store } = await rig({ PROMETHEUS_URL: "http://127.0.0.1:9" });
    await store.refresh(DB_SOURCES.metrics).catch(() => {});
    const res = await get("/databases");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("only the container state is shown");
  });
});

describe("dns page and actions", () => {
  test("lists the real zone with owners, the add form and the panel-only note", async () => {
    const { text } = await rig();
    const html = await text("/dns");
    expect(html).toContain("miplata");
    expect(html).toContain("Ansible / other");
    expect(html).toContain("Panel only");
    expect(html).toContain("Zone");
    expect(html).toContain("record sets exist only in the panel");
    expect(html).toContain('id="record-form"');
    expect(html).not.toContain("example.org");
  });

  test("filtering narrows the table", async () => {
    const { text } = await rig();
    const html = await text("/dns?q=scratch");
    expect(html).toContain("scratch");
    expect(html).not.toContain(">grafana<");
  });

  test("the review step prints the exact PATCH body and holds auto-refresh", async () => {
    const { text } = await rig();
    const html = await text("/dns?review=1&op=upsert&name=fresh&type=A&ttl=300&content=192.0.2.50");
    expect(html).toContain("Review change");
    expect(html).toContain("PATCH /api/v1/servers/localhost/zones/web.example.test.");
    expect(html).toContain("managed-by: panel");
    expect(html).toContain("data-refresh-hold");
    expect(html).not.toContain('name="overwrite"');
  });

  test("an invalid change is explained on the page and nothing is sent", async () => {
    const { text } = await rig();
    const before = up.pdns.requests.filter((r) => r.method === "PATCH").length;
    const html = await text("/dns?review=1&op=upsert&name=bad&type=A&ttl=300&content=not-an-ip");
    expect(html).toContain("not-an-ip is not an IPv4 address");
    const soa = await text("/dns?review=1&op=upsert&name=%40&type=SOA&ttl=300&content=x");
    expect(soa).toContain("never edits them");
    expect(up.pdns.requests.filter((r) => r.method === "PATCH").length).toBe(before);
  });

  test("an Ansible record shows the overwrite warning and a required checkbox", async () => {
    const { text } = await rig();
    const html = await text("/dns?review=1&op=upsert&name=miplata&type=A&ttl=300&content=192.0.2.99");
    expect(html).toContain("managed by Ansible or another tool");
    expect(html).toContain('name="overwrite"');
    expect(html).toMatch(/<input type="checkbox" name="overwrite" value="yes" required/);
  });

  async function reviewHash(text: (p: string) => Promise<string>, query: string): Promise<string> {
    return /name="hash" value="([^"]+)"/.exec(await text(`/dns?review=1&${query}`))![1]!;
  }

  test("applying: origin, CSRF and the reviewed hash are all required; the fake changes and the audit records it", async () => {
    const { post, text, db } = await rig();
    const q = "op=upsert&name=fresh&type=A&ttl=300&content=192.0.2.50";
    const hash = await reviewHash(text, q);
    const fields = { zone: "web.example.test.", op: "upsert", name: "fresh", type: "A", ttl: "300", content: "192.0.2.50", hash };
    expect((await post("/dns/apply", fields, { origin: null })).status).toBe(403);
    expect((await post("/dns/apply", fields, { csrf: "bad" })).status).toBe(403);
    expect(up.pdns.requests.some((r) => r.method === "PATCH" && JSON.stringify(r.body).includes("fresh"))).toBe(false);
    const noHash = await post("/dns/apply", { ...fields, hash: "" });
    expect(noHash.status).toBe(303);
    expect(audit(db, "dns.upsert").at(-1)!.outcome).toBe("rejected");
    const ok = await post("/dns/apply", fields);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/dns?zone=web.example.test.");
    expect(up.pdns.rrsets.find((r) => r.name === "fresh.web.example.test.")!.comments[0]!.content).toBe("managed-by: panel");
    expect(audit(db, "dns.upsert").map((r) => r.outcome).slice(-2)).toEqual(["requested", "verified"]);
  });

  test("overwriting an Ansible record is rejected on the server without the confirmation field", async () => {
    const { post, text } = await rig();
    const q = "op=upsert&name=miplata&type=A&ttl=300&content=192.0.2.99";
    const hash = await reviewHash(text, q);
    const fields = { zone: "web.example.test.", op: "upsert", name: "miplata", type: "A", ttl: "300", content: "192.0.2.99", hash };
    const before = structuredClone(up.pdns.rrsets.find((r) => r.name === "miplata.web.example.test.")!);
    await post("/dns/apply", fields);
    expect(up.pdns.rrsets.find((r) => r.name === "miplata.web.example.test.")).toEqual(before);
    await post("/dns/apply", { ...fields, overwrite: "yes" });
    expect(up.pdns.rrsets.find((r) => r.name === "miplata.web.example.test.")!.records[0]!.content).toBe("192.0.2.99");
  });

  test("deleting goes through the same review and confirmation", async () => {
    const { post, text } = await rig();
    const hash = await reviewHash(text, "op=delete&name=scratch&type=A");
    const html = await text("/dns?review=1&op=delete&name=scratch&type=A");
    expect(html).toContain("&quot;changetype&quot;: &quot;DELETE&quot;");
    await post("/dns/apply", { zone: "web.example.test.", op: "delete", name: "scratch", type: "A", hash });
    expect(up.pdns.rrsets.some((r) => r.name === "scratch.web.example.test.")).toBe(false);
  });

  test("PowerDNS going away degrades only the DNS and database pages", async () => {
    const { get, store } = await rig();
    up.pdns.setDown(true);
    await store.refresh(PDNS_SOURCES.zones);
    await store.refresh(PDNS_SOURCES.stats);
    const dns = await (await get("/dns")).text();
    expect(dns).toContain("Stale");
    expect(dns).toContain("miplata");
    expect((await get("/databases")).status).toBe(200);
    expect((await get("/")).status).toBe(200);
  });
});

describe("safety and wiring", () => {
  test("with the dev bypass on and non-loopback upstreams no mutation is possible", async () => {
    const { post, text, db } = await rig({ ZOT_URL: "https://zot.example.test", PDNS_API_URL: "https://pdns.example.test" });
    expect((await post("/registry/delete?repo=a%2Fb&tag=x&digest=sha256:" + "a".repeat(64))).status).toBe(503);
    expect((await post("/dns/apply", { zone: "z.test.", op: "delete", name: "a", type: "A", hash: "x" })).status).toBe(503);
    expect(audit(db, "registry.delete")).toEqual([]);
    expect(await text("/registry")).not.toContain("data-confirm-request-value");
  });

  test("the new pages need a session", async () => {
    const { app } = await rig();
    for (const p of ["/registry", "/databases", "/dns"]) {
      const res = await app.request(p);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
    }
    expect((await app.request("/registry/delete", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(303);
  });

  test("start() wires the new sources from the environment", async () => {
    const zot = startFakeZot();
    const pdns = startFakePdns();
    const port = String(41000 + Math.floor(Math.random() * 2000));
    const running = await start({
      NODE_ENV: "development",
      DEV_AUTH_BYPASS: "1",
      PUBLIC_URL: `http://localhost:${port}`,
      PORT: port,
      DATA_DIR: `/tmp/vesp-phase4-${port}`,
      SERVICES_MANIFEST_PATH: "tests/fixtures/dev-services.json",
      GITHUB_CLIENT_ID: "x",
      GITHUB_CLIENT_SECRET: "x",
      GITHUB_ALLOWED_LOGIN: "owner",
      SESSION_SECRET: "y".repeat(40),
      PROMETHEUS_URL: up.promUrl,
      DOCKER_SOCKET: up.dockerSocket,
      ZOT_URL: zot.url,
      ZOT_USER: "ci",
      ZOT_PASSWORD: "dev-password",
      PDNS_API_URL: pdns.url,
      PDNS_API_KEY: pdns.apiKey,
    });
    try {
      const login = await fetch(`${running.url}/auth/dev?next=/`, { redirect: "manual" });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      let html = "";
      const until = Date.now() + 8000;
      while (Date.now() < until && !html.includes("judicabot/judicabot")) {
        html = await (await fetch(`${running.url}/registry`, { headers: { cookie } })).text();
        await Bun.sleep(200);
      }
      expect(html).toContain("judicabot/judicabot");
      expect(await (await fetch(`${running.url}/dns`, { headers: { cookie } })).text()).toContain("web.example.test");
    } finally {
      await running.stop();
      await zot.stop();
      await pdns.stop();
    }
  });
});
