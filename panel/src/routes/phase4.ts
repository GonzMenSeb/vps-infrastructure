import type { Database } from "bun:sqlite";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { DnsActions } from "../actions/dns";
import { RegistryActions } from "../actions/registry";
import { csrfGuard, type AppEnv } from "../auth/session";
import { DB_SOURCES, registerDbSources, type DbMetrics } from "../collectors/databases";
import { PDNS_SOURCES, PDNS_TTL, ZONE_ID, pdnsClientFromConfig, registerPdnsSources, type DnsSnapshot, type PdnsClient, type PdnsStats } from "../collectors/pdns";
import { PromClient, PROM_TTL } from "../collectors/prometheus";
import { ZOT_SOURCES, ZOT_TTL, registerZotSources, zotClientFromConfig, type RegistrySnapshot, type ZotClient } from "../collectors/zot";
import type { Config } from "../config";
import type { LiveSpec } from "../server";
import type { SourceOptions, Snapshot, Store } from "../store";
import { DatabasesFrame, DatabasesPage } from "../views/databases";
import { buildDatabases } from "../views/databases-model";
import { DnsFrame, DnsPage } from "../views/dns";
import { buildDns, dnsHref } from "../views/dns-model";
import { fmtAge, snapshotStatus, type Flash, type SourceKey, type ViewInput } from "../views/model";
import type { DatabasesView, DnsView, RegistryView } from "../views/phase4-input";
import { RegistryFrame, RegistryPage } from "../views/registry";
import { buildRegistry, repoHref } from "../views/registry-model";

export interface Phase4 {
  registry: { client: ZotClient; actions: RegistryActions | null; gc: { delay: string; interval: string } } | null;
  dns: { client: PdnsClient; actions: DnsActions | null } | null;
  pdnsDbContainer: string;
  views: () => Pick<ViewInput, "registry" | "dns" | "databases">;
  databaseSig: () => string[];
}

export interface RouteKit {
  session: MiddlewareHandler<AppEnv>;
  demand: MiddlewareHandler<AppEnv>;
  live: (c: Context<AppEnv>, spec: LiveSpec) => Promise<Response>;
  readFlash: (c: Context<AppEnv>) => Flash | null;
  setFlash: (c: Context<AppEnv>, r: { ok: boolean; message: string }) => void;
  baseSources: readonly SourceKey[];
}

export interface BuildPhase4Deps {
  cfg: Config;
  db: Database;
  store: Store;
  base: Omit<SourceOptions, "ttlMs">;
  isLoopbackUrl: (url: string) => boolean;
}

const CLOCK_MS = 15_000;
const DNS_FIELDS = ["zone", "op", "name", "type", "ttl", "content"] as const;

function snapSig(label: string, ttlMs: number, snap: Snapshot<unknown> | null): string {
  const st = snapshotStatus("databases", label, ttlMs, snap);
  return [label, st.state, st.error ?? "", snap?.hash ?? "", snap?.breaker ?? "", st.state === "stale" ? fmtAge(st.ageMs) : ""].join("\u0001");
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function buildPhase4({ cfg, db, store, base, isLoopbackUrl }: BuildPhase4Deps): Phase4 {
  registerDbSources(store, new PromClient(cfg.PROMETHEUS_URL), base);
  const gc = { delay: cfg.ZOT_GC_DELAY, interval: cfg.ZOT_GC_INTERVAL };

  const zot = zotClientFromConfig(cfg);
  let registry: Phase4["registry"] = null;
  if (zot) {
    registerZotSources(store, zot, base);
    const mutable = !cfg.devAuthBypass || isLoopbackUrl(cfg.ZOT_URL!);
    if (!mutable) console.warn("DEV_AUTH_BYPASS=1 with a non-local ZOT_URL: registry delete actions are disabled");
    registry = { client: zot, actions: mutable ? new RegistryActions({ client: zot, db, store }) : null, gc };
  }

  const pdnsClient = pdnsClientFromConfig(cfg);
  let dns: Phase4["dns"] = null;
  if (pdnsClient) {
    registerPdnsSources(store, pdnsClient, base);
    const mutable = !cfg.devAuthBypass || isLoopbackUrl(cfg.PDNS_API_URL!);
    if (!mutable) console.warn("DEV_AUTH_BYPASS=1 with a non-local PDNS_API_URL: DNS actions are disabled");
    dns = { client: pdnsClient, actions: mutable ? new DnsActions({ client: pdnsClient, db, store }) : null };
  }

  const peek = <T>(name: string): Snapshot<T> => store.peek<T>(name);

  const views: Phase4["views"] = () => {
    const registryView: RegistryView = {
      configured: registry !== null,
      snapshot: registry ? peek<RegistrySnapshot>(ZOT_SOURCES.repos) : null,
      actions: registry?.actions != null,
      host: registry?.client.host ?? null,
      gc,
      ttlMs: ZOT_TTL.reposMs,
    };
    const dnsView: DnsView = {
      configured: dns !== null,
      snapshot: dns ? peek<DnsSnapshot>(PDNS_SOURCES.zones) : null,
      actions: dns?.actions != null,
      host: dns?.client.host ?? null,
      ttlMs: PDNS_TTL.zonesMs,
    };
    const databasesView: DatabasesView = {
      prom: peek<DbMetrics>(DB_SOURCES.metrics),
      promTtlMs: PROM_TTL.instantMs,
      pdnsConfigured: dns !== null,
      pdnsStats: dns ? peek<PdnsStats>(PDNS_SOURCES.stats) : null,
      pdnsTtlMs: PDNS_TTL.statsMs,
      zones: dns ? peek<DnsSnapshot>(PDNS_SOURCES.zones) : null,
      pdnsDbContainer: cfg.PDNS_DB_CONTAINER,
    };
    return { registry: registryView, dns: dnsView, databases: databasesView };
  };

  const databaseSig = (): string[] => {
    const v = views().databases!;
    return [
      snapSig("db", v.promTtlMs, v.prom),
      ...(v.pdnsStats ? [snapSig("pdns-stats", v.pdnsTtlMs, v.pdnsStats)] : []),
      ...(v.zones ? [snapSig("pdns-zones", PDNS_TTL.zonesMs, v.zones)] : []),
    ];
  };

  return { registry, dns, pdnsDbContainer: cfg.PDNS_DB_CONTAINER, views, databaseSig };
}

export function registerPhase4Routes(app: Hono<AppEnv>, p: Phase4, kit: RouteKit): void {
  const { session, demand, live, readFlash, setFlash, baseSources } = kit;
  const flashSig = (f: Flash | null): string[] => (f ? [`flash:${f.ok}:${f.text}`] : []);

  app.get("/registry", session, demand, (c) => {
    const repo = c.req.query("repo");
    const flash = readFlash(c);
    const v = p.views().registry!;
    return live(c, {
      key: `registry:${repo ?? ""}`,
      clock: true,
      clockMs: CLOCK_MS,
      extra: [snapSig("zot", v.ttlMs, v.snapshot), ...flashSig(flash)],
      sources: baseSources,
      page: (input, chrome) => RegistryPage({ chrome, vm: buildRegistry(input, { repo, flash }) }),
      frame: (input) => RegistryFrame({ vm: buildRegistry(input, { repo, flash }) }),
    });
  });

  app.post("/registry/delete", session, csrfGuard(), async (c) => {
    if (!p.registry?.actions) return c.text("registry actions are not configured", 503);
    const repo = c.req.query("repo") ?? "";
    const r = await p.registry.actions.deleteManifest({ repo, tag: c.req.query("tag") ?? "", digest: c.req.query("digest") ?? "" }, c.get("session").login);
    setFlash(c, r);
    return c.redirect(repo ? repoHref(repo) : "/registry", 303);
  });

  app.get("/databases", session, demand, (c) =>
    live(c, {
      key: "databases",
      clock: true,
      clockMs: CLOCK_MS,
      extra: p.databaseSig(),
      sources: baseSources,
      page: (input, chrome) => DatabasesPage({ chrome, vm: buildDatabases(input) }),
      frame: (input) => DatabasesFrame({ vm: buildDatabases(input) }),
    }),
  );

  app.get("/dns", session, demand, (c) => {
    const q = c.req.query();
    const flash = readFlash(c);
    const review = q.review === "1";
    const fields: Record<string, string> = {};
    for (const k of DNS_FIELDS) if (q[k] !== undefined) fields[k] = q[k]!;
    const query = { zone: q.zone, q: q.q, edit: q.edit, review, fields, flash };
    const v = p.views().dns!;
    return live(c, {
      key: `dns:${q.zone ?? ""}:${q.q ?? ""}:${q.edit ?? ""}:${review ? JSON.stringify(fields) : ""}`,
      clock: true,
      clockMs: CLOCK_MS,
      extra: [snapSig("pdns", v.ttlMs, v.snapshot), ...flashSig(flash)],
      sources: baseSources,
      page: (input, chrome) => DnsPage({ chrome, vm: buildDns(input, query) }),
      frame: (input) => DnsFrame({ vm: buildDns(input, query) }),
    });
  });

  app.post("/dns/apply", session, csrfGuard(), async (c) => {
    if (!p.dns?.actions) return c.text("dns actions are not configured", 503);
    const body = await c.req.parseBody();
    const fields: Record<string, unknown> = {};
    for (const k of DNS_FIELDS) fields[k] = str(body[k]) ?? "";
    const r = await p.dns.actions.apply({ fields, hash: str(body.hash) || undefined, overwrite: str(body.overwrite) === "yes" }, c.get("session").login);
    setFlash(c, r);
    const zone = String(fields.zone);
    return c.redirect(ZONE_ID.test(zone) ? dnsHref(zone) : "/dns", 303);
  });
}
