import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

export interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(method: string, fn: (params: any) => void): void;
  eval<T = unknown>(expr: string): Promise<T>;
  goto(url: string, width: number, height?: number): Promise<void>;
  screenshot(path: string, width: number): Promise<void>;
  logs: string[];
}

export interface Browser {
  page(): Promise<Page>;
  close(): Promise<void>;
}

export async function launch(binary = process.env.CHROME ?? "/usr/bin/google-chrome"): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "vesp-chrome-"));
  const proc = Bun.spawn(
    [binary, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu", "about:blank"],
    { stderr: "pipe", stdout: "ignore" },
  );
  const reader = proc.stderr.getReader();
  let buf = "";
  let wsUrl = "";
  while (!wsUrl) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`chrome exited: ${buf}`);
    buf += new TextDecoder().decode(value);
    wsUrl = /DevTools listening on (ws:\/\/\S+)/.exec(buf)?.[1] ?? "";
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let next = 1;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.rej(new Error(m.error.message));
      else p?.res(m.result);
      return;
    }
    for (const fn of listeners.get(`${m.sessionId ?? ""}:${m.method}`) ?? []) fn(m.params);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((res, rej) => {
      const id = next++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return {
    async page() {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method: string, params?: Record<string, unknown>) => send(method, params, sessionId);
      const on = (method: string, fn: (p: any) => void) => {
        const k = `${sessionId}:${method}`;
        listeners.set(k, [...(listeners.get(k) ?? []), fn]);
      };
      const logs: string[] = [];
      const once: (() => void)[] = [];
      on("Page.loadEventFired", () => once.splice(0).forEach((f) => f()));
      on("Runtime.exceptionThrown", (p) => logs.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
      on("Runtime.consoleAPICalled", (p) => {
        if (p.type === "error" || p.type === "warning") logs.push(`console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`);
      });
      on("Log.entryAdded", (p) => {
        if (p.entry.level === "error" || p.entry.level === "warning") logs.push(`${p.entry.source}.${p.entry.level}: ${p.entry.text}`);
      });
      await s("Page.enable");
      await s("Runtime.enable");
      await s("Log.enable");
      const evaluate = async <T,>(expr: string): Promise<T> => {
        const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value as T;
      };
      const metrics = (width: number, height: number) =>
        s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      return {
        send: s,
        on,
        logs,
        eval: evaluate,
        async goto(url, width, height = 900) {
          await metrics(width, height);
          const load = async (target: string) => {
            const loaded = new Promise<void>((res, rej) => {
              const t = setTimeout(() => rej(new Error(`load timed out: ${target}`)), 20_000);
              once.push(() => {
                clearTimeout(t);
                res();
              });
            });
            await s("Page.navigate", { url: target });
            await loaded;
          };
          await load("about:blank");
          await load(url);
          await evaluate("document.fonts.ready.then(() => true)");
          await Bun.sleep(400);
        },
        async screenshot(path, width) {
          const h = await evaluate<number>("Math.ceil(document.documentElement.scrollHeight)");
          await metrics(width, Math.max(h, 200));
          await Bun.sleep(150);
          const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
          await Bun.write(path, Buffer.from(data, "base64"));
          await metrics(width, 900);
        },
      };
    },
    async close() {
      ws.close();
      proc.kill();
      await proc.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
