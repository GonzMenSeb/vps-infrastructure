import { githubClient } from "../../src/auth/github";
import { LokiClient } from "../../src/collectors/loki";
import { loadConfig } from "../../src/config";
import { openDb } from "../../src/db";
import { TailHub } from "../../src/logs/hub";
import { loadManifest } from "../../src/manifest";
import { Poller } from "../../src/poller";
import { createApp } from "../../src/server";
import { Store } from "../../src/store";
import { startFakeLoki } from "./loki-fixture";

const CLIENTS = Number(process.env.CLIENTS ?? 50);
const CYCLES = Number(process.env.CYCLES ?? 10);
const ORIGIN = "http://localhost:3999";

const loki = startFakeLoki({ intervalMs: 20 });
const cfg = loadConfig({
  PUBLIC_URL: ORIGIN,
  SERVICES_MANIFEST_PATH: "x",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ALLOWED_LOGIN: "owner",
  SESSION_SECRET: "x".repeat(40),
  NODE_ENV: "test",
  DEV_AUTH_BYPASS: "1",
  LOKI_URL: loki.url,
});
const lokiClient = new LokiClient(loki.url);
const hub = new TailHub(lokiClient);
const store = new Store();
const app = createApp({
  cfg,
  db: openDb(":memory:"),
  store,
  gh: githubClient(cfg),
  lagMs: () => 0,
  manifest: await loadManifest("tests/fixtures/dev-services.json"),
  poller: new Poller(store, { demandWindowMs: 1000, idleIntervalMs: 60_000, tickMs: 1000 }),
  loki: { client: lokiClient, hub },
});
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;
const cookie = ((await app.request("/auth/dev")).headers.get("set-cookie") ?? "").split(";")[0]!;

const mem = () => {
  Bun.gc(true);
  const m = process.memoryUsage();
  return { heapMB: +(m.heapUsed / 1048576).toFixed(1), rssMB: +(m.rss / 1048576).toFixed(1) };
};

interface Client {
  ac: AbortController;
  bytes: number;
  lines: number;
  failed: boolean;
  done: Promise<void>;
}

function open(query: string): Client {
  const c: Client = { ac: new AbortController(), bytes: 0, lines: 0, failed: false, done: Promise.resolve() };
  c.done = (async () => {
    try {
      const res = await fetch(`${base}/logs/stream?${query}`, { headers: { cookie }, signal: c.ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const t = dec.decode(value);
        c.bytes += value.length;
        c.lines += (t.match(/event: lines/g) ?? []).length;
        if (t.includes("event: fail")) c.failed = true;
      }
    } catch {}
  })();
  return c;
}

const waitFor = async (cond: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !cond()) await Bun.sleep(20);
  return cond();
};

const report: Record<string, unknown>[] = [];
const baseline = mem();
let ok = true;
const check = (name: string, pass: boolean, detail: unknown) => {
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};

for (let cycle = 1; cycle <= CYCLES; cycle++) {
  const clients = Array.from({ length: CLIENTS }, () => open("host=vps&container=traefik"));
  await waitFor(() => hub.stats().subscribers === CLIENTS, 5000);
  await Bun.sleep(800);
  const extra = open("host=vps&container=traefik");
  await waitFor(() => extra.failed, 3000);
  const gotLines = clients.filter((c) => c.lines > 0).length;
  if (cycle === 1) {
    check("one upstream websocket for 50 clients", loki.stats.upgrades === 1 && loki.stats.open === 1, { upgrades: loki.stats.upgrades, open: loki.stats.open, tails: hub.stats().tails, subscribers: hub.stats().subscribers });
    check("every client receives live lines", gotLines === CLIENTS, { clientsWithLines: gotLines });
    check("client 51 is refused with the cap error", extra.failed, { failed: extra.failed });
  }
  extra.ac.abort();
  for (const c of clients) c.ac.abort();
  await Promise.all([extra.done, ...clients.map((c) => c.done)]);
  const drained = await waitFor(() => hub.stats().subscribers === 0 && hub.stats().tails === 0 && loki.stats.open === 0, 5000);
  report.push({ cycle, drained, ...hub.stats(), fakeOpen: loki.stats.open, ...mem() });
  if (!drained) check(`cycle ${cycle} drained`, false, hub.stats());
}
console.table(report.map(({ perTail: _p, ...r }) => r));
const end = mem();
check("no leaked subscribers, tails or sockets after all cycles", hub.stats().subscribers === 0 && hub.stats().tails === 0 && loki.stats.open === 0, { stats: hub.stats(), fakeOpen: loki.stats.open });
check("upgrades equal cycles (one socket per cycle)", loki.stats.upgrades === CYCLES, { upgrades: loki.stats.upgrades, cycles: CYCLES });
console.log(JSON.stringify({ baseline, end, growthHeapMB: +(end.heapMB - baseline.heapMB).toFixed(1), growthRssMB: +(end.rssMB - baseline.rssMB).toFixed(1) }));
hub.closeAll();
await server.stop(true);
await loki.stop();
process.exit(ok ? 0 : 1);
