import { readFileSync } from "node:fs";

interface Entry {
  ts: string;
  host: string;
  container: string;
  line: string;
}

export interface FakeLokiOptions {
  intervalMs?: number;
  seedLines?: number;
  manifestPath?: string;
  now?: () => number;
}

export interface FakeLoki {
  url: string;
  stats: { upgrades: number; open: number; requests: number };
  setDown: (down: boolean) => void;
  stop: () => Promise<void>;
}

interface Target {
  host: string;
  container: string;
}

const UNSHIPPED = new Set(["cadvisor", "alloy", "blackbox-exporter", "process-exporter", "tempo", "promtail"]);
const RING_MAX = 5000;

function targetsFrom(manifestPath: string): Target[] {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { services: { host: string; containers: string[] }[] };
  const seen = new Map<string, Target>();
  for (const s of m.services) for (const c of s.containers) if (!UNSHIPPED.has(c)) seen.set(`${s.host}/${c}`, { host: s.host, container: c });
  return [...seen.values()];
}

const SAMPLES: ((c: string, i: number) => string)[] = [
  (c, i) => `\u001b[90m2026-11-03T10:00:${String(i % 60).padStart(2, "0")}\u001b[0m \u001b[94m[INFO]\u001b[0m ${c}: request ${200 + (i % 3)} GET /health in ${i % 40}ms`,
  (c, i) => `level=info msg="checkpoint complete" component=${c} seq=${i}`,
  (c, i) => `${c}: connection from 192.0.2.${i % 250} accepted`,
  (c, i) => (i % 9 === 0 ? `level=warn msg="slow query" component=${c} took=${300 + i}ms` : `level=debug msg="cache hit" component=${c} key=k${i}`),
  (c, i) => (i % 17 === 0 ? `ERROR ${c}: upstream timed out after 2000ms (attempt ${i})` : `${c}: heartbeat ${i}`),
];

export function startFakeLoki(opts: FakeLokiOptions = {}): FakeLoki {
  const now = opts.now ?? (() => Date.now());
  const targets = targetsFrom(opts.manifestPath ?? "tests/fixtures/dev-services.json");
  const ring: Entry[] = [];
  const sockets = new Map<{ send: (s: string) => void; close: () => void }, (e: Entry) => boolean>();
  const stats = { upgrades: 0, open: 0, requests: 0 };
  let down = false;
  let seq = 0;
  let lastNs = BigInt(now()) * 1_000_000n;

  const emit = (): Entry => {
    const t = targets[seq % targets.length]!;
    const sample = SAMPLES[seq % SAMPLES.length]!;
    lastNs = BigInt(now()) * 1_000_000n > lastNs ? BigInt(now()) * 1_000_000n : lastNs + 1n;
    const e: Entry = { ts: lastNs.toString(), host: t.host, container: t.container, line: sample(t.container, seq) };
    seq += 1;
    ring.push(e);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    return e;
  };

  const seed = opts.seedLines ?? 400;
  const stepMs = 700;
  for (let i = 0; i < seed; i++) emit().ts = (BigInt(now() - (seed - i) * stepMs) * 1_000_000n + BigInt(i)).toString();
  lastNs = BigInt(now()) * 1_000_000n;

  const parse = (query: string): ((e: Entry) => boolean) => {
    const host = /host="([^"]+)"/.exec(query)?.[1];
    const container = /container="([^"]+)"/.exec(query)?.[1];
    const textRaw = /\|~ `\(\?i\)([^`]*)`/.exec(query)?.[1];
    const text = textRaw?.replace(/\\(.)/g, "$1").toLowerCase();
    return (e) => (!host || e.host === host) && (!container || e.container === container) && (!text || e.line.toLowerCase().includes(text));
  };

  const frame = (e: Entry) => ({
    streams: [{ stream: { host: e.host, container: e.container, env: "prod", compose_service: e.container }, values: [[e.ts, e.line]] }],
  });

  const timer = setInterval(() => {
    if (down) return;
    const e = emit();
    for (const [ws, match] of sockets) if (match(e)) ws.send(JSON.stringify(frame(e)));
  }, opts.intervalMs ?? 450);
  timer.unref();

  const server = Bun.serve<{ match: (e: Entry) => boolean }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      stats.requests += 1;
      if (down) return new Response("loki is down", { status: 503 });
      if (u.pathname === "/loki/api/v1/tail") {
        const ok = srv.upgrade(req, { data: { match: parse(u.searchParams.get("query") ?? "") } });
        if (ok) {
          stats.upgrades += 1;
          return undefined;
        }
        return new Response("expected a websocket", { status: 400 });
      }
      if (u.pathname === "/loki/api/v1/series") {
        const data = [
          ...targets.map((t) => ({ host: t.host, container: t.container, env: "prod", compose_service: t.container, service_name: t.container })),
          { host: "vps", env: "prod", unit: "ssh.service" },
        ];
        return Response.json({ status: "success", data });
      }
      if (u.pathname === "/loki/api/v1/query_range") {
        const match = parse(u.searchParams.get("query") ?? "");
        const limit = Number(u.searchParams.get("limit") ?? 100);
        const start = BigInt(u.searchParams.get("start") ?? "0");
        const forward = u.searchParams.get("direction") === "forward";
        let hits = ring.filter((e) => match(e) && BigInt(e.ts) >= start);
        hits = forward ? hits.slice(0, limit) : hits.slice(-limit).reverse();
        const by = new Map<string, Entry[]>();
        for (const e of hits) by.set(`${e.host}/${e.container}`, [...(by.get(`${e.host}/${e.container}`) ?? []), e]);
        const result = [...by.values()].map((es) => ({
          stream: { host: es[0]!.host, container: es[0]!.container, env: "prod" },
          values: es.map((e) => [e.ts, e.line]),
        }));
        return Response.json({ status: "success", data: { resultType: "streams", result, stats: {} } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        stats.open += 1;
        sockets.set(ws, ws.data.match);
      },
      close(ws) {
        stats.open -= 1;
        sockets.delete(ws);
      },
      message() {},
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stats,
    setDown: (d) => {
      down = d;
      if (d) for (const ws of [...sockets.keys()]) ws.close();
    },
    stop: async () => {
      clearInterval(timer);
      await server.stop(true);
    },
  };
}
