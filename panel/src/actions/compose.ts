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

const tail = (s: string) => (s.length > OUTPUT_CAP ? s.slice(s.length - OUTPUT_CAP) : s);

export class SpawnComposeRunner implements ComposeRunner {
  constructor(private dockerSocket: string) {}

  async run(dir: string, args: readonly string[], timeoutMs: number): Promise<ComposeResult> {
    const proc = Bun.spawn(["docker", "compose", ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        DOCKER_HOST: `unix://${this.dockerSocket}`,
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout: tail(stdout), stderr: tail(stderr), timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function commandLine(dir: string, args: readonly string[]): string {
  return `cd ${dir} && docker compose ${args.join(" ")}`;
}

export const noCompose: ComposeRunner = {
  run: () => Promise.reject(new Error("compose is disabled in this mode")),
};
