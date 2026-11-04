import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { LokiClient } from "../src/collectors/loki";
import type { LogLine } from "../src/collectors/loki";
import { TailHub } from "../src/logs/hub";
import type { SocketLike } from "../src/logs/hub";
import { serveLogStream } from "../src/logs/sse";

class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  send(streams: unknown) {
    this.onmessage?.({ data: JSON.stringify({ streams }) });
  }
}

const line = (ts: string, text: string): LogLine => ({ ts, line: text, host: "vps", container: "c", level: null, truncated: false });
const frame = (ts: string, text: string) => [{ stream: { host: "vps", container: "c" }, values: [[ts, text]] }];

let sockets: FakeSocket[] = [];
let hub: TailHub;
let server: ReturnType<typeof Bun.serve>;

function setup(opts: { backlog?: LogLine[]; heartbeatMs?: number; maxQueuedLines?: number } = {}) {
  sockets = [];
  hub = new TailHub(new LokiClient("http://loki.example.test:3100"), {
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      queueMicrotask(() => s.onopen?.({}));
      return s;
    },
  });
  const resumes: (string | null)[] = [];
  const app = new Hono();
  app.get("/s", (c) =>
    serveLogStream(c, {
      hub,
      filter: { container: "c" },
      backlog: async (r) => {
        resumes.push(r);
        return opts.backlog ?? [];
      },
      heartbeatMs: opts.heartbeatMs,
      maxQueuedLines: opts.maxQueuedLines,
    }),
  );
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return { url: `http://127.0.0.1:${server.port}/s`, resumes };
}

afterEach(async () => {
  hub?.closeAll();
  await server?.stop(true);
});

async function collect(res: Response, stop: (text: string) => boolean, ms = 3000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  let pending = reader.read();
  while (!stop(text) && Date.now() < deadline) {
    const r = await Promise.race([pending, Bun.sleep(100).then(() => null)]);
    if (r === null) continue;
    pending = reader.read();
    if (r.done) break;
    text += dec.decode(r.value);
  }
  await reader.cancel();
  return text;
}

describe("serveLogStream", () => {
  test("sends backlog, ready, then live lines with ids", async () => {
    const { url } = setup({ backlog: [line("1", "a"), line("2", "b")] });
    const ctl = new AbortController();
    const res = await fetch(url, { signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => sockets[0]?.send(frame("3", "live <script>")), 100);
    const text = await collect(res, (t) => t.includes("live <script>"));
    expect(text).toContain("event: backlog");
    expect(text).toContain("event: ready");
    expect(text).toContain("event: lines");
    expect(text).toContain("id: 3");
    expect(text.indexOf("event: backlog")).toBeLessThan(text.indexOf("event: lines"));
    expect(text).toContain('"line":"live <script>"');
  });

  test("passes Last-Event-ID to the backlog provider", async () => {
    const { url, resumes } = setup();
    const res = await fetch(url, { headers: { "Last-Event-ID": "42" } });
    await collect(res, (t) => t.includes("ready"));
    expect(resumes).toEqual(["42"]);
    const res2 = await fetch(url, { headers: { "Last-Event-ID": "x; drop" } });
    await collect(res2, (t) => t.includes("ready"));
    expect(resumes[1]).toBeNull();
    const res3 = await fetch(`${url}?after=77`);
    await collect(res3, (t) => t.includes("ready"));
    expect(resumes[2]).toBe("77");
  });

  test("heartbeats when idle", async () => {
    const { url } = setup({ heartbeatMs: 30 });
    const text = await collect(await fetch(url), (t) => (t.match(/: hb/g)?.length ?? 0) >= 2);
    expect(text.match(/: hb/g)!.length).toBeGreaterThanOrEqual(2);
  });

  test("drops oldest under backpressure and reports the count", async () => {
    const { url } = setup({ maxQueuedLines: 3 });
    const res = await fetch(url);
    await Bun.sleep(100);
    const values = Array.from({ length: 10 }, (_, i) => [String(i + 1), `l${i + 1}`]);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ streams: [{ stream: { host: "vps", container: "c" }, values }] }) });
    const text = await collect(res, (t) => t.includes("l10"));
    expect(text).toContain("event: dropped");
    expect(text).toContain('"count":7');
    expect(text).not.toContain('"line":"l1"');
    expect(text).toContain('"line":"l8"');
  });

  test("unsubscribes and closes upstream when the client aborts", async () => {
    const { url } = setup();
    const res = await fetch(url);
    await collect(res, (t) => t.includes("ready"));
    const t0 = Date.now();
    while (hub.stats().subscribers !== 0 && Date.now() - t0 < 2000) await Bun.sleep(10);
    expect(hub.stats()).toMatchObject({ subscribers: 0, tails: 0 });
    expect(sockets[0]!.closed).toBe(true);
  });

  test("reports a backlog failure as an error event", async () => {
    const app = new Hono();
    hub = new TailHub(new LokiClient("http://loki.example.test:3100"), { connect: () => new FakeSocket() });
    app.get("/s", (c) =>
      serveLogStream(c, { hub, filter: {}, backlog: async () => Promise.reject(new Error("loki down")) }),
    );
    const res = await app.request("/s");
    expect(await res.text()).toContain("event: fail");
    expect(hub.stats().subscribers).toBe(0);
  });
});
