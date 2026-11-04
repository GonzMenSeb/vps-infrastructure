import { z } from "zod";
import type { SourceOptions, Store } from "../store";

const vectorSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("vector"),
    result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: z.tuple([z.number(), z.string()]) })),
  }),
});

const matrixSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z.array(
      z.object({ metric: z.record(z.string(), z.string()), values: z.array(z.tuple([z.number(), z.string()])) }),
    ),
  }),
});

const errorSchema = z.object({ status: z.literal("error"), errorType: z.string().optional(), error: z.string() });

export interface Sample {
  labels: Record<string, string>;
  value: number;
}

export interface RangeSample {
  labels: Record<string, string>;
  points: [number, number][];
}

export class PromClient {
  constructor(private baseUrl: string) {}

  private async post(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`prometheus ${path}: HTTP ${res.status} with non-JSON body`);
    }
    const err = errorSchema.safeParse(body);
    if (err.success) throw new Error(`prometheus ${path}: ${err.data.errorType ?? "error"}: ${err.data.error}`);
    if (!res.ok) throw new Error(`prometheus ${path}: HTTP ${res.status}`);
    return body;
  }

  async instant(query: string, signal?: AbortSignal, atSec?: number): Promise<Sample[]> {
    const params: Record<string, string> = { query };
    if (atSec !== undefined) params.time = String(atSec);
    const parsed = vectorSchema.parse(await this.post("/api/v1/query", params, signal));
    return parsed.data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
  }

  async range(query: string, startSec: number, endSec: number, stepSec: number, signal?: AbortSignal): Promise<RangeSample[]> {
    const parsed = matrixSchema.parse(
      await this.post(
        "/api/v1/query_range",
        { query, start: String(startSec), end: String(endSec), step: `${stepSec}s` },
        signal,
      ),
    );
    return parsed.data.result.map((r) => ({
      labels: r.metric,
      points: r.values.map(([t, v]) => [t, Number(v)] as [number, number]),
    }));
  }
}

export const NODE_RATE_WINDOW_SEC = 120;
export const CADVISOR_RATE_WINDOW_SEC = 180;

const nodeCpu = (w: number) => `100 * (1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[${w}s])))`;
const nodeRx = (w: number) => `sum by (host) (rate(node_network_receive_bytes_total[${w}s]))`;
const nodeTx = (w: number) => `sum by (host) (rate(node_network_transmit_bytes_total[${w}s]))`;
const containerCount = 'count by (host) (container_memory_working_set_bytes{name!=""})';

const HOST_EXPRS = {
  cpuPct: nodeCpu(NODE_RATE_WINDOW_SEC),
  cores: 'count by (host) (node_cpu_seconds_total{mode="idle"})',
  memTotal: "sum by (host) (node_memory_MemTotal_bytes)",
  memAvail: "sum by (host) (node_memory_MemAvailable_bytes)",
  swapTotal: "sum by (host) (node_memory_SwapTotal_bytes)",
  swapFree: "sum by (host) (node_memory_SwapFree_bytes)",
  diskTotal: 'max by (host) (node_filesystem_size_bytes{mountpoint="/"})',
  diskAvail: 'max by (host) (node_filesystem_avail_bytes{mountpoint="/"})',
  load1: "max by (host) (node_load1)",
  load5: "max by (host) (node_load5)",
  load15: "max by (host) (node_load15)",
  uptimeSec: "max by (host) (node_time_seconds - node_boot_time_seconds)",
  os: "max by (host, pretty_name) (node_os_info)",
  rxBps: nodeRx(NODE_RATE_WINDOW_SEC),
  txBps: nodeTx(NODE_RATE_WINDOW_SEC),
  containers: containerCount,
} as const;

const cad = (m: string) => `sum by (name, host) (rate(${m}{name!=""}[${CADVISOR_RATE_WINDOW_SEC}s]))`;

const CONTAINER_EXPRS = {
  cpuPct: `100 * ${cad("container_cpu_usage_seconds_total")}`,
  memBytes: 'max by (name, host) (container_memory_working_set_bytes{name!=""})',
  rxBps: cad("container_network_receive_bytes_total"),
  txBps: cad("container_network_transmit_bytes_total"),
} as const;

const seriesExprs = (stepSec: number) => {
  const w = Math.max(stepSec, NODE_RATE_WINDOW_SEC);
  return {
    cpu: nodeCpu(w),
    mem: "100 * (1 - sum by (host) (node_memory_MemAvailable_bytes) / sum by (host) (node_memory_MemTotal_bytes))",
    rx: nodeRx(w),
    tx: nodeTx(w),
    load: HOST_EXPRS.load1,
    containers: containerCount,
  };
};

export function unionQuery(exprs: Record<string, string>): string {
  return Object.entries(exprs)
    .map(([k, e]) => `label_replace(${e}, "metric", "${k}", "", "")`)
    .join(" or ");
}

export const seriesQuery = (stepSec: number): string => unionQuery(seriesExprs(stepSec));

export const SERIES_SPAN_SEC = 24 * 3600;
export const SERIES_STEP_SEC = 288;

export const QUERIES = {
  hosts: unionQuery(HOST_EXPRS),
  containers: unionQuery(CONTAINER_EXPRS),
  series: seriesQuery(SERIES_STEP_SEC),
};

export interface HostMetrics {
  host: string;
  cpuPct: number | null;
  cores: number | null;
  memTotal: number | null;
  memUsed: number | null;
  swapTotal: number | null;
  swapUsed: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  uptimeSec: number | null;
  os: string | null;
  rxBps: number | null;
  txBps: number | null;
  containers: number | null;
}

export interface ContainerMetrics {
  name: string;
  host: string;
  cpuPct: number | null;
  memBytes: number | null;
  rxBps: number | null;
  txBps: number | null;
}

export interface HostSeries {
  host: string;
  startSec: number;
  stepSec: number;
  dataStartSec: number | null;
  cpu: number[];
  mem: number[];
  rx: number[];
  tx: number[];
  load: number[];
  containers: number[];
}

const fin = (v: number | undefined): number | null => (v === undefined || !Number.isFinite(v) ? null : v);
const sub = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.max(a - b, 0));

export async function fetchHostMetrics(client: PromClient, signal?: AbortSignal): Promise<HostMetrics[]> {
  const samples = await client.instant(QUERIES.hosts, signal);
  const byHost = new Map<string, Record<string, number>>();
  const osByHost = new Map<string, string>();
  for (const s of samples) {
    const host = s.labels.host;
    const metric = s.labels.metric;
    if (!host || !metric) continue;
    const m = byHost.get(host) ?? {};
    if (metric === "os") {
      if (s.labels.pretty_name) osByHost.set(host, s.labels.pretty_name);
    } else m[metric] = s.value;
    byHost.set(host, m);
  }
  return [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, m]) => {
      const memTotal = fin(m.memTotal);
      const swapTotal = fin(m.swapTotal);
      const diskTotal = fin(m.diskTotal);
      return {
        host,
        cpuPct: fin(m.cpuPct),
        cores: fin(m.cores),
        memTotal,
        memUsed: sub(memTotal, fin(m.memAvail)),
        swapTotal,
        swapUsed: sub(swapTotal, fin(m.swapFree)),
        diskTotal,
        diskUsed: sub(diskTotal, fin(m.diskAvail)),
        load1: fin(m.load1),
        load5: fin(m.load5),
        load15: fin(m.load15),
        uptimeSec: fin(m.uptimeSec),
        os: osByHost.get(host) ?? null,
        rxBps: fin(m.rxBps),
        txBps: fin(m.txBps),
        containers: fin(m.containers),
      };
    });
}

export async function fetchContainerMetrics(client: PromClient, signal?: AbortSignal): Promise<ContainerMetrics[]> {
  const samples = await client.instant(QUERIES.containers, signal);
  const byKey = new Map<string, ContainerMetrics & Record<string, unknown>>();
  for (const s of samples) {
    const { host, name, metric } = s.labels;
    if (!host || !name || !metric) continue;
    const key = `${host}/${name}`;
    const row =
      byKey.get(key) ??
      ({ name, host, cpuPct: null, memBytes: null, rxBps: null, txBps: null } as ContainerMetrics & Record<string, unknown>);
    if (metric === "cpuPct" || metric === "memBytes" || metric === "rxBps" || metric === "txBps") row[metric] = fin(s.value);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
}

export async function fetchHostSeries(
  client: PromClient,
  signal?: AbortSignal,
  nowMs: number = Date.now(),
  stepSec: number = SERIES_STEP_SEC,
): Promise<HostSeries[]> {
  if (stepSec < 30) throw new Error("range step must be >= 30s");
  const endSec = Math.floor(nowMs / 1000 / stepSec) * stepSec;
  const startSec = endSec - SERIES_SPAN_SEC;
  const len = Math.floor(SERIES_SPAN_SEC / stepSec) + 1;
  const samples = await client.range(seriesQuery(stepSec), startSec, endSec, stepSec, signal);
  const byHost = new Map<string, Map<string, Map<number, number>>>();
  for (const s of samples) {
    const { host, metric } = s.labels;
    if (!host || !metric) continue;
    const metrics = byHost.get(host) ?? new Map<string, Map<number, number>>();
    const grid = new Map<number, number>();
    for (const [t, v] of s.points) {
      const idx = Math.round((t - startSec) / stepSec);
      if (idx >= 0 && idx < len && Number.isFinite(v)) grid.set(idx, v);
    }
    metrics.set(metric, grid);
    byHost.set(host, metrics);
  }
  const fill = (grid: Map<number, number> | undefined): number[] => {
    if (!grid || grid.size === 0) return new Array<number>(len).fill(0);
    const firstIdx = Math.min(...grid.keys());
    let prev = grid.get(firstIdx)!;
    const out: number[] = [];
    for (let i = 0; i < len; i++) {
      prev = grid.get(i) ?? prev;
      out.push(prev);
    }
    return out;
  };
  const dataStart = (m: Map<string, Map<number, number>>): number | null => {
    const idx = [...m.values()].flatMap((g) => [...g.keys()]);
    return idx.length ? startSec + Math.min(...idx) * stepSec : null;
  };
  return [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, m]) => ({
      host,
      startSec,
      stepSec,
      dataStartSec: dataStart(m),
      cpu: fill(m.get("cpu")),
      mem: fill(m.get("mem")),
      rx: fill(m.get("rx")),
      tx: fill(m.get("tx")),
      load: fill(m.get("load")),
      containers: fill(m.get("containers")),
    }));
}

export const PROM_SOURCES = {
  hosts: "prom:hosts",
  containers: "prom:containers",
  series: "prom:series",
} as const;

export const PROM_TTL = { instantMs: 15_000, seriesMs: 60_000 } as const;

export function registerPrometheusSources(
  store: Store,
  client: PromClient,
  base: Omit<SourceOptions, "ttlMs">,
  now: () => number = () => Date.now(),
): void {
  const instant: SourceOptions = { ...base, ttlMs: PROM_TTL.instantMs };
  store.register(PROM_SOURCES.hosts, (signal) => fetchHostMetrics(client, signal), instant);
  store.register(PROM_SOURCES.containers, (signal) => fetchContainerMetrics(client, signal), instant);
  store.register(PROM_SOURCES.series, (signal) => fetchHostSeries(client, signal, now()), {
    ...base,
    ttlMs: PROM_TTL.seriesMs,
  });
}
