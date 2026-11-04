import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { LogFilter, LogLine } from "../collectors/loki";
import { compareNs } from "../collectors/loki";
import type { HubEvent, TailHub } from "./hub";

export interface LogStreamOptions {
  hub: TailHub;
  filter: LogFilter;
  backlog: (resumeAfterNs: string | null) => Promise<LogLine[]>;
  heartbeatMs?: number;
  maxQueuedLines?: number;
  batchLines?: number;
}

const NS = /^\d{1,19}$/;

export function resumePoint(c: Context): string | null {
  const id = c.req.header("last-event-id") ?? c.req.query("after");
  return id && NS.test(id) ? id : null;
}

export function serveLogStream(c: Context, opts: LogStreamOptions): Response {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxQueued = opts.maxQueuedLines ?? 1000;
  const batch = opts.batchLines ?? 100;
  const resume = resumePoint(c);

  return streamSSE(c, async (stream) => {
    let lines: LogLine[] = [];
    let dropped = 0;
    let status: HubEvent | null = null;
    let wake: (() => void) | null = null;
    let done = false;
    let unsubscribe: (() => void) | null = null;

    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe?.();
      unsubscribe = null;
      notify();
    };
    stream.onAbort(finish);

    const push = (event: HubEvent) => {
      if (event.type === "lines") {
        lines.push(...event.lines);
        if (lines.length > maxQueued) {
          dropped += lines.length - maxQueued;
          lines = lines.slice(-maxQueued);
        }
      } else if (event.type === "dropped") {
        dropped += event.count;
      } else {
        status = event;
      }
      notify();
    };

    try {
      opts.hub.assertCapacity(opts.filter);
    } catch (err) {
      await stream.writeSSE({ event: "fail", retry: 10000, data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }) });
      return;
    }

    let initial: LogLine[];
    try {
      initial = await opts.backlog(resume);
    } catch (err) {
      await stream.writeSSE({ event: "fail", retry: 10000, data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }) });
      return;
    }
    if (done) return;
    const last = initial.length ? initial.reduce((a, l) => (compareNs(l.ts, a) > 0 ? l.ts : a), initial[0]!.ts) : resume;
    try {
      unsubscribe = opts.hub.subscribe(opts.filter, push, last ?? undefined);
    } catch (err) {
      await stream.writeSSE({ event: "fail", retry: 10000, data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }) });
      return;
    }
    if (done) {
      finish();
      return;
    }

    const send = async (batchLines: LogLine[], event: string) => {
      await stream.writeSSE({ event, id: batchLines[batchLines.length - 1]!.ts, data: JSON.stringify(batchLines) });
    };
    for (let i = 0; i < initial.length; i += batch) await send(initial.slice(i, i + batch), "backlog");
    await stream.writeSSE({ event: "ready", data: "{}" });

    while (!done) {
      if (!status && !dropped && !lines.length) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, heartbeatMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (done) break;
        if (!status && !dropped && !lines.length) {
          await stream.write(": hb\n\n");
          continue;
        }
      }
      if (status) {
        const s = status as Extract<HubEvent, { type: "status" }>;
        status = null;
        await stream.writeSSE({ event: "status", data: JSON.stringify({ state: s.state, error: s.error ?? null }) });
      }
      if (dropped) {
        const count = dropped;
        dropped = 0;
        await stream.writeSSE({ event: "dropped", data: JSON.stringify({ count }) });
      }
      if (lines.length) {
        const out = lines.slice(0, batch);
        lines = lines.slice(batch);
        await send(out, "lines");
      }
    }
    finish();
  });
}
