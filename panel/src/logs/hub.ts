import { compareNs, DEFAULT_MAX_LINE_LENGTH, filterKey, linesFromStreams, nextNs, normalizeFilter, tailFrameSchema } from "../collectors/loki";
import type { LogFilter, LogLine, LokiClient } from "../collectors/loki";

export type TailState = "connecting" | "live" | "reconnecting";

export type HubEvent =
  | { type: "lines"; lines: LogLine[] }
  | { type: "status"; state: TailState; error?: string }
  | { type: "dropped"; count: number };

export type HubListener = (event: HubEvent) => void;

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  close(): void;
}

export interface HubOptions {
  maxSubscribers?: number;
  maxTails?: number;
  ringLines?: number;
  maxLineLength?: number;
  catchupLimit?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  startSkewMs?: number;
  stableMs?: number;
  dedupeWindow?: number;
  connect?: (url: string) => SocketLike;
  now?: () => number;
}

export class HubLimitError extends Error {}

interface Subscriber {
  listener: HubListener;
  afterNs: string | null;
}

interface Tail {
  key: string;
  filter: LogFilter;
  subs: Set<Subscriber>;
  ring: LogLine[];
  lastNs: string | null;
  seen: Set<string>;
  openedAt: number | null;
  startNs: string;
  socket: SocketLike | null;
  state: TailState;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export interface HubStats {
  tails: number;
  subscribers: number;
  perTail: { key: string; subscribers: number; state: TailState; buffered: number }[];
}

export class TailHub {
  private tails = new Map<string, Tail>();
  private total = 0;
  private o: Required<Omit<HubOptions, "connect">> & { connect: (url: string) => SocketLike };

  constructor(private loki: LokiClient, opts: HubOptions = {}) {
    this.o = {
      maxSubscribers: opts.maxSubscribers ?? 50,
      maxTails: opts.maxTails ?? 10,
      ringLines: opts.ringLines ?? 500,
      maxLineLength: opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH,
      catchupLimit: opts.catchupLimit ?? 500,
      backoffBaseMs: opts.backoffBaseMs ?? 500,
      backoffMaxMs: opts.backoffMaxMs ?? 30_000,
      startSkewMs: opts.startSkewMs ?? 2000,
      stableMs: opts.stableMs ?? 30_000,
      dedupeWindow: opts.dedupeWindow ?? 4000,
      connect: opts.connect ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      now: opts.now ?? (() => Date.now()),
    };
  }

  subscribe(filter: LogFilter, listener: HubListener, afterNs?: string): () => void {
    const f = normalizeFilter(filter);
    const key = filterKey(f);
    let tail = this.tails.get(key);
    if (this.total >= this.o.maxSubscribers) throw new HubLimitError("too many log subscribers");
    if (!tail) {
      if (this.tails.size >= this.o.maxTails) throw new HubLimitError("too many distinct log streams");
      tail = {
        key,
        filter: f,
        subs: new Set(),
        ring: [],
        lastNs: null,
        seen: new Set(),
        openedAt: null,
        startNs: afterNs !== undefined ? nextNs(afterNs) : ((BigInt(this.o.now()) - BigInt(this.o.startSkewMs)) * 1_000_000n).toString(),
        socket: null,
        state: "connecting",
        attempts: 0,
        timer: null,
        closed: false,
      };
      this.tails.set(key, tail);
    }
    const sub: Subscriber = { listener, afterNs: afterNs ?? null };
    tail.subs.add(sub);
    this.total += 1;
    const t = tail;
    this.safe(sub, { type: "status", state: t.state });
    if (afterNs !== undefined) {
      const replay = t.ring.filter((l) => compareNs(l.ts, afterNs) > 0);
      if (replay.length) this.safe(sub, { type: "lines", lines: replay });
    }
    if (!t.socket && !t.timer) this.open(t);

    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (!t.subs.delete(sub)) return;
      this.total -= 1;
      if (t.subs.size === 0) this.shutdown(t);
    };
  }

  assertCapacity(filter: LogFilter): void {
    if (this.total >= this.o.maxSubscribers) throw new HubLimitError("too many log subscribers");
    if (!this.tails.has(filterKey(normalizeFilter(filter))) && this.tails.size >= this.o.maxTails) {
      throw new HubLimitError("too many distinct log streams");
    }
  }

  stats(): HubStats {
    return {
      tails: this.tails.size,
      subscribers: this.total,
      perTail: [...this.tails.values()].map((t) => ({ key: t.key, subscribers: t.subs.size, state: t.state, buffered: t.ring.length })),
    };
  }

  closeAll(): void {
    for (const t of [...this.tails.values()]) {
      this.total -= t.subs.size;
      t.subs.clear();
      this.shutdown(t);
    }
  }

  private safe(sub: Subscriber, event: HubEvent): void {
    try {
      sub.listener(event);
    } catch {
    }
  }

  private emit(t: Tail, event: HubEvent): void {
    for (const sub of [...t.subs]) this.safe(sub, event);
  }

  private setState(t: Tail, state: TailState, error?: string): void {
    t.state = state;
    this.emit(t, error ? { type: "status", state, error } : { type: "status", state });
  }

  private shutdown(t: Tail): void {
    t.closed = true;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    const s = t.socket;
    t.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try {
        s.close();
      } catch {
      }
    }
    this.tails.delete(t.key);
  }

  private open(t: Tail): void {
    if (t.closed) return;
    const start = t.lastNs !== null ? this.resumeNs(t.lastNs) : t.startNs;
    let socket: SocketLike;
    try {
      socket = this.o.connect(this.loki.tailUrl(t.filter, start, this.o.catchupLimit));
    } catch (err) {
      this.retry(t, err instanceof Error ? err.message : String(err));
      return;
    }
    t.socket = socket;
    let failed = false;
    const fail = (reason: string) => {
      if (failed || t.socket !== socket) return;
      failed = true;
      t.socket = null;
      if (t.openedAt !== null && this.o.now() - t.openedAt >= this.o.stableMs) t.attempts = 0;
      t.openedAt = null;
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
      }
      this.retry(t, reason);
    };
    socket.onopen = () => {
      t.openedAt = this.o.now();
      this.setState(t, "live");
    };
    socket.onmessage = (ev) => this.onFrame(t, ev.data);
    socket.onerror = () => fail("tail socket error");
    socket.onclose = () => fail("tail socket closed");
  }

  private resumeNs(lastNs: string): string {
    const back = BigInt(this.o.startSkewMs) * 1_000_000n;
    const v = BigInt(lastNs) - back;
    return (v > 0n ? v : 0n).toString();
  }

  private retry(t: Tail, reason: string): void {
    if (t.closed) return;
    const delay = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** t.attempts);
    t.attempts += 1;
    this.setState(t, "reconnecting", reason);
    t.timer = setTimeout(() => {
      t.timer = null;
      this.open(t);
    }, delay);
  }

  private firstSight(t: Tail, l: LogLine): boolean {
    const id = `${l.ts}\u0000${l.host}\u0000${l.container}\u0000${l.line}`;
    if (t.seen.has(id)) return false;
    t.seen.add(id);
    if (t.seen.size > this.o.dedupeWindow) t.seen.delete(t.seen.values().next().value as string);
    return true;
  }

  private onFrame(t: Tail, data: unknown): void {
    if (typeof data !== "string") return;
    let frame: ReturnType<typeof tailFrameSchema.safeParse>;
    try {
      frame = tailFrameSchema.safeParse(JSON.parse(data));
    } catch {
      return;
    }
    if (!frame.success) return;
    const dropped = frame.data.dropped_entries?.length ?? 0;
    if (dropped > 0) this.emit(t, { type: "dropped", count: dropped });
    let lines = linesFromStreams(frame.data.streams, this.o.maxLineLength);
    lines = lines.filter((l) => this.firstSight(t, l));
    if (!lines.length) return;
    t.attempts = 0;
    for (const l of lines) if (t.lastNs === null || compareNs(l.ts, t.lastNs) > 0) t.lastNs = l.ts;
    t.ring.push(...lines);
    if (t.ring.length > this.o.ringLines) t.ring.splice(0, t.ring.length - this.o.ringLines);
    for (const sub of [...t.subs]) {
      const own = sub.afterNs === null ? lines : lines.filter((l) => compareNs(l.ts, sub.afterNs!) > 0);
      if (own.length) this.safe(sub, { type: "lines", lines: own });
    }
  }
}
