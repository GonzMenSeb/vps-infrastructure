import { constants } from "node:os";

export interface ComposeResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ComposeRunner {
  run(dir: string, args: readonly string[], timeoutMs: number): Promise<ComposeResult>;
}

const OUTPUT_CAP = 4096;
const DRAIN_GRACE_MS = 500;

const tail = (s: string) => (s.length > OUTPUT_CAP ? s.slice(s.length - OUTPUT_CAP) : s);

function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      text = tail(text + decoder.decode(value, { stream: true }));
    }
  })().catch(() => {});
  return { done, text: () => text, cancel: () => reader.cancel().catch(() => {}) };
}

function killGroup(proc: { pid: number; kill(signal: "SIGKILL"): void }): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

export class SpawnComposeRunner implements ComposeRunner {
  constructor(
    private dockerSocket: string,
    private bin = "docker",
  ) {}

  async run(dir: string, args: readonly string[], timeoutMs: number): Promise<ComposeResult> {
    const proc = Bun.spawn([this.bin, "compose", ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        DOCKER_HOST: `unix://${this.dockerSocket}`,
      },
    });
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(proc);
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([proc.exited, deadline]);
      clearTimeout(timer);
      await Promise.race([Promise.all([proc.exited, out.done, err.done]), Bun.sleep(DRAIN_GRACE_MS)]);
      const sig = proc.signalCode;
      const code = proc.exitCode ?? (sig ? 128 + (typeof sig === "number" ? sig : constants.signals[sig]) : -1);
      return { code, stdout: out.text(), stderr: err.text(), timedOut };
    } finally {
      clearTimeout(timer);
      void out.cancel();
      void err.cancel();
    }
  }
}

export function commandLine(dir: string, args: readonly string[]): string {
  return `cd ${dir} && docker compose ${args.join(" ")}`;
}

export const noCompose: ComposeRunner = {
  run: () => Promise.reject(new Error("compose is disabled in this mode")),
};
