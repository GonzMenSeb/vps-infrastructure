import { z } from "zod";
import type { SourceOptions, Store } from "../store";

export interface LogFilter {
  host?: string;
  container?: string;
  text?: string;
}

export interface LogLine {
  ts: string;
  line: string;
  host: string;
  container: string;
  level: string | null;
  truncated: boolean;
}

export interface LogTarget {
  host: string;
  container: string;
}

export interface LogTargets {
  targets: LogTarget[];
  hosts: string[];
  envs: string[];
}

export const MAX_FILTER_TEXT = 200;
export const DEFAULT_MAX_LINE_LENGTH = 4000;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const NS = /^\d{1,19}$/;

export class FilterError extends Error {}
export class LokiError extends Error {}

export function normalizeFilter(input: LogFilter): LogFilter {
  const out: LogFilter = {};
  for (const key of ["host", "container"] as const) {
    const v = input[key]?.trim();
    if (!v) continue;
    if (!LABEL_VALUE.test(v)) throw new FilterError(`invalid ${key}`);
    out[key] = v;
  }
  const text = input.text?.trim();
  if (text) {
    if (text.length > MAX_FILTER_TEXT) throw new FilterError("text filter too long");
    if (/[\x00-\x1f\x7f`]/.test(text)) throw new FilterError("text filter has forbidden characters");
    out.text = text;
  }
  return out;
}

export function filterKey(filter: LogFilter): string {
  const f = normalizeFilter(filter);
  return JSON.stringify([f.host ?? "", f.container ?? "", f.text?.toLowerCase() ?? ""]);
}

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildQuery(filter: LogFilter): string {
  const f = normalizeFilter(filter);
  const matchers = [f.host ? `host="${f.host}"` : `host=~".+"`];
  if (f.container) matchers.push(`container="${f.container}"`);
  const stage = f.text ? ` |~ \`(?i)${regexEscape(f.text)}\`` : "";
  return `{${matchers.join(",")}}${stage}`;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function cleanLine(raw: string, maxLength = DEFAULT_MAX_LINE_LENGTH): { line: string; truncated: boolean } {
  const line = raw.replace(ANSI, "").replace(/\r$/, "");
  return line.length > maxLength ? { line: line.slice(0, maxLength), truncated: true } : { line, truncated: false };
}

export const compareNs = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export const nextNs = (ts: string): string => (BigInt(ts) + 1n).toString();

const streamSchema = z.object({
  stream: z.record(z.string(), z.string()),
  values: z.array(z.tuple([z.string().regex(NS), z.string()]).rest(z.unknown())),
});

export function linesFromStreams(streams: z.infer<typeof streamSchema>[], maxLength = DEFAULT_MAX_LINE_LENGTH): LogLine[] {
  const out: LogLine[] = [];
  for (const s of streams) {
    for (const [ts, raw] of s.values) {
      const { line, truncated } = cleanLine(raw, maxLength);
      out.push({
        ts,
        line,
        host: s.stream.host ?? "",
        container: s.stream.container ?? "",
        level: s.stream.detected_level ?? s.stream.level ?? null,
        truncated,
      });
    }
  }
  return out.sort((a, b) => compareNs(a.ts, b.ts));
}

const queryRangeSchema = z.object({
  status: z.literal("success"),
  data: z.object({ resultType: z.literal("streams"), result: z.array(streamSchema) }),
});

const valuesSchema = z.object({ status: z.literal("success"), data: z.array(z.string()) });

const seriesSchema = z.object({
  status: z.literal("success"),
  data: z.array(z.record(z.string(), z.string())),
});

export const tailFrameSchema = z.object({
  streams: z.array(streamSchema).default([]),
  dropped_entries: z.array(z.unknown()).nullish(),
});

export interface BacklogOptions {
  limit?: number;
  lookbackMs?: number;
  afterNs?: string;
  signal?: AbortSignal;
  maxLineLength?: number;
}

export interface LokiClientOptions {
  timeoutMs?: number;
  maxBacklog?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DAY_MS = 86_400_000;

export class LokiClient {
  readonly maxBacklog: number;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;

  constructor(readonly baseUrl: string, opts: LokiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxBacklog = opts.maxBacklog ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private startNs(lookbackMs: number): string {
    return ((BigInt(this.now()) - BigInt(lookbackMs)) * 1_000_000n).toString();
  }

  tailUrl(filter: LogFilter, startNs: string, limit: number): string {
    const u = new URL(`${this.baseUrl}/loki/api/v1/tail`);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("query", buildQuery(filter));
    u.searchParams.set("start", startNs);
    u.searchParams.set("limit", String(limit));
    return u.toString();
  }

  private async getJson(path: string, params: Record<string, string | string[]>, signal?: AbortSignal): Promise<unknown> {
    const u = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, item);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(u, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new LokiError(`loki ${path}: HTTP ${res.status}${body ? ` ${body}` : ""}`);
    }
    return res.json();
  }

  async labelValues(label: string, signal?: AbortSignal, lookbackMs = DAY_MS): Promise<string[]> {
    if (!LABEL_VALUE.test(label)) throw new FilterError("invalid label");
    const raw = await this.getJson(`/loki/api/v1/label/${label}/values`, { start: this.startNs(lookbackMs) }, signal);
    return valuesSchema.parse(raw).data.sort();
  }

  async targets(signal?: AbortSignal, lookbackMs = DAY_MS): Promise<LogTargets> {
    const raw = await this.getJson(
      "/loki/api/v1/series",
      { "match[]": ['{container=~".+"}'], start: this.startNs(lookbackMs) },
      signal,
    );
    const seen = new Map<string, LogTarget>();
    const envs = new Set<string>();
    for (const s of seriesSchema.parse(raw).data) {
      if (!s.container || !s.host) continue;
      seen.set(`${s.host}\u0000${s.container}`, { host: s.host, container: s.container });
      if (s.env) envs.add(s.env);
    }
    const targets = [...seen.values()].sort((a, b) => a.host.localeCompare(b.host) || a.container.localeCompare(b.container));
    return { targets, hosts: [...new Set(targets.map((t) => t.host))], envs: [...envs].sort() };
  }

  async backlog(filter: LogFilter, opts: BacklogOptions = {}): Promise<LogLine[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, this.maxBacklog));
    const nowNs = BigInt(this.now()) * 1_000_000n;
    const forward = opts.afterNs !== undefined;
    if (forward && !NS.test(opts.afterNs!)) throw new FilterError("invalid resume timestamp");
    const lookback = Math.min(opts.lookbackMs ?? DAY_MS, 14 * DAY_MS);
    const params: Record<string, string> = {
      query: buildQuery(filter),
      limit: String(limit),
      direction: forward ? "forward" : "backward",
      start: forward ? nextNs(opts.afterNs!) : (nowNs - BigInt(lookback) * 1_000_000n).toString(),
      end: (nowNs + 60_000_000_000n).toString(),
    };
    const raw = await this.getJson("/loki/api/v1/query_range", params, opts.signal);
    const lines = linesFromStreams(queryRangeSchema.parse(raw).data.result, opts.maxLineLength);
    return lines.slice(-limit);
  }
}

export const LOKI_SOURCES = { targets: "loki:targets" } as const;

export const LOKI_TTL = { targetsMs: 60_000 } as const;

export function registerLokiSources(store: Store, client: LokiClient, base: Omit<SourceOptions, "ttlMs">): void {
  store.register(LOKI_SOURCES.targets, (signal) => client.targets(signal), { ...base, ttlMs: LOKI_TTL.targetsMs });
}
