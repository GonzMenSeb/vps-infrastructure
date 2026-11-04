import { describe, expect, test } from "bun:test";
import { Store, type SourceOptions } from "../src/store";

const opts: SourceOptions = { ttlMs: 1000, timeoutMs: 50, failureThreshold: 2, cooldownMs: 5000 };

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("store", () => {
  test("first refresh populates the snapshot", async () => {
    const c = clock();
    const s = new Store(c.now);
    s.register("a", async () => 42, opts);
    const snap = await s.refresh<number>("a");
    expect(snap.data).toBe(42);
    expect(snap.stale).toBe(false);
    expect(snap.ageMs).toBe(0);
    expect(snap.breaker).toBe("closed");
  });

  test("get before any fetch reports stale with no data", () => {
    const s = new Store(clock().now);
    s.register("a", () => new Promise(() => {}), opts);
    const snap = s.get("a");
    expect(snap.data).toBeUndefined();
    expect(snap.stale).toBe(true);
  });

  test("stale-while-revalidate serves old data and refreshes in background", async () => {
    const c = clock();
    const s = new Store(c.now);
    let n = 0;
    s.register("a", async () => ++n, opts);
    await s.refresh("a");
    c.advance(1500);
    const served = s.get<number>("a");
    expect(served.data).toBe(1);
    expect(served.stale).toBe(true);
    await Bun.sleep(5);
    const next = s.get<number>("a");
    expect(next.data).toBe(2);
    expect(next.stale).toBe(false);
  });

  test("concurrent refreshes share one in-flight fetch", async () => {
    const s = new Store(clock().now);
    let calls = 0;
    s.register("a", async () => {
      calls++;
      await Bun.sleep(10);
      return calls;
    }, opts);
    await Promise.all([s.refresh("a"), s.refresh("a"), s.refresh("a")]);
    expect(calls).toBe(1);
  });

  test("failure keeps previous data and records the error", async () => {
    const c = clock();
    const s = new Store(c.now);
    let fail = false;
    s.register("a", async () => {
      if (fail) throw new Error("boom");
      return "ok";
    }, opts);
    await s.refresh("a");
    fail = true;
    c.advance(2000);
    const snap = await s.refresh<string>("a");
    expect(snap.data).toBe("ok");
    expect(snap.lastError).toBe("boom");
    expect(snap.stale).toBe(true);
    expect(snap.breaker).toBe("closed");
  });

  test("timeout aborts the fetcher and counts as a failure", async () => {
    const s = new Store(clock().now);
    let aborted = false;
    s.register("a", (signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))), opts);
    const snap = await s.refresh("a");
    expect(snap.lastError).toContain("timed out");
    expect(aborted).toBe(true);
  });

  test("breaker opens after threshold and stops calling upstream", async () => {
    const c = clock();
    const s = new Store(c.now);
    let calls = 0;
    s.register("a", async () => {
      calls++;
      throw new Error("down");
    }, opts);
    await s.refresh("a");
    expect((await s.refresh("a")).breaker).toBe("open");
    expect(calls).toBe(2);
    await s.refresh("a");
    s.get("a");
    expect(calls).toBe(2);
  });

  test("breaker goes half-open after cooldown and closes on success", async () => {
    const c = clock();
    const s = new Store(c.now);
    let healthy = false;
    s.register("a", async () => {
      if (!healthy) throw new Error("down");
      return "back";
    }, opts);
    await s.refresh("a");
    await s.refresh("a");
    c.advance(5000);
    expect(s.get("a").breaker).toBe("half-open");
    await Bun.sleep(5);
    healthy = true;
    c.advance(5000);
    const snap = await s.refresh<string>("a");
    expect(snap.data).toBe("back");
    expect(snap.breaker).toBe("closed");
    expect(snap.lastError).toBeNull();
  });

  test("failed half-open trial re-opens the breaker immediately", async () => {
    const c = clock();
    const s = new Store(c.now);
    let calls = 0;
    s.register("a", async () => {
      calls++;
      throw new Error("down");
    }, opts);
    await s.refresh("a");
    await s.refresh("a");
    c.advance(5000);
    const snap = await s.refresh("a");
    expect(calls).toBe(3);
    expect(snap.breaker).toBe("open");
  });

  test("staleAttempts flags sources whose poller has not run recently", async () => {
    const c = clock();
    const s = new Store(c.now);
    s.register("a", async () => 1, opts);
    s.register("never", async () => 1, opts);
    await s.refresh("a");
    expect(s.staleAttempts(10_000)).toEqual([]);
    c.advance(20_000);
    expect(s.staleAttempts(10_000)).toEqual(["a"]);
  });

  test("duplicate registration and unknown names throw", () => {
    const s = new Store(clock().now);
    s.register("a", async () => 1, opts);
    expect(() => s.register("a", async () => 1, opts)).toThrow();
    expect(() => s.get("missing")).toThrow();
  });
});
