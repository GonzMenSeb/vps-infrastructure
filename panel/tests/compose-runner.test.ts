import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnComposeRunner, commandLine, noCompose } from "../src/actions/compose";

let dir: string;
let work: string;
const savedSecrets: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vesp-bin-"));
  work = mkdtempSync(join(tmpdir(), "vesp work "));
  for (const k of ["SESSION_SECRET", "ZOT_PASSWORD"]) {
    savedSecrets[k] = process.env[k];
    process.env[k] = "must-not-leak";
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedSecrets)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function fakeDocker(script: string) {
  writeFileSync(fakeBin(), `#!/bin/sh\n${script}\n`);
  chmodSync(fakeBin(), 0o755);
}

const fakeBin = () => join(dir, "docker");
const runner = () => new SpawnComposeRunner("/run/test.sock", fakeBin());

describe("SpawnComposeRunner", () => {
  test("runs docker compose with the arguments as argv in the given directory", async () => {
    fakeDocker('echo "cwd=$(pwd)"; for a in "$@"; do echo "arg=$a"; done');
    const r = await runner().run(work, ["up", "-d", "--pull", "never"], 5000);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe(`cwd=${work}`);
    expect(lines.slice(1)).toEqual(["arg=compose", "arg=up", "arg=-d", "arg=--pull", "arg=never"]);
  });

  test("shell metacharacters in arguments stay literal because there is no shell", async () => {
    fakeDocker('for a in "$@"; do echo "arg=$a"; done');
    const r = await runner().run(work, ["stop; touch pwned", "$(id)"], 5000);
    expect(r.stdout).toContain("arg=stop; touch pwned");
    expect(r.stdout).toContain("arg=$(id)");
  });

  test("passes only PATH, HOME and DOCKER_HOST to the child", async () => {
    fakeDocker("env | sort");
    const r = await runner().run(work, ["ps"], 5000);
    const names = r.stdout.trim().split("\n").map((l) => l.split("=")[0]);
    expect(names).toContain("DOCKER_HOST");
    expect(r.stdout).toContain("DOCKER_HOST=unix:///run/test.sock");
    expect(r.stdout).not.toContain("must-not-leak");
    expect(names.filter((n) => !["PATH", "HOME", "DOCKER_HOST", "PWD", "SHLVL", "_", "OLDPWD"].includes(n!))).toEqual([]);
  });

  test("reports the exit code and the end of stderr", async () => {
    fakeDocker("echo oops >&2; exit 3");
    const r = await runner().run(work, ["stop"], 5000);
    expect(r).toMatchObject({ code: 3, timedOut: false });
    expect(r.stderr.trim()).toBe("oops");
  });

  test("kills a command that exceeds the timeout", async () => {
    fakeDocker("exec sleep 30");
    const t0 = Date.now();
    const r = await runner().run(work, ["up"], 200);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.code).not.toBe(0);
  });

  test("a missing directory is an error rather than a run in the wrong place", async () => {
    fakeDocker("echo should-not-run");
    mkdirSync(join(work, "x"));
    await expect(runner().run(join(work, "missing"), ["stop"], 5000)).rejects.toThrow();
  });
});

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

const pidOf = (file: string) => Number(readFileSync(file, "utf8").trim());
const reap = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

describe("SpawnComposeRunner timeout", () => {
  const FAST = 4000;

  test("kills the whole process group and returns without waiting for the pipes", async () => {
    const pidfile = join(work, "child.pid");
    fakeDocker(`sleep 300 &\necho $! > "${pidfile}"\nwait`);
    const t0 = Date.now();
    const r = await runner().run(work, ["up"], 300);
    const elapsed = Date.now() - t0;
    const child = pidOf(pidfile);
    try {
      expect(r.timedOut).toBe(true);
      expect(r.code).not.toBe(0);
      expect(elapsed).toBeLessThan(300 + 1000);
      expect(await goneWithin(child, 1000)).toBe(true);
    } finally {
      reap(child);
    }
  }, FAST);

  test("keeps what the command printed before it was killed", async () => {
    fakeDocker("echo before-kill; echo err-before-kill >&2; exec sleep 300");
    const r = await runner().run(work, ["up"], 300);
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toContain("before-kill");
    expect(r.stderr).toContain("err-before-kill");
  }, FAST);

  test.skipIf(!Bun.which("setsid"))("returns on time even when a descendant left the group and still holds the pipes", async () => {
    const pidfile = join(work, "escaped.pid");
    fakeDocker(`setsid sleep 300 &\necho $! > "${pidfile}"\nwait`);
    const t0 = Date.now();
    const r = await runner().run(work, ["up"], 300);
    const elapsed = Date.now() - t0;
    reap(pidOf(pidfile));
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(300 + 1500);
  }, FAST);

  test("a command that exits cleanly while a background child holds its pipes still returns", async () => {
    const pidfile = join(work, "daemon.pid");
    fakeDocker(`sleep 300 &\necho $! > "${pidfile}"\necho started`);
    const t0 = Date.now();
    const r = await runner().run(work, ["up"], 10_000);
    const elapsed = Date.now() - t0;
    reap(pidOf(pidfile));
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout).toContain("started");
    expect(elapsed).toBeLessThan(2500);
  }, FAST);

  test("a command that finishes in time is not marked timed out and its output is complete", async () => {
    fakeDocker("i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done");
    const r = await runner().run(work, ["ps"], 10_000);
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout.trimEnd().endsWith("line-1999")).toBe(true);
  }, FAST);
});

describe("helpers", () => {
  test("commandLine shows the exact command", () => {
    expect(commandLine("/opt/huella", ["up", "-d"])).toBe("cd /opt/huella && docker compose up -d");
  });

  test("noCompose refuses to run anything", async () => {
    await expect(noCompose.run("/opt/x", ["stop"], 1)).rejects.toThrow("disabled");
  });
});
