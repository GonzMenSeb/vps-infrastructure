import { z } from "zod";
import type { Config } from "../config";
import type { SourceOptions, Store } from "../store";

export const PDNS_REQUEST_TIMEOUT_MS = 10_000;
export const PDNS_SERVER = "localhost";
export const PANEL_COMMENT = "managed-by: panel";
export const PANEL_ACCOUNT = "panel";
export const ZONE_ID = /^(?!\.+$)[A-Za-z0-9._=-]{1,255}$/;

export class PdnsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type DnsOwner = "panel" | "other" | "zone";

export interface DnsRecord {
  content: string;
  disabled: boolean;
}

export interface DnsRecordSet {
  name: string;
  type: string;
  ttl: number;
  records: DnsRecord[];
  owner: DnsOwner;
}

export interface DnsZone {
  id: string;
  name: string;
  kind: string | null;
  rrsets: DnsRecordSet[];
}

export interface DnsSnapshot {
  zones: DnsZone[];
}

export interface PdnsStats {
  uptimeSec: number | null;
  backendQueries: number | null;
  backendLatencyUs: number | null;
  servfailPackets: number | null;
  timedoutPackets: number | null;
  queueSize: number | null;
}

const zoneListSchema = z.array(z.object({ id: z.string(), name: z.string(), kind: z.string().nullish() }));

const rrsetSchema = z.object({
  name: z.string(),
  type: z.string(),
  ttl: z.number(),
  records: z.array(z.object({ content: z.string(), disabled: z.boolean().optional() })),
  comments: z.array(z.object({ content: z.string() })).nullish(),
});

const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string().nullish(),
  rrsets: z.array(rrsetSchema),
});

const statsSchema = z.array(z.object({ name: z.string(), type: z.string(), value: z.unknown() }));

export interface PatchRrset {
  name: string;
  type: string;
  changetype: "REPLACE" | "DELETE";
  ttl?: number;
  records?: DnsRecord[];
  comments?: { content: string; account: string }[];
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 2000);
    const msg = (JSON.parse(text) as { error?: string }).error;
    return msg ? ` (${msg})` : "";
  } catch {
    return "";
  }
}

export class PdnsClient {
  private base: string;

  constructor(
    baseUrl: string,
    private apiKey: string,
    private timeoutMs = PDNS_REQUEST_TIMEOUT_MS,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  get host(): string {
    return new URL(this.base).host;
  }

  async request(method: "GET" | "PATCH", path: string, opts: { body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const res = await fetch(`${this.base}/api/v1/servers/${PDNS_SERVER}${path}`, {
      method,
      headers: { "x-api-key": this.apiKey, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
      signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await errorDetail(res);
      await res.body?.cancel().catch(() => {});
      throw new PdnsError(res.status, `pdns ${method} ${path.split("?")[0]}: HTTP ${res.status}${detail}`);
    }
    return res;
  }

  async zones(signal?: AbortSignal): Promise<{ id: string; name: string; kind: string | null }[]> {
    const list = zoneListSchema.parse(await (await this.request("GET", "/zones", { signal })).json());
    return list.map((z) => ({ id: z.id, name: z.name, kind: z.kind ?? null }));
  }

  async zone(id: string, signal?: AbortSignal): Promise<DnsZone> {
    if (!ZONE_ID.test(id)) throw new Error(`invalid zone id: ${id}`);
    const raw = zoneSchema.parse(await (await this.request("GET", `/zones/${encodeURIComponent(id)}`, { signal })).json());
    return {
      id: raw.id,
      name: raw.name,
      kind: raw.kind ?? null,
      rrsets: raw.rrsets.map((r) => ({
        name: r.name,
        type: r.type,
        ttl: r.ttl,
        records: r.records.map((x) => ({ content: x.content, disabled: x.disabled === true })),
        owner: ownerOf(raw.name, r.name, r.type, (r.comments ?? []).map((c) => c.content)),
      })),
    };
  }

  async patch(id: string, rrsets: PatchRrset[], signal?: AbortSignal): Promise<void> {
    if (!ZONE_ID.test(id)) throw new Error(`invalid zone id: ${id}`);
    const res = await this.request("PATCH", `/zones/${encodeURIComponent(id)}`, { body: { rrsets }, signal });
    await res.body?.cancel().catch(() => {});
  }

  async statistics(signal?: AbortSignal): Promise<PdnsStats> {
    const items = statsSchema.parse(await (await this.request("GET", "/statistics?includerings=false", { signal })).json());
    const num = (name: string): number | null => {
      const item = items.find((i) => i.name === name && i.type === "StatisticItem");
      const n = typeof item?.value === "string" || typeof item?.value === "number" ? Number(item.value) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    return {
      uptimeSec: num("uptime"),
      backendQueries: num("backend-queries"),
      backendLatencyUs: num("backend-latency"),
      servfailPackets: num("servfail-packets"),
      timedoutPackets: num("timedout-packets"),
      queueSize: num("qsize-q"),
    };
  }
}

export function pdnsClientFromConfig(cfg: Pick<Config, "PDNS_API_URL" | "PDNS_API_KEY">): PdnsClient | null {
  if (!cfg.PDNS_API_URL || !cfg.PDNS_API_KEY) return null;
  return new PdnsClient(cfg.PDNS_API_URL, cfg.PDNS_API_KEY);
}

export function ownerOf(zoneName: string, name: string, type: string, comments: readonly string[]): DnsOwner {
  if (name === zoneName && (type === "SOA" || type === "NS")) return "zone";
  return comments.some((c) => c.trim() === PANEL_COMMENT) ? "panel" : "other";
}

export async function fetchDns(client: PdnsClient, signal?: AbortSignal): Promise<DnsSnapshot> {
  const list = await client.zones(signal);
  const zones: DnsZone[] = [];
  for (const z of list) zones.push(await client.zone(z.id, signal));
  return { zones: zones.sort((a, b) => a.name.localeCompare(b.name)) };
}

export const PDNS_SOURCES = { zones: "pdns:zones", stats: "pdns:stats" } as const;

export const PDNS_TTL = { zonesMs: 30_000, statsMs: 30_000, minTimeoutMs: 5_000 } as const;

export function registerPdnsSources(store: Store, client: PdnsClient, base: Omit<SourceOptions, "ttlMs">): void {
  const timeoutMs = Math.max(base.timeoutMs, PDNS_TTL.minTimeoutMs);
  store.register(PDNS_SOURCES.zones, (signal) => fetchDns(client, signal), { ...base, ttlMs: PDNS_TTL.zonesMs, timeoutMs });
  store.register(PDNS_SOURCES.stats, (signal) => client.statistics(signal), { ...base, ttlMs: PDNS_TTL.statsMs, timeoutMs });
}
