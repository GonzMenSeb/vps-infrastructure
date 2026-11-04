import { afterEach, describe, expect, test } from "bun:test";
import { LokiClient } from "../src/collectors/loki";
import { HubLimitError, TailHub } from "../src/logs/hub";
import type { HubEvent } from "../src/logs/hub";
import frame from "./fixtures/loki-tail-frame.json";

interface Conn {
  query: string;
  start: string;
  ws: { send(d: string): void; close(): void };
}

let server: ReturnType<typeof Bun.serve>;
let conns: Conn[] = [];
let opens = 0;
let closes = 0;
let refuse = false;
let hub: TailHub;

function startServer() {
  conns = [];
  opens = 0;
  closes = 0;
  refuse = false;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      if (refuse) return new Response("no", { status: 400 });
      if (srv.upgrade(req, { data: { query: u.searchParams.get("query") ?? "", start: u.searchParams.get("start") ?? "" } })) return;
      return new Response("expected ws", { status: 426 });
    },
    websocket: {
      open(ws) {
        opens += 1;
        const d = ws.data as { query: string; start: string };
        conns.push({ ...d, ws });
      },
      message() {},
      close() {
        closes += 1;
      },
    },
  });
  return new LokiClient(`http://127.0.0.1:${server.port}`, { now: () => 1_793_754_200_000 });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
};

const frameWith = (ts: string, line = "hello") =>
  JSON.stringify({ streams: [{ stream: { host: "vps", container: "traefik" }, values: [[ts, line]] }] });

afterEach(async () => {
  hub?.closeAll();
  await server?.stop(true);
});

describe("TailHub", () => {
  test("one upstream socket per distinct filter, fanned out to all subscribers", async () => {
    hub = new TailHub(startServer(), { backoffBaseMs: 10 });
    const a: HubEvent[] = [];
    const b: HubEvent[] = [];
    const offA = hub.subscribe({ container: "traefik" }, (e) => a.push(e));
    const offB = hub.subscribe({ container: "traefik" }, (e) => b.push(e));
    hub.subscribe({ container: "other" }, () => {});
    await until(() => opens === 2);
    expect(hub.stats()).toMatchObject({ tails: 2, subscribers: 3 });
    const conn = conns.find((c) => c.query.includes('"traefik"'))!;
    conn.ws.send(JSON.stringify(frame));
    await until(() => a.some((e) => e.type === "lines") && b.some((e) => e.type === "lines"));
    const lines = a.flatMap((e) => (e.type === "lines" ? e.lines : []));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toBe("2026-11-04T01:01:44 [INFO] : request 192.0.2.1 for url /loki/api/v1/push");
    offA();
    offB();
  });

  test("closes the upstream when the last subscriber leaves", async () => {
    hub = new TailHub(startServer());
    const off1 = hub.subscribe({ container: "x" }, () => {});
    const off2 = hub.subscribe({ container: "x" }, () => {});
    await until(() => opens === 1);
    off1();
    await Bun.sleep(30);
    expect(closes).toBe(0);
    off2();
    off2();
    await until(() => closes === 1);
    expect(hub.stats()).toMatchObject({ tails: 0, subscribers: 0 });
  });

  test("reconnects with backoff and resumes after the last timestamp", async () => {
    hub = new TailHub(startServer(), { backoffBaseMs: 10, backoffMaxMs: 40 });
    const events: HubEvent[] = [];
    hub.subscribe({ container: "traefik" }, (e) => events.push(e));
    await until(() => conns.length === 1);
    conns[0]!.ws.send(frameWith("1793754104000000000"));
    await until(() => events.some((e) => e.type === "lines"));
    conns[0]!.ws.close();
    await until(() => conns.length === 2);
    expect(conns[1]!.start).toBe("1793754102000000000");
    expect(events.some((e) => e.type === "status" && e.state === "reconnecting")).toBe(true);
    await until(() => events.filter((e) => e.type === "status" && e.state === "live").length >= 2);
  });

  test("keeps retrying while Loki refuses, then recovers", async () => {
    hub = new TailHub(startServer(), { backoffBaseMs: 10, backoffMaxMs: 20 });
    refuse = true;
    const events: HubEvent[] = [];
    hub.subscribe({}, (e) => events.push(e));
    await until(() => events.filter((e) => e.type === "status" && e.state === "reconnecting").length >= 3);
    refuse = false;
    await until(() => conns.length === 1);
    await until(() => events.some((e) => e.type === "status" && e.state === "live"));
  });

  test("keeps late lines, drops exact repeats", async () => {
    hub = new TailHub(startServer());
    const got: string[] = [];
    hub.subscribe({}, (e) => e.type === "lines" && got.push(...e.lines.map((l) => l.line)));
    await until(() => conns.length === 1);
    conns[0]!.ws.send(frameWith("20", "b"));
    conns[0]!.ws.send(frameWith("10", "old"));
    conns[0]!.ws.send(frameWith("20", "b"));
    conns[0]!.ws.send(frameWith("30", "c"));
    await until(() => got.length === 3);
    expect(got).toEqual(["b", "old", "c"]);
  });

  test("backoff keeps growing while Loki accepts then closes at once", async () => {
    hub = new TailHub(startServer(), { backoffBaseMs: 20, backoffMaxMs: 1000 });
    hub.subscribe({}, () => {});
    for (let i = 1; i <= 4; i++) {
      await until(() => conns.length === i);
      conns[i - 1]!.ws.close();
    }
    const t = Date.now();
    await until(() => conns.length === 5);
    expect(Date.now() - t).toBeGreaterThanOrEqual(100);
  });

  test("assertCapacity refuses before any subscription", () => {
    hub = new TailHub(startServer(), { maxTails: 1 });
    hub.subscribe({ container: "a" }, () => {});
    expect(() => hub.assertCapacity({ container: "b" })).toThrow(HubLimitError);
    expect(() => hub.assertCapacity({ container: "a" })).not.toThrow();
  });

  test("closeAll then unsubscribe keeps the counter at zero", () => {
    hub = new TailHub(startServer());
    const off = hub.subscribe({}, () => {});
    hub.closeAll();
    off();
    expect(hub.stats().subscribers).toBe(0);
  });

  test("late subscriber replays ring lines newer than its resume point", async () => {
    hub = new TailHub(startServer(), { ringLines: 3 });
    hub.subscribe({}, () => {});
    await until(() => conns.length === 1);
    for (const n of [1, 2, 3, 4]) conns[0]!.ws.send(frameWith(String(n * 10), `l${n}`));
    await until(() => hub.stats().perTail[0]!.buffered === 3);
    const got: string[] = [];
    hub.subscribe({}, (e) => e.type === "lines" && got.push(...e.lines.map((l) => l.line)), "20");
    expect(got).toEqual(["l3", "l4"]);
  });

  test("truncates long lines and reports Loki dropped entries", async () => {
    hub = new TailHub(startServer(), { maxLineLength: 5 });
    const events: HubEvent[] = [];
    hub.subscribe({}, (e) => events.push(e));
    await until(() => conns.length === 1);
    conns[0]!.ws.send(JSON.stringify({ streams: [{ stream: { host: "vps", container: "c" }, values: [["5", "123456789"]] }], dropped_entries: [{}, {}] }));
    await until(() => events.some((e) => e.type === "lines"));
    const l = events.find((e) => e.type === "lines");
    expect(l && l.type === "lines" && l.lines[0]).toMatchObject({ line: "12345", truncated: true });
    expect(events).toContainEqual({ type: "dropped", count: 2 });
  });

  test("enforces subscriber and stream caps and survives a throwing listener", async () => {
    hub = new TailHub(startServer(), { maxSubscribers: 3, maxTails: 2 });
    hub.subscribe({ container: "a" }, () => {
      throw new Error("boom");
    });
    const ok: HubEvent[] = [];
    hub.subscribe({ container: "a" }, (e) => ok.push(e));
    hub.subscribe({ container: "b" }, () => {});
    expect(() => hub.subscribe({ container: "c" }, () => {})).toThrow(HubLimitError);
    await until(() => conns.length === 2);
    conns.find((c) => c.query.includes('"a"'))!.ws.send(frameWith("7"));
    await until(() => ok.some((e) => e.type === "lines"));
  });
});
