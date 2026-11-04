import type { SourceOptions, Store } from "../store";
import { PROM_TTL, unionQuery, type PromClient } from "./prometheus";

export const DB_RATE_WINDOW_SEC = 300;
export const POSTGRES_JOB = "postgres_exporter";
export const REDIS_JOB = "redis_exporter";

const pg = `job="${POSTGRES_JOB}"`;
const rd = `job="${REDIS_JOB}"`;
const w = `${DB_RATE_WINDOW_SEC}s`;
const hit = `sum by (service) (rate(pg_stat_database_blks_hit{${pg}}[${w}]))`;
const read = `sum by (service) (rate(pg_stat_database_blks_read{${pg}}[${w}]))`;

export const DB_EXPRS = {
  pgScrape: `max by (service) (up{${pg}})`,
  pgUp: `max by (service) (pg_up{${pg}})`,
  pgVersion: `max by (service, short_version) (pg_static{${pg}})`,
  pgSize: `sum by (service) (pg_database_size_bytes{${pg},datname!~"template0|template1"})`,
  pgConns: `sum by (service) (pg_stat_database_numbackends{${pg}})`,
  pgMaxConns: `max by (service) (pg_settings_max_connections{${pg}})`,
  pgCacheHit: `100 * ${hit} / (${hit} + ${read})`,
  pgTps: `sum by (service) (rate(pg_stat_database_xact_commit{${pg}}[${w}]) + rate(pg_stat_database_xact_rollback{${pg}}[${w}]))`,
  rdScrape: `max by (service) (up{${rd}})`,
  rdUp: `max by (service) (redis_up{${rd}})`,
  rdVersion: `max by (service, redis_version) (redis_instance_info{${rd}})`,
  rdMem: `max by (service) (redis_memory_used_bytes{${rd}})`,
  rdMemMax: `max by (service) (redis_memory_max_bytes{${rd}})`,
  rdClients: `max by (service) (redis_connected_clients{${rd}})`,
  rdKeys: `sum by (service) (redis_db_keys{${rd}})`,
  rdUptime: `max by (service) (redis_uptime_in_seconds{${rd}})`,
} as const;

export const DB_QUERY = unionQuery(DB_EXPRS);

export interface PostgresMetrics {
  scrapeUp: boolean | null;
  pgUp: boolean | null;
  version: string | null;
  sizeBytes: number | null;
  connections: number | null;
  maxConnections: number | null;
  cacheHitPct: number | null;
  tps: number | null;
}

export interface RedisMetrics {
  scrapeUp: boolean | null;
  redisUp: boolean | null;
  version: string | null;
  memUsedBytes: number | null;
  memMaxBytes: number | null;
  clients: number | null;
  keys: number | null;
  uptimeSec: number | null;
}

export interface DbMetrics {
  postgres: Record<string, PostgresMetrics>;
  redis: Record<string, RedisMetrics>;
}

const fin = (v: number | undefined): number | null => (v === undefined || !Number.isFinite(v) ? null : v);
const flag = (v: number | undefined): boolean | null => (v === undefined || !Number.isFinite(v) ? null : v >= 1);

export async function fetchDbMetrics(client: PromClient, signal?: AbortSignal): Promise<DbMetrics> {
  const samples = await client.instant(DB_QUERY, signal);
  const values = new Map<string, Record<string, number>>();
  const versions = new Map<string, string>();
  for (const s of samples) {
    const { service, metric } = s.labels;
    if (!service || !metric) continue;
    const key = `${metric.startsWith("pg") ? "pg" : "rd"}/${service}`;
    if (metric === "pgVersion" && s.labels.short_version) versions.set(key, s.labels.short_version);
    else if (metric === "rdVersion" && s.labels.redis_version) versions.set(key, s.labels.redis_version);
    else values.set(key, { ...(values.get(key) ?? {}), [metric]: s.value });
  }
  const out: DbMetrics = { postgres: {}, redis: {} };
  const keys = new Set([...values.keys(), ...versions.keys()]);
  for (const key of [...keys].sort()) {
    const [kind, service] = [key.slice(0, 2), key.slice(3)];
    const m = values.get(key) ?? {};
    if (kind === "pg") {
      out.postgres[service] = {
        scrapeUp: flag(m.pgScrape),
        pgUp: flag(m.pgUp),
        version: versions.get(key) ?? null,
        sizeBytes: fin(m.pgSize),
        connections: fin(m.pgConns),
        maxConnections: fin(m.pgMaxConns),
        cacheHitPct: fin(m.pgCacheHit),
        tps: fin(m.pgTps),
      };
    } else {
      out.redis[service] = {
        scrapeUp: flag(m.rdScrape),
        redisUp: flag(m.rdUp),
        version: versions.get(key) ?? null,
        memUsedBytes: fin(m.rdMem),
        memMaxBytes: fin(m.rdMemMax),
        clients: fin(m.rdClients),
        keys: fin(m.rdKeys),
        uptimeSec: fin(m.rdUptime),
      };
    }
  }
  return out;
}

export const DB_SOURCES = { metrics: "db:prom" } as const;

export function registerDbSources(store: Store, client: PromClient, base: Omit<SourceOptions, "ttlMs">): void {
  store.register(DB_SOURCES.metrics, (signal) => fetchDbMetrics(client, signal), { ...base, ttlMs: PROM_TTL.instantMs });
}
