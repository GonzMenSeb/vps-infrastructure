import { describe, expect, test } from "bun:test";
import type { DbMetrics, PostgresMetrics, RedisMetrics } from "../src/collectors/databases";
import type { DnsRecordSet, DnsSnapshot, PdnsStats } from "../src/collectors/pdns";
import type { RegistryRepo, RegistrySnapshot } from "../src/collectors/zot";
import { parseManifest } from "../src/manifest";
import { DatabaseTab, DatabasesFrame, DatabasesPage } from "../src/views/databases";
import { buildDatabases, fmtCount } from "../src/views/databases-model";
import { DnsFrame, DnsPage } from "../src/views/dns";
import { buildDns } from "../src/views/dns-model";
import { buildService, type ViewInput } from "../src/views/model";
import type { DatabasesView, DnsView, RegistryView } from "../src/views/phase4-input";
import { RegistryFrame, RegistryPage } from "../src/views/registry";
import { buildRegistry, shortDigest } from "../src/views/registry-model";
import { chrome, docker, fullSources, input, render, snap, styleAttrs } from "./views-fixtures";

const NOW = 1_800_000_000_000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const D = (c: string) => `sha256:${c.repeat(64)}`;

const repo = (name: string, tags: [string, string, number | null][], o: Partial<RegistryRepo> = {}): RegistryRepo => ({
  name,
  sizeBytes: 150e6,
  lastUpdated: iso(3600_000),
  error: null,
  tags: tags.map(([tag, digest, ago]) => ({ tag, digest, lastUpdated: ago === null ? null : iso(ago), sizeBytes: 150e6 })),
  ...o,
});

const registryData = (): RegistrySnapshot => ({
  repos: [
    repo("judicabot/judicabot", [["latest", D("a"), 3600_000], ["c19ab44", D("a"), 3600_000], ["3ee016f", D("b"), 7200_000], ["buildcache", D("c"), null]]),
    repo("coros/brujula", [["a6d25e1", D("d"), 86400_000]]),
    repo("empty/repo", [], { sizeBytes: 0, lastUpdated: null }),
    repo("broken/repo", [], { sizeBytes: null, lastUpdated: null, error: "zot graphql: repo metadata not found for given repo name" }),
  ],
});

const regView = (o: Partial<RegistryView> = {}): RegistryView => ({
  configured: true,
  snapshot: snap(registryData()),
  actions: true,
  host: "zot.example.test:5000",
  gc: { delay: "1h", interval: "24h" },
  ttlMs: 60_000,
  now: NOW,
  ...o,
});

const withReg = (v: RegistryView | undefined, csrf = "tok"): ViewInput => ({ ...input(), csrf, registry: v });

describe("registry view model", () => {
  test("repositories are sorted, sized and the first one is selected", () => {
    const vm = buildRegistry(withReg(regView()));
    expect(vm.repos.map((r) => r.name)).toEqual(["broken/repo", "coros/brujula", "empty/repo", "judicabot/judicabot"]);
    expect(vm.totalText).toBe("4 repositories · 300 MB");
    expect(vm.selected!.name).toBe("broken/repo");
    expect(vm.gcText).toContain("every 24h");
    expect(vm.gcText).toContain("1h grace period");
  });

  test("tags sharing latest's digest are marked and offer no delete; the others carry the exact request", () => {
    const vm = buildRegistry(withReg(regView()), { repo: "judicabot/judicabot" });
    const row = (t: string) => vm.selected!.rows.find((r) => r.tag === t)!;
    expect(vm.selected!.rows.map((r) => r.tag)).toEqual(["latest", "c19ab44", "3ee016f", "buildcache"]);
    expect(row("latest")).toMatchObject({ isLatest: true, sameAsLatest: true, delete: null });
    expect(row("c19ab44")).toMatchObject({ isLatest: false, sameAsLatest: true, delete: null, refusal: "Same manifest as latest" });
    expect(row("buildcache").buildCache).toBe(true);
    expect(row("buildcache").updatedText).toBe("—");
    const d = row("3ee016f").delete!;
    expect(d.request).toBe(`DELETE /v2/judicabot/judicabot/manifests/${D("b")}\nHost: zot.example.test:5000`);
    expect(d.action).toBe(`/registry/delete?repo=judicabot%2Fjudicabot&tag=3ee016f&digest=${encodeURIComponent(D("b"))}`);
    expect(d.csrf).toBe("tok");
    expect(d.danger).toBe(true);
    expect(d.body).toContain("every tag on it: 3ee016f");
  });

  test("when several tags share a digest the dialog names all of them", () => {
    const data: RegistrySnapshot = { repos: [repo("a/b", [["latest", D("a"), 1000], ["x", D("b"), 2000], ["y", D("b"), 2000]])] };
    const vm = buildRegistry(withReg(regView({ snapshot: snap(data) })));
    const d = vm.selected!.rows.find((r) => r.tag === "x")!.delete!;
    expect(d.body).toContain("x, y");
    expect(d.body).toContain("That other tag goes too");
    expect(d.ok).toBe("Delete 2 tags");
  });

  test("without write access, a host, or data there are no delete actions", () => {
    expect(buildRegistry(withReg(regView({ actions: false })), { repo: "judicabot/judicabot" }).selected!.rows.every((r) => r.delete === null)).toBe(true);
    expect(buildRegistry(withReg(regView({ host: null })), { repo: "judicabot/judicabot" }).actionsEnabled).toBe(false);
  });

  test("unknown repository, empty repository and unreadable repository are explained", () => {
    expect(buildRegistry(withReg(regView()), { repo: "nope/nope" }).selectedNote).toBe("There is no repository called nope/nope.");
    expect(buildRegistry(withReg(regView()), { repo: "empty/repo" }).selected!.rows).toEqual([]);
    expect(buildRegistry(withReg(regView()), { repo: "broken/repo" }).selected!.error).toContain("repo metadata not found");
  });

  test("states: not configured, loading, error and stale", () => {
    expect(buildRegistry(withReg(regView({ configured: false, snapshot: null }))).status.state).toBe("off");
    expect(buildRegistry(withReg(regView({ snapshot: snap<RegistrySnapshot>(undefined) }))).status.state).toBe("loading");
    expect(buildRegistry(withReg(regView({ snapshot: snap<RegistrySnapshot>(undefined, { lastError: "zot GET /v2/_catalog: HTTP 503" }) }))).status.state).toBe("error");
    expect(buildRegistry(withReg(regView({ snapshot: snap(registryData(), { lastError: "boom", ageMs: 90_000 }) }))).status.state).toBe("stale");
    expect(buildRegistry(input()).status.state).toBe("off");
  });

  test("shortDigest keeps the first and last four hex digits", () => {
    expect(shortDigest(`sha256:9f2c${"0".repeat(56)}a41e`)).toBe("9f2c…a41e");
  });
});

describe("registry views", () => {
  const page = (v: RegistryView, q = {}) => render(<RegistryPage chrome={chrome} vm={buildRegistry(withReg(v), q)} />);

  test("the page has the GC schedule as text and no GC button", async () => {
    const html = await page(regView(), { repo: "judicabot/judicabot" });
    expect(html).toContain("every 24h");
    expect(html.toLowerCase()).not.toContain("run garbage collection");
    expect(html).toContain('aria-current="page">Registry<');
    expect(html).toContain("same as latest");
    expect(html).toContain("build cache");
    expect(html).toContain("Protected");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("delete forms use the shared confirmation controller", async () => {
    const html = await page(regView(), { repo: "judicabot/judicabot" });
    expect(html).toContain('data-controller="confirm"');
    expect(html).toContain('data-confirm-title-value="Delete judicabot/judicabot:3ee016f?"');
    expect(html).toContain('name="_csrf" value="tok"');
  });

  test("stale data keeps the tables and shows the stale chip", async () => {
    const html = await render(<RegistryFrame vm={buildRegistry(withReg(regView({ snapshot: snap(registryData(), { lastError: "x", ageMs: 90_000 }) })))} />);
    expect(html).toContain("Stale");
    expect(html).toContain("coros/brujula");
  });

  test("off and error states render the empty panel instead of tables", async () => {
    expect(await page(regView({ configured: false, snapshot: null }))).toContain("Zot is not configured");
    const err = await page(regView({ snapshot: snap<RegistrySnapshot>(undefined, { lastError: "zot GET: HTTP 401" }) }));
    expect(err).toContain("Zot is not answering");
    expect(err).toContain("HTTP 401");
  });

  test("hostile names from Zot are escaped", async () => {
    const data: RegistrySnapshot = { repos: [repo("a/b", [["latest", D("a"), 1000], ['"><img src=x onerror=alert(1)>', D("b"), 2000]], { error: null })] };
    const html = await page(regView({ snapshot: snap(data) }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("the flash from a finished action is shown", async () => {
    const vm = buildRegistry(withReg(regView()), { flash: { ok: false, text: "refused: nothing was deleted" } });
    expect(await render(<RegistryFrame vm={vm} />)).toContain("refused: nothing was deleted");
  });
});

const svc = (o: Record<string, unknown>) => ({
  tags: [o.id],
  playbook: "playbook.yml",
  host: "vps",
  dir: `/opt/${o.id}`,
  images: [],
  hostname: null,
  jenkins_job: null,
  db: [],
  core: false,
  auth: { kind: "none", vault_vars: [], env_keys: [] },
  role: o.id,
  ...o,
});

const dbManifest = parseManifest({
  services: [
    svc({ id: "miplata", name: "Miplata", containers: ["miplata-postgres", "miplata-redis"], db: [{ kind: "postgres", container: "miplata-postgres" }, { kind: "redis", container: "miplata-redis" }] }),
    svc({ id: "metabase", name: "Metabase", containers: ["metabase-db"], db: [{ kind: "postgres", container: "metabase-db" }] }),
    svc({ id: "twin", name: "Twin", containers: ["twin-a", "twin-b"], db: [{ kind: "postgres", container: "twin-a" }, { kind: "postgres", container: "twin-b" }] }),
    svc({ id: "dns", name: "PowerDNS", containers: ["pdns", "pdns-db"], db: [{ kind: "mariadb", container: "pdns-db" }] }),
    svc({ id: "other", name: "Other", containers: ["o-maria"], db: [{ kind: "mariadb", container: "o-maria" }] }),
  ],
});

const pg = (o: Partial<PostgresMetrics> = {}): PostgresMetrics => ({
  scrapeUp: true, pgUp: true, version: "16.13.0", sizeBytes: 2.3e9, connections: 14, maxConnections: 100, cacheHitPct: 99.2, tps: 41, ...o,
});
const rd = (o: Partial<RedisMetrics> = {}): RedisMetrics => ({
  scrapeUp: true, redisUp: true, version: "7.4.12", memUsedBytes: 84e6, memMaxBytes: 256e6, clients: 6, keys: 3100, uptimeSec: 3600, ...o,
});
const stats = (o: Partial<PdnsStats> = {}): PdnsStats => ({ uptimeSec: 7200, backendQueries: 3273, backendLatencyUs: 547, servfailPackets: 0, timedoutPackets: 0, queueSize: 0, ...o });

const containers = (extra: Record<string, Record<string, unknown>> = {}) =>
  ["miplata-postgres", "miplata-redis", "metabase-db", "twin-a", "twin-b", "pdns", "pdns-db", "o-maria"].map((name) => ({
    ...docker[0]!,
    name,
    image: `${name}:1`,
    state: "running",
    status: "Up 2 hours",
    health: "none" as const,
    ...(extra[name] ?? {}),
  }));

const dbView = (o: Partial<DatabasesView> = {}, metrics: DbMetrics = { postgres: { miplata: pg() }, redis: { miplata: rd() } }): DatabasesView => ({
  prom: snap(metrics),
  promTtlMs: 15_000,
  pdnsConfigured: true,
  pdnsStats: snap(stats()),
  pdnsTtlMs: 30_000,
  zones: snap<DnsSnapshot>({ zones: [{ id: "z.", name: "z.", kind: "Native", rrsets: [] }] }),
  pdnsDbContainer: "pdns-db",
  ...o,
});

function dbInput(v: DatabasesView | undefined, extra: Record<string, Record<string, unknown>> = {}): ViewInput {
  const sources = { ...fullSources(), docker: snap(containers(extra) as never) };
  return { manifest: dbManifest, sources, databases: v };
}

const card = (v: DatabasesView | undefined, container: string, extra: Record<string, Record<string, unknown>> = {}) =>
  buildDatabases(dbInput(v, extra)).cards.find((c) => c.container === container)!;

describe("databases view model", () => {
  test("a database gets its exporter's numbers by service id and kind", () => {
    const c = card(dbView(), "miplata-postgres");
    expect(c).toMatchObject({ engine: "Postgres 16.13.0", source: "prometheus", health: { label: "Healthy", tone: "ok" } });
    expect(c.metrics.map((m) => [m.label, m.value, m.unit, m.sub])).toEqual([
      ["Size", "2.3", "GB", "all databases except templates"],
      ["Connections", "14", "", "of 100"],
      ["Cache hit", "99.2", "%", "last 5 min"],
      ["Transactions", "41", "/s", "last 5 min"],
    ]);
    const r = card(dbView(), "miplata-redis");
    expect(r.engine).toBe("Redis 7.4.12");
    expect(r.metrics.map((m) => [m.label, m.value, m.sub])).toEqual([
      ["Memory", "84", "of 256 MB"],
      ["Keys", "3.1 k", null],
      ["Clients", "6", null],
      ["Uptime", "1h 0m", null],
    ]);
  });

  test("with no exporter series the card shows the container only and says why", () => {
    const c = card(dbView(), "metabase-db");
    expect(c).toMatchObject({ source: "none", metrics: [], health: { label: "Up", tone: "ok" }, engine: "Postgres 1" });
    expect(c.note).toBe("No Postgres exporter reports for Metabase, so only the container state is shown.");
  });

  test("two databases of one kind in a service cannot be matched to an exporter", () => {
    const c = card(dbView({}, { postgres: { twin: pg() }, redis: {} }), "twin-a");
    expect(c.source).toBe("none");
    expect(c.metrics).toEqual([]);
    expect(c.note).toContain("several Postgres databases");
  });

  test("health follows the exporter: unreachable, not answering, near the limit", () => {
    expect(card(dbView({}, { postgres: { miplata: pg({ scrapeUp: false }) }, redis: {} }), "miplata-postgres").health).toMatchObject({ label: "No metrics", tone: "warn" });
    expect(card(dbView({}, { postgres: { miplata: pg({ pgUp: false }) }, redis: {} }), "miplata-postgres").health).toMatchObject({ label: "Not answering", tone: "bad" });
    expect(card(dbView({}, { postgres: { miplata: pg({ connections: 80 }) }, redis: {} }), "miplata-postgres").health).toMatchObject({ label: "Near connection limit", tone: "warn" });
    expect(card(dbView({}, { postgres: {}, redis: { miplata: rd({ memUsedBytes: 240e6 }) } }), "miplata-redis").health).toMatchObject({ label: "Near memory limit", tone: "warn" });
    expect(card(dbView({}, { postgres: {}, redis: { miplata: rd({ memMaxBytes: 0 }) } }), "miplata-redis").metrics[0]!.sub).toBe("no limit set");
    expect(card(dbView({}, { postgres: { miplata: pg({ sizeBytes: null, cacheHitPct: null, tps: null }) }, redis: {} }), "miplata-postgres").metrics.map((m) => m.value)).toEqual(["—", "14", "—", "—"]);
  });

  test("a broken container beats healthy-looking numbers; a stopped one yields only to live metrics", () => {
    expect(card(dbView(), "miplata-postgres", { "miplata-postgres": { state: "restarting", status: "Restarting (1) 5 seconds ago" } }).health).toMatchObject({ label: "Restarting", tone: "bad" });
    expect(card(dbView(), "miplata-postgres", { "miplata-postgres": { health: "unhealthy", status: "Up (unhealthy)" } }).health).toMatchObject({ label: "Unhealthy", tone: "bad" });
    expect(card(dbView(), "miplata-postgres", { "miplata-postgres": { state: "exited", status: "Exited (0)" } }).health.tone).toBe("ok");
    expect(card(dbView({}, { postgres: {}, redis: {} }), "miplata-postgres", { "miplata-postgres": { state: "exited", status: "Exited (0)" } }).health).toMatchObject({ label: "Exited" });
  });

  test("MariaDB reads PowerDNS counters only for the configured container", () => {
    const c = card(dbView(), "pdns-db");
    expect(c).toMatchObject({ source: "powerdns", health: { label: "Answering", tone: "ok" } });
    expect(c.metrics.map((m) => [m.label, m.value, m.unit])).toEqual([
      ["Backend queries", "3.3 k", ""],
      ["Backend latency", "547", "µs"],
      ["SERVFAIL answers", "0", ""],
      ["PowerDNS uptime", "2h 0m", ""],
      ["Zones · record sets", "1 · 0", ""],
    ]);
    expect(c.note).toContain("not from MariaDB");
    expect(card(dbView({ pdnsStats: snap(stats({ servfailPackets: 4 })) }), "pdns-db").health).toMatchObject({ label: "SERVFAIL seen", tone: "warn" });
    const other = card(dbView(), "o-maria");
    expect(other).toMatchObject({ source: "none", metrics: [] });
    expect(card(dbView({ pdnsConfigured: false, pdnsStats: null }), "pdns-db").note).toContain("PowerDNS API is not connected");
  });

  test("an unreachable Prometheus keeps every card with its container state", () => {
    const v = dbView({ prom: snap<DbMetrics>(undefined, { lastError: "prometheus: HTTP 503" }) });
    const vm = buildDatabases(dbInput(v));
    expect(vm.cards.length).toBe(7);
    expect(vm.cards.find((c) => c.container === "miplata-postgres")).toMatchObject({ source: "none", health: { label: "Up" } });
    expect(buildDatabases(dbInput(undefined)).cards.every((c) => c.metrics.length === 0)).toBe(true);
  });

  test("count formatting", () => {
    expect([fmtCount(0), fmtCount(999), fmtCount(1000), fmtCount(3100), fmtCount(12_400), fmtCount(2_500_000)]).toEqual(["0", "999", "1 k", "3.1 k", "12.4 k", "2.5 M"]);
  });
});

describe("databases views", () => {
  test("the page lists the cards with their service links and no invented sections", async () => {
    const html = await render(<DatabasesPage chrome={chrome} vm={buildDatabases(dbInput(dbView()))} />);
    expect(html).toContain('href="/services/miplata"');
    expect(html).toContain("Healthy");
    expect(html).not.toContain("Largest tables");
    expect(html).not.toContain("Last backup");
    expect(html).not.toContain("Queues");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("the frame of a manifest without databases says so", async () => {
    const vm = buildDatabases({ ...input(), databases: dbView() });
    expect(vm.cards.length).toBe(1);
    const empty = buildDatabases({ manifest: parseManifest({ services: [svc({ id: "x", name: "X", containers: ["x"] })] }), sources: fullSources() });
    expect(await render(<DatabasesFrame vm={empty} />)).toContain("The manifest lists no databases");
  });

  test("the service tab is built for that service only", async () => {
    const vm = buildService(dbInput(dbView()), "miplata", "db")!;
    expect(vm.databases!.cards.map((c) => c.container)).toEqual(["miplata-postgres", "miplata-redis"]);
    expect(buildService(dbInput(dbView()), "miplata", "summary")!.databases).toBeNull();
    const html = await render(<DatabaseTab vm={vm.databases} />);
    expect(html).toContain("Postgres 16.13.0");
    expect(html).not.toContain('href="/services/miplata"');
    expect(await render(<DatabaseTab vm={null} />)).toContain("The manifest lists no database for this service");
  });
});

const rr = (name: string, type: string, owner: DnsRecordSet["owner"], contents: [string, boolean?][], ttl = 300): DnsRecordSet => ({
  name,
  type,
  ttl,
  owner,
  records: contents.map(([content, disabled]) => ({ content, disabled: disabled === true })),
});

const ZONE = "web.example.test.";
const dnsData = (): DnsSnapshot => ({
  zones: [
    {
      id: ZONE,
      name: ZONE,
      kind: "Native",
      rrsets: [
        rr(`zot.${ZONE}`, "A", "other", [["192.0.2.10"]], 3600),
        rr(`scratch.${ZONE}`, "A", "panel", [["192.0.2.11"]]),
        rr(`demo.${ZONE}`, "A", "panel", [["198.51.100.7"], ["198.51.100.8", true]]),
        rr(`t.${ZONE}`, "TXT", "panel", [['"<script>alert(1)</script>"']], 60),
        rr(`srv.${ZONE}`, "SRV", "other", [["0 5 5060 sip.example.test."]], 300),
        rr(ZONE, "SOA", "zone", [["ns1.example.test. hostmaster.example.test. 0 10800 3600 604800 3600"]], 3600),
        rr(ZONE, "NS", "zone", [["ns1.example.test."]], 3600),
      ],
    },
    { id: "other.test.", name: "other.test.", kind: "Native", rrsets: [] },
  ],
});

const dnsView = (o: Partial<DnsView> = {}): DnsView => ({ configured: true, snapshot: snap(dnsData()), actions: true, host: "pdns:8081", ttlMs: 30_000, ...o });
const withDns = (v: DnsView | undefined): ViewInput => ({ ...input(), csrf: "tok", dns: v });

describe("dns view model", () => {
  test("rows are sorted with the apex first and carry owner labels and gated actions", () => {
    const vm = buildDns(withDns(dnsView()));
    expect(vm.zone).toEqual({ id: ZONE, name: ZONE, bare: "web.example.test" });
    expect(vm.rows.map((r) => `${r.type} ${r.name}`)).toEqual(["NS @", "SOA @", "A demo", "A scratch", "SRV srv", "TXT t", "A zot"]);
    const by = (t: string, n: string) => vm.rows.find((r) => r.type === t && r.name === n)!;
    expect(by("A", "zot")).toMatchObject({ ownerLabel: "Ansible / other", ownerTone: "info" });
    expect(by("A", "scratch")).toMatchObject({ ownerLabel: "Panel only", ownerTone: "warn" });
    expect(by("SOA", "@")).toMatchObject({ ownerLabel: "Zone", editHref: null, deleteHref: null, note: "Belongs to the zone itself" });
    expect(by("SRV", "srv")).toMatchObject({ editHref: null, deleteHref: null });
    expect(by("SRV", "srv").note).toContain("not editable here");
    expect(by("A", "demo").contents).toEqual([{ text: "198.51.100.7", disabled: false }, { text: "198.51.100.8", disabled: true }]);
    expect(vm.panelOnly).toBe(3);
    expect(vm.zones.map((z) => [z.name, z.selected])).toEqual([["web.example.test", true], ["other.test", false]]);
  });

  test("without write access no edit or delete link exists", () => {
    const vm = buildDns(withDns(dnsView({ actions: false })));
    expect(vm.actionsEnabled).toBe(false);
    expect(vm.rows.every((r) => r.editHref === null && r.deleteHref === null)).toBe(true);
  });

  test("filtering matches name, type and content, case-insensitively", () => {
    expect(buildDns(withDns(dnsView()), { q: "SCRATCH" }).rows.map((r) => r.name)).toEqual(["scratch"]);
    expect(buildDns(withDns(dnsView()), { q: "198.51" }).rows.map((r) => r.name)).toEqual(["demo"]);
    expect(buildDns(withDns(dnsView()), { q: "nothing" }).rows).toEqual([]);
  });

  test("the zone selector picks a zone and falls back to the first", () => {
    expect(buildDns(withDns(dnsView()), { zone: "other.test." }).zone!.id).toBe("other.test.");
    expect(buildDns(withDns(dnsView()), { zone: "bogus." }).zone!.id).toBe(ZONE);
  });

  test("edit prefills the form from the record set and locks nothing else", () => {
    const vm = buildDns(withDns(dnsView()), { edit: `A:demo.${ZONE}` });
    expect(vm.form).toMatchObject({ mode: "edit", type: "A", name: "demo", ttl: "300", content: "198.51.100.7\n198.51.100.8" });
    expect(buildDns(withDns(dnsView()), { edit: `SOA:${ZONE}` }).form.mode).toBe("add");
    expect(buildDns(withDns(dnsView()), { edit: "A:ghost" }).form.mode).toBe("add");
  });

  test("a valid review carries the request, hash, and the overwrite requirement", () => {
    const f = { op: "upsert", name: "zot", type: "A", ttl: "300", content: "192.0.2.99" };
    const vm = buildDns(withDns(dnsView()), { review: true, fields: f });
    expect(vm.review).toMatchObject({ op: "upsert", needsOverwrite: true, canApply: true, csrf: "tok", title: "Change A zot" });
    expect(vm.review!.request).toContain("PATCH /api/v1/servers/localhost/zones/web.example.test.");
    expect(vm.review!.hash).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(vm.review!.fields).toMatchObject({ zone: ZONE, name: "zot", content: "192.0.2.99" });
    const mine = buildDns(withDns(dnsView()), { review: true, fields: { ...f, name: "scratch" } });
    expect(mine.review!.needsOverwrite).toBe(false);
    const fresh = buildDns(withDns(dnsView()), { review: true, fields: { ...f, name: "fresh" } });
    expect(fresh.review!.title).toBe("Add A fresh");
    const same = buildDns(withDns(dnsView()), { review: true, fields: { op: "upsert", name: "scratch", type: "A", ttl: "300", content: "192.0.2.11" } });
    expect(same.review).toMatchObject({ unchanged: true, canApply: false });
    const del = buildDns(withDns(dnsView()), { review: true, fields: { op: "delete", name: "scratch", type: "A" } });
    expect(del.review).toMatchObject({ op: "delete", title: "Delete A scratch" });
  });

  test("an invalid review explains itself and refills the add form", () => {
    const vm = buildDns(withDns(dnsView()), { review: true, fields: { op: "upsert", name: "x", type: "A", ttl: "300", content: "nope" } });
    expect(vm.review).toBeNull();
    expect(vm.reviewError).toContain("nope is not an IPv4 address");
    expect(vm.form).toMatchObject({ name: "x", content: "nope", error: expect.stringContaining("nope") });
    expect(buildDns(withDns(dnsView()), { review: true, fields: { op: "delete", name: "ghost", type: "A" } }).reviewError).toContain("no A record named ghost");
  });
});

describe("dns views", () => {
  const frame = (q = {}, v = dnsView()) => render(<DnsFrame vm={buildDns(withDns(v), q)} />);

  test("the table shows owners and the panel-only note, with no inline styles", async () => {
    const html = await render(<DnsPage chrome={chrome} vm={buildDns(withDns(dnsView()))} />);
    expect(html).toContain("Ansible / other");
    expect(html).toContain("Panel only");
    expect(html).toContain("3 record sets exist only in the panel");
    expect(html).toContain("198.51.100.8 (disabled)");
    expect(html).toContain('aria-current="page">DNS<');
    expect(styleAttrs(html)).toEqual([]);
  });

  test("hostile record content is escaped", async () => {
    const html = await frame();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("the review panel prints the request, holds auto-refresh, and only an Ansible record asks for the checkbox", async () => {
    const f = { op: "upsert", name: "zot", type: "A", ttl: "300", content: "192.0.2.99" };
    const ansible = await frame({ review: true, fields: f });
    expect(ansible).toContain("data-refresh-hold");
    expect(ansible).toContain('action="/dns/apply"');
    expect(ansible).toMatch(/<input type="checkbox" name="overwrite" value="yes" required/);
    expect(ansible).toContain('name="hash"');
    expect(ansible).toContain('name="_csrf" value="tok"');
    expect(ansible).toContain("&quot;changetype&quot;: &quot;REPLACE&quot;");
    const mine = await frame({ review: true, fields: { ...f, name: "scratch" } });
    expect(mine).not.toContain('name="overwrite"');
  });

  test("the unchanged review disables the apply button", async () => {
    const html = await frame({ review: true, fields: { op: "upsert", name: "scratch", type: "A", ttl: "300", content: "192.0.2.11" } });
    expect(html).toContain("nothing to send");
    expect(html).toMatch(/<button type="submit" class="btn primary" disabled/);
  });

  test("the edit form locks name and type and pauses auto-refresh", async () => {
    const html = await frame({ edit: `A:scratch.${ZONE}` });
    expect(html).toContain('id="record-form"');
    expect(html).toContain("data-refresh-hold");
    expect(html).toMatch(/<input name="name"[^>]*readonly/);
    expect(html).toContain('<input type="hidden" name="type" value="A"/>');
  });

  test("read-only mode says so and offers no form", async () => {
    const html = await frame({}, dnsView({ actions: false }));
    expect(html).toContain("read-only");
    expect(html).not.toContain('id="record-form"');
    expect(html).not.toContain(">Edit<");
  });

  test("not configured and error states", async () => {
    expect(await frame({}, dnsView({ configured: false, snapshot: null }))).toContain("PowerDNS is not configured");
    expect(await frame({}, dnsView({ snapshot: snap<DnsSnapshot>(undefined, { lastError: "pdns GET /zones: HTTP 401" }) }))).toContain("PowerDNS is not answering");
    expect(await frame({}, dnsView({ snapshot: snap(dnsData(), { lastError: "x", ageMs: 200_000 }) }))).toContain("Stale");
  });
});
