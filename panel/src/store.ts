export type BreakerState = "closed" | "open" | "half-open";

export interface SourceOptions {
  ttlMs: number;
  timeoutMs: number;
  failureThreshold: number;
  cooldownMs: number;
}

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface Snapshot<T> {
  data: T | undefined;
  fetchedAt: number | null;
  ageMs: number | null;
  stale: boolean;
  lastError: string | null;
  lastAttemptAt: number | null;
  breaker: BreakerState;
  hash: string | null;
  cadenceMs: number;
}

export interface SourceInfo {
  opts: SourceOptions;
  lastAttemptAt: number | null;
  inflight: boolean;
}

interface Source<T> {
  fetcher: Fetcher<T>;
  opts: SourceOptions;
  data: T | undefined;
  fetchedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  failures: number;
  openedAt: number | null;
  inflight: Promise<void> | null;
  hash: string | null;
  cadenceMs: number;
  fetchedCadenceMs: number;
}

function contentHash(data: unknown): string | null {
  try {
    return Bun.hash(JSON.stringify(data) ?? "").toString(36);
  } catch {
    return null;
  }
}

export class UpstreamTimeout extends Error {
  constructor(ms: number) {
    super(`upstream timed out after ${ms}ms`);
  }
}

export class Store {
  private sources = new Map<string, Source<unknown>>();

  constructor(private now: () => number = () => Date.now()) {}

  register<T>(name: string, fetcher: Fetcher<T>, opts: SourceOptions): void {
    if (this.sources.has(name)) throw new Error(`source already registered: ${name}`);
    this.sources.set(name, {
      fetcher,
      opts,
      data: undefined,
      fetchedAt: null,
      lastAttemptAt: null,
      lastError: null,
      failures: 0,
      openedAt: null,
      inflight: null,
      hash: null,
      cadenceMs: opts.ttlMs,
      fetchedCadenceMs: opts.ttlMs,
    });
  }

  names(): string[] {
    return [...this.sources.keys()];
  }

  get<T>(name: string): Snapshot<T> {
    const s = this.source(name);
    const snap = this.snapshot<T>(s);
    if (this.needsRefresh(s)) void this.startRefresh(s);
    return snap;
  }

  peek<T>(name: string): Snapshot<T> {
    return this.snapshot<T>(this.source(name));
  }

  info(name: string): SourceInfo {
    const s = this.source(name);
    return { opts: s.opts, lastAttemptAt: s.lastAttemptAt, inflight: s.inflight !== null };
  }

  setCadence(name: string, ms: number): void {
    this.source(name).cadenceMs = ms;
  }

  async refresh<T>(name: string): Promise<Snapshot<T>> {
    const s = this.source(name);
    await this.startRefresh(s);
    return this.snapshot<T>(s);
  }

  staleAttempts(maxAgeMs: number | ((name: string, opts: SourceOptions) => number)): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [name, s] of this.sources) {
      const last = s.lastAttemptAt;
      const limit = typeof maxAgeMs === "number" ? maxAgeMs : maxAgeMs(name, s.opts);
      if (last !== null && t - last > limit) out.push(name);
    }
    return out;
  }

  private source(name: string): Source<unknown> {
    const s = this.sources.get(name);
    if (!s) throw new Error(`unknown source: ${name}`);
    return s;
  }

  private breakerState(s: Source<unknown>): BreakerState {
    if (s.openedAt === null) return "closed";
    return this.now() - s.openedAt >= s.opts.cooldownMs ? "half-open" : "open";
  }

  private needsRefresh(s: Source<unknown>): boolean {
    if (s.inflight) return false;
    if (this.breakerState(s) === "open") return false;
    return s.fetchedAt === null || this.now() - s.fetchedAt > s.opts.ttlMs;
  }

  private snapshot<T>(s: Source<unknown>): Snapshot<T> {
    const ageMs = s.fetchedAt === null ? null : this.now() - s.fetchedAt;
    return {
      data: s.data as T | undefined,
      fetchedAt: s.fetchedAt,
      ageMs,
      stale: ageMs === null || ageMs > s.opts.ttlMs,
      lastError: s.lastError,
      lastAttemptAt: s.lastAttemptAt,
      breaker: this.breakerState(s),
      hash: s.hash,
      cadenceMs: Math.max(s.cadenceMs, s.fetchedCadenceMs),
    };
  }

  private startRefresh(s: Source<unknown>): Promise<void> {
    if (s.inflight) return s.inflight;
    if (this.breakerState(s) === "open") return Promise.resolve();
    s.inflight = this.run(s).finally(() => {
      s.inflight = null;
    });
    return s.inflight;
  }

  private async run(s: Source<unknown>): Promise<void> {
    s.lastAttemptAt = this.now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new UpstreamTimeout(s.opts.timeoutMs));
      }, s.opts.timeoutMs);
    });
    try {
      const data = await Promise.race([s.fetcher(ctl.signal), timeout]);
      s.data = data;
      s.hash = contentHash(data);
      s.fetchedCadenceMs = s.cadenceMs;
      s.fetchedAt = this.now();
      s.lastError = null;
      s.failures = 0;
      s.openedAt = null;
    } catch (err) {
      s.lastError = err instanceof Error ? err.message : String(err);
      s.failures += 1;
      if (this.breakerState(s) === "half-open" || s.failures >= s.opts.failureThreshold) {
        s.openedAt = this.now();
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
