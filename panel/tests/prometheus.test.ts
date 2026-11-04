import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CADVISOR_RATE_WINDOW_SEC,
  NODE_RATE_WINDOW_SEC,
  PromClient,
  QUERIES,
  PROM_SOURCES,
  SERIES_STEP_SEC,
  fetchContainerMetrics,
  fetchHostMetrics,
  fetchHostSeries,
  registerPrometheusSources,
  seriesQuery,
} from "../src/collectors/prometheus";
import { Store } from "../src/store";
import hostsFixture from "./fixtures/prometheus-hosts.json";
import containersFixture from "./fixtures/prometheus-containers.json";
import seriesFixture from "./fixtures/prometheus-series.json";

interface Call {
  path: string;
  params: URLSearchParams;
}

const calls: Call[] = [];
let handler: (c: Call) => Response = () => Response.json({ status: "success", data: { resultType: "vector", result: [] } });
let server: ReturnType<typeof Bun.serve>;
let client: PromClient;

const vec = (result: unknown[]) => Response.json({ status: "success", data: { resultType: "vector", result } });
const mat = (result: unknown[]) => Response.json({ status: "success", data: { resultType: "matrix", result } });
const hs = (host: string, metric: string, v: number) => ({ metric: { host, metric }, value: [1, String(v)] });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const params = new URLSearchParams(await req.text());
      const call = { path: url.pathname, params };
      calls.push(call);
      return handler(call);
    },
  });
  client = new PromClient(`http://localhost:${server.port}/`);
});
afterAll(() => server.stop(true));

describe("queries", () => {
  test("group by host (never instance) and use rate windows >= 1m", () => {
    for (const q of Object.values(QUERIES)) {
      expect(q).not.toContain("instance");
      expect(q).toContain("host");
      for (const m of q.matchAll(/\[(\d+)([smh])\]/g)) {
        const sec = Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"];
        expect(sec).toBeGreaterThanOrEqual(60);
      }
    }
  });

  const windows = (q: string) =>
    [...q.matchAll(/rate\((\w+)[^\[]*\[(\d+)([smh])\]\)/g)].map((m) => ({
      metric: m[1]!,
      sec: Number(m[2]) * { s: 1, m: 60, h: 3600 }[m[3] as "s" | "m" | "h"],
    }));

  test("rate windows tolerate the observed sample age: node >= 2m, cAdvisor >= 3m", () => {
    expect(NODE_RATE_WINDOW_SEC).toBeGreaterThanOrEqual(120);
    expect(CADVISOR_RATE_WINDOW_SEC).toBeGreaterThanOrEqual(180);
    const all = [QUERIES.hosts, QUERIES.containers, QUERIES.series].flatMap(windows);
    expect(all).toHaveLength(9);
    for (const w of all) {
      expect(w.sec).toBeGreaterThanOrEqual(w.metric.startsWith("container_") ? CADVISOR_RATE_WINDOW_SEC : NODE_RATE_WINDOW_SEC);
    }
  });

  test("series rate windows cover the whole step, never below the node minimum", () => {
    expect(windows(QUERIES.series)).toHaveLength(3);
    for (const w of windows(QUERIES.series)) expect(w.sec).toBe(SERIES_STEP_SEC);
    for (const w of windows(seriesQuery(30))) expect(w.sec).toBe(NODE_RATE_WINDOW_SEC);
    expect(QUERIES.series).toBe(seriesQuery(SERIES_STEP_SEC));
  });

  test("container queries group by (name, host)", () => {
    const groups = [...QUERIES.containers.matchAll(/by \(([^)]*)\)/g)].map((m) => m[1]);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(g).toBe("name, host");
    expect(QUERIES.containers).toContain('name!=""');
  });
});

describe("fetchHostMetrics", () => {
  test("one batched instant query, assembled per host with derived used values", async () => {
    calls.length = 0;
    handler = () =>
      vec([
        hs("vps", "cpuPct", 12.5),
        hs("vps", "memTotal", 1000),
        hs("vps", "memAvail", 400),
        hs("vps", "swapTotal", 100),
        hs("vps", "swapFree", 90),
        hs("vps", "diskTotal", 5000),
        hs("vps", "diskAvail", 2000),
        hs("vps", "cores", 4),
        hs("vps", "load1", 0.8),
        hs("vps", "load5", 0.7),
        hs("vps", "load15", 0.6),
        hs("vps", "uptimeSec", 3600),
        { metric: { host: "vps", metric: "os", pretty_name: "Ubuntu 24.04 LTS" }, value: [1, "1"] },
        hs("vps", "rxBps", 10),
        hs("vps", "txBps", 5),
        hs("vps", "containers", 24),
        hs("jenkins", "cpuPct", 3),
        hs("jenkins", "memTotal", 500),
      ]);
    const hosts = await fetchHostMetrics(client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/v1/query");
    expect(calls[0]!.params.get("query")).toBe(QUERIES.hosts);
    expect(hosts.map((h) => h.host)).toEqual(["jenkins", "vps"]);
    const vps = hosts[1]!;
    expect(vps).toMatchObject({
      cpuPct: 12.5, cores: 4, memTotal: 1000, memUsed: 600, swapUsed: 10, diskUsed: 3000, load1: 0.8, load5: 0.7, load15: 0.6,
      uptimeSec: 3600, os: "Ubuntu 24.04 LTS", rxBps: 10, txBps: 5, containers: 24,
    });
    expect(hosts[0]).toMatchObject({ cpuPct: 3, memTotal: 500, memUsed: null, diskTotal: null, load1: null, os: null, cores: null });
  });

  test("ignores samples lacking host or metric, and NaN values become null", async () => {
    handler = () => vec([{ metric: { metric: "cpuPct" }, value: [1, "5"] }, hs("vps", "load1", NaN), hs("vps", "txBps", 1)]);
    const [h] = await fetchHostMetrics(client);
    expect(h).toMatchObject({ host: "vps", load1: null, txBps: 1 });
  });

  test("Prometheus error payloads surface as errors", async () => {
    handler = () => Response.json({ status: "error", errorType: "bad_data", error: "parse error" }, { status: 400 });
    await expect(fetchHostMetrics(client)).rejects.toThrow(/bad_data: parse error/);
  });

  test("non-JSON and unexpected shapes are rejected", async () => {
    handler = () => new Response("oops", { status: 502 });
    await expect(fetchHostMetrics(client)).rejects.toThrow(/HTTP 502/);
    handler = () => mat([]);
    await expect(fetchHostMetrics(client)).rejects.toThrow();
  });

  test("an aborted signal cancels the request", async () => {
    handler = () => new Response(null, { status: 500 });
    const ctl = new AbortController();
    ctl.abort();
    await expect(fetchHostMetrics(client, ctl.signal)).rejects.toThrow();
  });
});

describe("fetchContainerMetrics", () => {
  test("keys by host and name, so the same name on two hosts stays separate", async () => {
    handler = () =>
      vec([
        { metric: { host: "vps", name: "traefik", metric: "cpuPct" }, value: [1, "1.5"] },
        { metric: { host: "vps", name: "traefik", metric: "memBytes" }, value: [1, "2048"] },
        { metric: { host: "jenkins", name: "traefik", metric: "rxBps" }, value: [1, "7"] },
        { metric: { host: "vps", name: "zot", metric: "txBps" }, value: [1, "9"] },
        { metric: { host: "vps", name: "zot", metric: "unknown" }, value: [1, "9"] },
      ]);
    const rows = await fetchContainerMetrics(client);
    expect(rows.map((r) => `${r.host}/${r.name}`)).toEqual(["jenkins/traefik", "vps/traefik", "vps/zot"]);
    expect(rows[1]).toEqual({ name: "traefik", host: "vps", cpuPct: 1.5, memBytes: 2048, rxBps: null, txBps: null });
    expect(rows[0]).toMatchObject({ rxBps: 7, cpuPct: null });
    expect(rows[2]).toMatchObject({ txBps: 9 });
  });
});

describe("fetchHostSeries", () => {
  const nowMs = 1_800_000_000_000;
  const step = 288;
  const end = Math.floor(nowMs / 1000 / step) * step;
  const start = end - 86400;

  test("sends one range query aligned to the step with a >=30s step", async () => {
    calls.length = 0;
    handler = () => mat([]);
    await fetchHostSeries(client, undefined, nowMs);
    expect(calls).toHaveLength(1);
    const p = calls[0]!.params;
    expect(calls[0]!.path).toBe("/api/v1/query_range");
    expect(p.get("start")).toBe(String(start));
    expect(p.get("end")).toBe(String(end));
    expect(p.get("step")).toBe("288s");
    expect(p.get("query")).toBe(QUERIES.series);
  });

  test("rejects steps below 30s", async () => {
    await expect(fetchHostSeries(client, undefined, nowMs, 15)).rejects.toThrow(/>= 30s/);
  });

  test("builds fixed-length grids, forward-filling gaps and back-filling the lead", async () => {
    const pt = (i: number, v: number) => [start + i * step, String(v)];
    handler = () =>
      mat([
        { metric: { host: "jenkins", metric: "cpu" }, values: [pt(2, 5), pt(3, 6), pt(300, 9)] },
        { metric: { host: "vps", metric: "cpu" }, values: [pt(0, 1), pt(1, 2), pt(4, 3)] },
        { metric: { host: "vps", metric: "mem" }, values: [pt(0, 50)] },
      ]);
    const series = await fetchHostSeries(client, undefined, nowMs);
    expect(series.map((s) => s.host)).toEqual(["jenkins", "vps"]);
    const [j, v] = series;
    expect(v!.cpu).toHaveLength(301);
    expect(v!.cpu.slice(0, 6)).toEqual([1, 2, 2, 2, 3, 3]);
    expect(v!.mem.every((x) => x === 50)).toBe(true);
    expect(v!.rx.every((x) => x === 0)).toBe(true);
    expect(j!.cpu.slice(0, 5)).toEqual([5, 5, 5, 6, 6]);
    expect(j!.cpu[300]).toBe(9);
    expect(v).toMatchObject({ startSec: start, stepSec: step, dataStartSec: start });
    expect(j!.dataStartSec).toBe(start + 2 * step);
  });
});

describe("live fixtures (sanitized responses captured from the real Prometheus)", () => {
  const HOST_KEYS = [
    "cpuPct", "cores", "memTotal", "memUsed", "swapTotal", "swapUsed", "diskTotal", "diskUsed",
    "load1", "load5", "load15", "uptimeSec", "os", "rxBps", "txBps", "containers",
  ] as const;

  test("hosts: both hosts return every field", async () => {
    handler = () => Response.json(hostsFixture);
    const hosts = await fetchHostMetrics(client);
    expect(hosts.map((h) => h.host)).toEqual(["jenkins", "vps"]);
    const raw = (host: string, metric: string) =>
      Number(hostsFixture.data.result.find((r) => r.metric.host === host && r.metric.metric === metric)!.value[1]);
    for (const h of hosts) {
      for (const k of HOST_KEYS) expect(h[k]).not.toBeNull();
      expect(h.memUsed).toBe(raw(h.host, "memTotal") - raw(h.host, "memAvail"));
      expect(h.diskUsed).toBe(raw(h.host, "diskTotal") - raw(h.host, "diskAvail"));
      expect(h.cpuPct!).toBeGreaterThanOrEqual(0);
      expect(h.cpuPct!).toBeLessThanOrEqual(100);
      expect(Number.isInteger(h.cores)).toBe(true);
      expect(h.os).toMatch(/^Ubuntu /);
    }
  });

  test("containers: every container on both hosts has cpu, memory and network", async () => {
    handler = () => Response.json(containersFixture);
    const rows = await fetchContainerMetrics(client);
    expect(new Set(rows.map((r) => r.host))).toEqual(new Set(["jenkins", "vps"]));
    for (const r of rows) {
      expect(r.cpuPct).not.toBeNull();
      expect(r.memBytes).not.toBeNull();
      expect(r.rxBps).not.toBeNull();
      expect(r.txBps).not.toBeNull();
    }
    const traefik = rows.filter((r) => r.name === "traefik").map((r) => r.host);
    expect(traefik).toEqual(["jenkins", "vps"]);
    handler = () => Response.json(hostsFixture);
    for (const h of await fetchHostMetrics(client)) expect(rows.filter((r) => r.host === h.host)).toHaveLength(h.containers!);
  });

  test("series: 301-point grids for both hosts, with dataStartSec marking where real data begins", async () => {
    const { params, body } = seriesFixture;
    calls.length = 0;
    handler = () => Response.json(body);
    const series = await fetchHostSeries(client, undefined, params.end * 1000 + 1000, params.step);
    const p = calls[0]!.params;
    expect([p.get("start"), p.get("end"), p.get("step")]).toEqual([String(params.start), String(params.end), `${params.step}s`]);
    expect(series.map((s) => s.host)).toEqual(["jenkins", "vps"]);
    for (const s of series) {
      const own = body.data.result.filter((r) => r.metric.host === s.host);
      expect(own).toHaveLength(6);
      const first = Math.min(...own.map((r) => r.values[0]![0] as number));
      expect(s.dataStartSec).toBe(first);
      for (const k of ["cpu", "mem", "rx", "tx", "load", "containers"] as const) {
        expect(s[k]).toHaveLength(301);
        const src = own.find((r) => r.metric.metric === k)!;
        expect(s[k][300]).toBe(Number(src.values[src.values.length - 1]![1]));
      }
    }
  });
});

describe("registerPrometheusSources", () => {
  test("registers three store sources; series is cached 60s", async () => {
    let t = 1_800_000_000_000;
    const store = new Store(() => t);
    const base = { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 1000 };
    calls.length = 0;
    handler = (c) => (c.path.endsWith("query_range") ? mat([]) : vec([hs("vps", "cpuPct", 1)]));
    registerPrometheusSources(store, client, base, () => t);
    expect(store.names().sort()).toEqual(Object.values(PROM_SOURCES).sort());
    const s = await store.refresh<{ host: string }[]>(PROM_SOURCES.hosts);
    expect(s.data?.[0]?.host).toBe("vps");
    await store.refresh(PROM_SOURCES.series);
    t += 59_000;
    expect(store.get(PROM_SOURCES.series).stale).toBe(false);
    t += 2_000;
    expect(store.get(PROM_SOURCES.series).stale).toBe(true);
  });
});
