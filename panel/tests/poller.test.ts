import { describe, expect, test } from "bun:test";
import { Poller, type Timers } from "../src/poller";
import { Store, type SourceOptions } from "../src/store";
import { sourceStatus } from "../src/views/model";
import { PROM_SOURCES } from "../src/collectors/prometheus";
import { DOCKER_SOURCES } from "../src/collectors/docker";

const base = { timeoutMs: 2000, failureThreshold: 3, cooldownMs: 15_000 };
const opts = (ttlMs: number): SourceOptions => ({ ...base, ttlMs });
const pollerOpts = { demandWindowMs: 60_000, idleIntervalMs: 60_000, tickMs: 1000 };

function fakeTimers() {
  const live = new Set<number>();
  let next = 1;
  const timers: Timers = {
    setInterval: () => {
      const id = next++;
      live.add(id);
      return id;
    },
    clearInterval: (h) => void live.delete(h as number),
  };
  return { timers, live };
}

function rig() {
  let t = 10_000_000;
  const now = () => t;
  const store = new Store(now);
  const calls: Record<string, number> = {};
  const reg = (name: string, ttl: number) => {
    calls[name] = 0;
    store.register(name, async () => ++calls[name]!, opts(ttl));
  };
  reg(PROM_SOURCES.hosts, 15_000);
  reg(DOCKER_SOURCES.containers, 5_000);
  reg(DOCKER_SOURCES.df, 300_000);
  const { timers, live } = fakeTimers();
  const poller = new Poller(store, pollerOpts, now, timers);
  const settle = () => Bun.sleep(1);
  const run = async (ms: number, step = 1000) => {
    for (let i = 0; i < ms; i += step) {
      t += step;
      poller.tick();
      await settle();
    }
  };
  return { store, poller, calls, live, run, settle, advance: (ms: number) => void (t += ms), now };
}

describe("poller", () => {
  test("polls at the slow cadence while nobody is looking", async () => {
    const r = rig();
    r.poller.start();
    await r.settle();
    expect(r.calls[DOCKER_SOURCES.containers]).toBe(1);
    await r.run(120_000);
    expect(r.poller.active()).toBe(false);
    expect(r.calls[DOCKER_SOURCES.containers]).toBe(3);
    expect(r.calls[PROM_SOURCES.hosts]).toBe(3);
    expect(r.calls[DOCKER_SOURCES.df]).toBe(1);
    r.poller.stop();
  });

  test("a request switches to the fast cadence and wakes stale sources at once", async () => {
    const r = rig();
    r.poller.start();
    await r.run(30_000);
    const before = r.calls[DOCKER_SOURCES.containers]!;
    r.poller.touch();
    await r.settle();
    expect(r.poller.active()).toBe(true);
    expect(r.calls[DOCKER_SOURCES.containers]).toBe(before + 1);
    await r.run(20_000);
    expect(r.calls[DOCKER_SOURCES.containers]).toBe(before + 5);
    r.poller.stop();
  });

  test("demand expires after the window and the cadence slows again", async () => {
    const r = rig();
    r.poller.start();
    r.poller.touch();
    await r.run(60_000);
    expect(r.poller.active()).toBe(false);
    const at = r.calls[DOCKER_SOURCES.containers]!;
    await r.run(60_000);
    expect(r.calls[DOCKER_SOURCES.containers]).toBe(at + 1);
    r.poller.stop();
  });

  test("touch before start does not fetch", async () => {
    const r = rig();
    r.poller.touch();
    await r.settle();
    expect(r.calls[DOCKER_SOURCES.containers]).toBe(0);
  });

  test("start is idempotent and stop leaves no timer behind", () => {
    const r = rig();
    r.poller.start();
    r.poller.start();
    expect(r.live.size).toBe(1);
    r.poller.stop();
    r.poller.stop();
    expect(r.live.size).toBe(0);
    expect(r.poller.running()).toBe(false);
  });

  test("real timers: stop clears the interval", async () => {
    const store = new Store();
    let n = 0;
    store.register("a", async () => ++n, opts(5));
    const poller = new Poller(store, { ...pollerOpts, tickMs: 5, idleIntervalMs: 5 });
    poller.start();
    await Bun.sleep(40);
    poller.stop();
    const at = n;
    await Bun.sleep(40);
    expect(at).toBeGreaterThan(1);
    expect(n).toBe(at);
  });

  test("idle data is not flagged stale, and fast data is once demand resumes", async () => {
    const r = rig();
    r.poller.start();
    await r.run(50_000);
    const idle = r.store.peek(DOCKER_SOURCES.containers);
    expect(idle.cadenceMs).toBe(60_000);
    expect(sourceStatus("docker", idle).state).toBe("fresh");
    r.poller.touch();
    await r.settle();
    expect(r.store.peek(DOCKER_SOURCES.containers).cadenceMs).toBe(5_000);
    r.poller.stop();
    r.advance(16_000);
    expect(sourceStatus("docker", r.store.peek(DOCKER_SOURCES.containers)).state).toBe("stale");
  });

  test("healthz stays healthy through long idle periods, and fails once polling stops", async () => {
    const r = rig();
    r.poller.start();
    await r.run(15 * 60_000, 5000);
    expect(r.poller.overdue(120_000)).toEqual([]);
    r.poller.stop();
    r.advance(11 * 60_000);
    expect(r.poller.overdue(120_000).sort()).toEqual([DOCKER_SOURCES.containers, DOCKER_SOURCES.df, PROM_SOURCES.hosts].sort());
  });
});
