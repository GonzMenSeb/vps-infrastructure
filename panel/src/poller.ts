import type { Store } from "./store";

export interface PollerOptions {
  demandWindowMs: number;
  idleIntervalMs: number;
  tickMs: number;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class Poller {
  private lastDemandAt: number | null = null;
  private handle: unknown = null;
  private startedAt: number | null = null;

  constructor(
    private store: Store,
    private opts: PollerOptions,
    private now: () => number = () => Date.now(),
    private timers: Timers = realTimers,
  ) {}

  active(): boolean {
    return this.lastDemandAt !== null && this.now() - this.lastDemandAt < this.opts.demandWindowMs;
  }

  running(): boolean {
    return this.handle !== null;
  }

  intervalFor(name: string, active = this.active()): number {
    const ttl = this.store.info(name).opts.ttlMs;
    return active ? ttl : Math.max(ttl, this.opts.idleIntervalMs);
  }

  touch(): void {
    const wasActive = this.active();
    this.lastDemandAt = this.now();
    if (!wasActive && this.running()) this.tick();
  }

  tick(): void {
    const active = this.active();
    const t = this.now();
    for (const name of this.store.names()) {
      const interval = this.intervalFor(name, active);
      this.store.setCadence(name, interval);
      const { lastAttemptAt, inflight } = this.store.info(name);
      if (inflight) continue;
      if (lastAttemptAt === null || t - lastAttemptAt >= interval) void this.store.refresh(name).catch(() => {});
    }
  }

  start(): void {
    if (this.running()) return;
    this.startedAt = this.now();
    this.handle = this.timers.setInterval(() => this.tick(), this.opts.tickMs);
    (this.handle as { unref?: () => void }).unref?.();
    this.tick();
  }

  stop(): void {
    if (!this.running()) return;
    this.timers.clearInterval(this.handle);
    this.handle = null;
  }

  overdue(minMs: number): string[] {
    const t = this.now();
    return this.store.names().filter((name) => {
      const { opts, lastAttemptAt } = this.store.info(name);
      const since = lastAttemptAt ?? this.startedAt;
      if (since === null) return false;
      const limit = Math.max(minMs, 2 * this.intervalFor(name, false) + opts.cooldownMs + opts.timeoutMs + this.opts.tickMs);
      return t - since > limit;
    });
  }
}
