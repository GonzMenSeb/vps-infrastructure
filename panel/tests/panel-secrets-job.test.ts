import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../infra/jenkins/panel-secrets.sh");
const VERIFY = resolve(import.meta.dir, "../../infra/jenkins/panel-secrets-verify.yml");
const JENKINSFILE = readFileSync(resolve(import.meta.dir, "../../infra/jenkins/panel-secrets.Jenkinsfile"), "utf8");
const have = (bin: string) => Bun.which(bin) !== null;
const ready = existsSync(SCRIPT) && ["ansible-vault", "ansible-playbook", "git", "bash", "awk", "diff"].every(have);
const pythonHas = (mod: string) => have("python3") && Bun.spawnSync(["python3", "-I", "-c", `import ${mod}`]).exitCode === 0;

setDefaultTimeout(60_000);

const THROWAWAY_PASSWORD = "throwaway-vault-password-for-tests";
const OLD_HASH_USER = "admin";

const PLAIN = [
  "---",
  "# a comment that mentions vault_alpha: not-the-key",
  'vault_alpha: "alpha-old"',
  "vault_beta: 'beta-old'   # keep this comment",
  "vault_gamma: gamma-plain   # and this one",
  "vault_block: |",
  "  line one",
  "  vault_alpha: still-inside-the-block",
  "vault_empty:",
  'vault_dup: "a"',
  'vault_dup: "b"',
  "vault_multi: first",
  "  second",
  'vault_last: "last-old"',
  "",
].join("\n");

const GROUP = [
  "---",
  "domain: example.test",
  'traefik_dashboard_auth: "admin:$$2y$$05$$0123456789012345678901uAbCdEfGhIjKlMnOpQrStUvWxYz01234"',
  "other: kept",
  "",
].join("\n");

let root: string;
let counter = 0;

interface Rig {
  dir: string;
  origin: string;
  work: string;
  pass: string;
  out: string;
  shm: string;
  tmp: string;
}

function sh(cwd: string, cmd: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = Bun.spawnSync(cmd, { cwd, env: merged as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const git = (cwd: string, ...args: string[]) => {
  const r = sh(cwd, ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};

function rig(): Rig {
  const dir = join(root, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const work = join(dir, "work");
  const pass = join(dir, "pass");
  writeFileSync(pass, THROWAWAY_PASSWORD);
  chmodSync(pass, 0o600);
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  mkdirSync(join(seed, "group_vars"), { recursive: true });
  writeFileSync(join(seed, "vault.yml.plain"), PLAIN);
  writeFileSync(join(seed, "group_vars", "all.yml"), GROUP);
  const enc = sh(seed, ["ansible-vault", "encrypt", "--vault-password-file", pass, "--output", join(seed, "vault.yml"), join(seed, "vault.yml.plain")]);
  if (enc.code !== 0) throw new Error(`encrypt: ${enc.err}`);
  rmSync(join(seed, "vault.yml.plain"));
  git(dir, "init", "--quiet", "--initial-branch=main", seed);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "--quiet", "origin", "main");
  git(dir, "clone", "--quiet", origin, work);
  const shm = join(dir, "shm");
  const tmp = join(dir, "tmp");
  mkdirSync(shm);
  mkdirSync(tmp);
  return { dir, origin, work, pass, out: join(dir, "result.txt"), shm, tmp };
}

const ALLOWED_PUNCTUATION = "._~+=:@%^*!?,/-";
const EXCLUDED = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).filter((c) => !/[A-Za-z0-9]/.test(c) && !ALLOWED_PUNCTUATION.includes(c));

const SECRET_VARS = "vault_alpha vault_beta vault_gamma vault_block vault_empty vault_dup vault_multi vault_last vault_missing_everywhere";

function run(r: Rig, name: string, value: string, extra: Record<string, string | undefined> = {}, cwd = r.dir) {
  return sh(cwd, ["bash", SCRIPT], {
    VAR_NAME: name,
    VAR_VALUE: value,
    PANEL_SECRET_VARS: SECRET_VARS,
    PANEL_HASH_VARS: "traefik_dashboard_auth",
    PANEL_SECRET_MIN: "vault_min12:12",
    SHM_DIR: r.shm,
    TMPDIR: r.tmp,
    VAULT_PASSWORD_FILE: r.pass,
    WORK_DIR: r.work,
    OUTPUT_FILE: r.out,
    PUSH_RETRY_SLEEP: "0",
    ...extra,
  });
}

const ok = (res: ReturnType<typeof run>) => expect({ code: res.code, err: res.err }).toEqual({ code: 0, err: "" });

const decrypt = (r: Rig, file: string) => {
  const out = join(r.dir, "dec.yml");
  const d = sh(r.dir, ["ansible-vault", "decrypt", "--vault-password-file", r.pass, "--output", out, file]);
  if (d.code !== 0) throw new Error(`decrypt: ${d.err}`);
  return readFileSync(out, "utf8");
};

const originHead = (r: Rig) => git(r.dir, "--git-dir", r.origin, "rev-parse", "main");
const originVault = (r: Rig) => {
  const f = join(r.dir, "origin-vault.yml");
  writeFileSync(f, Bun.spawnSync(["git", "--git-dir", r.origin, "show", "main:vault.yml"]).stdout);
  return decrypt(r, f);
};
const originFile = (r: Rig, path: string) => Bun.spawnSync(["git", "--git-dir", r.origin, "show", `main:${path}`]).stdout.toString();
const everything = (r: Rig, res: ReturnType<typeof run>) =>
  [res.out, res.err, git(r.dir, "--git-dir", r.origin, "log", "--format=%B%an%ae", "main"), readFileSync(r.out, "utf8").toString().trim()].join("\n");

const replaceLine = (text: string, prefix: string, line: string) => text.split("\n").map((l) => (l.startsWith(prefix) ? line : l)).join("\n");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "panel-secrets-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const suite = ready ? describe : describe.skip;

suite("panel-secrets job script", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  test("replaces one quoted key, commits a message that names only the variable, and pushes to main", () => {
    const value = "alpha-NEW-1234567890";
    const before = originHead(r);
    const res = run(r, "vault_alpha", value);
    ok(res);
    const head = originHead(r);
    expect(head).not.toBe(before);
    expect(readFileSync(r.out, "utf8").trim()).toBe(`commit ${head}`);
    expect(git(r.dir, "--git-dir", r.origin, "log", "-1", "--format=%s", "main")).toBe("Update vault_alpha via the admin panel");
    expect(git(r.dir, "--git-dir", r.origin, "diff", "--name-only", `${before}`, head)).toBe("vault.yml");
    expect(originVault(r)).toBe(replaceLine(PLAIN, "vault_alpha:", `vault_alpha: "${value}"`));
    expect(everything(r, res)).not.toContain(value);
    const header = originFile(r, "vault.yml").split("\n")[0];
    expect(header).toBe("$ANSIBLE_VAULT;1.1;AES256");
    expect(originFile(r, "group_vars/all.yml")).toBe(GROUP);
  });

  test("keeps trailing comments on single-quoted and plain scalars", () => {
    ok(run(r, "vault_beta", "beta-new"));
    ok(run(r, "vault_gamma", "gamma-new"));
    const text = originVault(r);
    expect(text).toContain('vault_beta: "beta-new"   # keep this comment');
    expect(text).toContain('vault_gamma: "gamma-new"   # and this one');
    expect(text).toContain("  vault_alpha: still-inside-the-block");
  });

  test("every allowed punctuation character is written and read back byte for byte", () => {
    const value = `ab.cd_ef~gh+ij=kl:mn@op%qr^st*uv!wx?yz,01/23-45`;
    for (const c of ALLOWED_PUNCTUATION) expect(value).toContain(c);
    ok(run(r, "vault_last", value));
    expect(originVault(r)).toBe(replaceLine(PLAIN, "vault_last:", `vault_last: "${value}"`));
    if (pythonHas("yaml")) {
      const f = join(r.dir, "parsed.yml");
      writeFileSync(f, originVault(r));
      const py = sh(r.dir, ["python3", "-I", "-c", "import sys,yaml;print(yaml.safe_load(open(sys.argv[1]))['vault_last'],end='')", f]);
      expect(py.out).toBe(value);
    }
  });

  test("the examples that compose rewrites or rejects are refused with the allowed set in the message", () => {
    const before = originHead(r);
    for (const value of ["ab$cd-efghij12", "abc #def-12345", "'unterminated-quote", '"unterminated-quote', "back\\slash-12345", "abc;def-123456"]) {
      const res = run(r, "vault_alpha", value);
      expect({ value, code: res.code }).toEqual({ value, code: 1 });
      expect(res.err).toContain("may only contain letters, digits and . _ ~ + = : @ % ^ * ! ? , / -");
      expect(res.err).not.toContain(value);
    }
    expect(originHead(r)).toBe(before);
    expect(git(r.work, "status", "--porcelain")).toBe("");
  });

  test("every printable character outside the allowed set is refused for a vault variable", () => {
    expect(EXCLUDED.join("")).toBe("\"#$&'();<>[\\]`{|}");
    const before = originHead(r);
    for (const c of EXCLUDED) {
      const res = run(r, "vault_alpha", `ab${c}cd-efghij`);
      expect({ c, code: res.code, msg: res.err.includes("may only contain") }).toEqual({ c, code: 1, msg: true });
    }
    expect(originHead(r)).toBe(before);
  });

  test("verification does not depend on a default vault password file that may be missing, as ansible-core 2.20 errors on it", () => {
    const shim = join(r.dir, "shim");
    mkdirSync(shim);
    const real = Bun.which("ansible-playbook") as string;
    writeFileSync(join(shim, "ansible-playbook"), `#!/bin/sh\n[ -f "$ANSIBLE_VAULT_PASSWORD_FILE" ] || { echo "[ERROR]: The vault password file $ANSIBLE_VAULT_PASSWORD_FILE was not found"; exit 1; }\nexec ${real} "$@"\n`);
    chmodSync(join(shim, "ansible-playbook"), 0o755);
    const value = "alpha-NEW-1234567890";
    ok(run(r, "vault_alpha", value, { PATH: `${shim}:${process.env.PATH}`, ANSIBLE_VAULT_PASSWORD_FILE: ".vault_pass" }));
    expect(originVault(r)).toBe(replaceLine(PLAIN, "vault_alpha:", `vault_alpha: "${value}"`));
  });

  test("the repository's ansible.cfg in the working directory, as the pipeline workspace has it, does not break the edit", () => {
    const ws = join(r.dir, "workspace-with-checkout");
    mkdirSync(ws);
    copyFileSync(resolve(import.meta.dir, "../../ansible.cfg"), join(ws, "ansible.cfg"));
    const value = "alpha-NEW-1234567890";
    ok(run(r, "vault_alpha", value, {}, ws));
    expect(originVault(r)).toBe(replaceLine(PLAIN, "vault_alpha:", `vault_alpha: "${value}"`));
  });

  test("an identical value is reported as unchanged and nothing is committed", () => {
    const before = originHead(r);
    const res = run(r, "vault_alpha", "alpha-old");
    ok(res);
    expect(readFileSync(r.out, "utf8").trim()).toBe("unchanged");
    expect(originHead(r)).toBe(before);
  });

  const refusals: [string, string, string, RegExp][] = [
    ["a variable outside the allowlist", "vault_secret_not_listed", "x1234", /not in the allowlist/],
    ["an allowlisted variable that is not in the file", "vault_missing_everywhere", "x1234", /exactly once, found 0/],
    ["a block scalar", "vault_block", "x1234", /plain single-line scalar/],
    ["an empty value in the file", "vault_empty", "x1234", /plain single-line scalar/],
    ["a duplicated key", "vault_dup", "x1234", /exactly once, found 2/],
    ["a key whose value continues on the next line", "vault_multi", "x1234", /several lines/],
    ["a newline in the value", "vault_alpha", "line1\nline2", /printable ASCII/],
    ["a tab in the value", "vault_alpha", "a\tb", /printable ASCII/],
    ["non-ASCII characters", "vault_alpha", "café-secret", /printable ASCII/],
    ["a leading space", "vault_alpha", " padded", /start or end with a space/],
    ["a trailing space", "vault_alpha", "padded ", /start or end with a space/],
    ["a Jinja expression", "vault_alpha", "a{{ lookup('env','HOME') }}", /Jinja/],
    ["a Jinja statement", "vault_alpha", "a{% if 1 %}", /Jinja/],
    ["a Jinja comment", "vault_alpha", "a{# x #}", /Jinja/],
    ["an over-long value", "vault_alpha", "x".repeat(513), /1 to 512/],
    ["a name that is not an identifier", "vault_alpha; rm -rf", "x1234", /invalid variable name/],
  ];
  for (const [label, name, value, msg] of refusals) {
    test(`refuses ${label} and leaves origin and the working tree untouched`, () => {
      const before = originHead(r);
      const res = run(r, name, value);
      expect(res.code).not.toBe(0);
      expect(res.err).toMatch(msg);
      expect(res.err).not.toContain(value);
      expect(res.out).not.toContain(value);
      expect(originHead(r)).toBe(before);
      expect(git(r.work, "status", "--porcelain")).toBe("");
    });
  }

  test("a wrong vault password fails without a commit", () => {
    writeFileSync(r.pass, "not-the-password");
    const before = originHead(r);
    const res = run(r, "vault_alpha", "alpha-NEW-1234567890");
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("could not decrypt");
    expect(originHead(r)).toBe(before);
  });

  test("starts from the newest main, so someone else's commit is kept as the parent", () => {
    const other = join(r.dir, "other");
    git(r.dir, "clone", "--quiet", r.origin, other);
    writeFileSync(join(other, "README"), "hello\n");
    git(other, "add", "README");
    git(other, "commit", "--quiet", "-m", "someone else");
    git(other, "push", "--quiet", "origin", "main");
    const theirs = originHead(r);
    ok(run(r, "vault_alpha", "alpha-NEW-1234567890"));
    expect(git(r.dir, "--git-dir", r.origin, "rev-parse", "main~1")).toBe(theirs);
    expect(originFile(r, "README")).toBe("hello\n");
  });

  test("retries a rejected push against the newest main, never forces, and gives up after the limit", () => {
    const hook = join(r.origin, "hooks", "pre-receive");
    const counter = join(r.dir, "pushes");
    writeFileSync(hook, `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\necho $((n+1)) > "${counter}"\n[ "$n" -ge 1 ] || { echo rejected >&2; exit 1; }\n`);
    chmodSync(hook, 0o755);
    ok(run(r, "vault_alpha", "alpha-NEW-1234567890"));
    expect(readFileSync(counter, "utf8").trim()).toBe("2");

    writeFileSync(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n');
    const before = originHead(r);
    const res = run(r, "vault_beta", "beta-NEW-1234567890", { PUSH_ATTEMPTS: "2" });
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("rejected 2 times");
    expect(originHead(r)).toBe(before);
  });

  describe("minimum lengths from PANEL_SECRET_MIN", () => {
    test("a value shorter than the entry for its variable is refused, exactly the minimum is accepted", () => {
      const before = originHead(r);
      const short = run(r, "vault_alpha", "short-1", { PANEL_SECRET_MIN: "vault_beta:3 vault_alpha:12" });
      expect(short.code).toBe(1);
      expect(short.err).toContain("must be at least 12 characters");
      expect(short.err).not.toContain("short-1");
      expect(originHead(r)).toBe(before);
      ok(run(r, "vault_alpha", "twelve-chars", { PANEL_SECRET_MIN: "vault_beta:3 vault_alpha:12" }));
      expect(originHead(r)).not.toBe(before);
    });

    test("a variable without an entry has a minimum of one character", () => {
      ok(run(r, "vault_beta", "x", { PANEL_SECRET_MIN: "vault_alpha:12" }));
    });

    test("an empty PANEL_SECRET_MIN means no minimums, an unset one refuses the edit", () => {
      ok(run(r, "vault_beta", "x", { PANEL_SECRET_MIN: "" }));
      const res = run(r, "vault_gamma", "gamma-new", { PANEL_SECRET_MIN: undefined });
      expect(res.code).toBe(1);
      expect(res.err).toContain("PANEL_SECRET_MIN is not set");
    });

    for (const bad of ["vault_alpha", "vault_alpha:", ":12", "vault_alpha:abc", "vault_alpha:0", "vault_alpha:12:3", "vault_alpha=12", "bad name:12", "vault_alpha:12x"]) {
      test(`a malformed entry (${bad}) refuses the edit`, () => {
        const before = originHead(r);
        const res = run(r, "vault_beta", "beta-NEW-1234567890", { PANEL_SECRET_MIN: bad });
        expect(res.code).toBe(1);
        expect(res.err).toContain("malformed PANEL_SECRET_MIN");
        expect(originHead(r)).toBe(before);
      });
    }

    test("a hash variable does not depend on PANEL_SECRET_MIN", () => {
      const res = run(r, "traefik_dashboard_auth", "admin:plaintext", { PANEL_SECRET_MIN: undefined });
      expect(res.err).toContain("user:bcrypt");
    });
  });

  describe("the decrypted vault stays in shared memory", () => {
    const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("panel-secrets."));

    test("the work directory is created in SHM_DIR while the push runs and is gone afterwards", () => {
      const during = join(r.dir, "during.txt");
      const hook = join(r.origin, "hooks", "pre-receive");
      writeFileSync(hook, `#!/bin/sh\nls "${r.shm}" > "${during}"\n`);
      chmodSync(hook, 0o755);
      ok(run(r, "vault_alpha", "alpha-NEW-1234567890"));
      expect(readFileSync(during, "utf8")).toMatch(/^panel-secrets\./m);
      expect(readdirSync(r.shm)).toEqual([]);
      expect(leftovers(r.tmp)).toEqual([]);
    });

    test("a refusal after the work directory exists removes it too", () => {
      writeFileSync(r.pass, "not-the-password");
      const res = run(r, "vault_alpha", "alpha-NEW-1234567890");
      expect(res.err).toContain("could not decrypt");
      expect(readdirSync(r.shm)).toEqual([]);
    });

    const unusable: [string, (x: Rig) => string][] = [
      ["missing", (x) => join(x.dir, "no-such-dir")],
      [
        "a file",
        (x) => {
          const f = join(x.dir, "a-file");
          writeFileSync(f, "");
          return f;
        },
      ],
    ];
    for (const [label, make] of unusable) {
      test(`SHM_DIR being ${label} stops the job instead of writing to disk`, () => {
        const before = originHead(r);
        const res = run(r, "vault_alpha", "alpha-NEW-1234567890", { SHM_DIR: make(r) });
        expect(res.code).toBe(1);
        expect(res.err).toContain("refusing to write the decrypted vault to disk");
        expect(originHead(r)).toBe(before);
        expect(leftovers(r.tmp)).toEqual([]);
      });
    }

    test.skipIf(process.getuid?.() === 0)("SHM_DIR being read-only stops the job instead of writing to disk", () => {
      chmodSync(r.shm, 0o500);
      try {
        const res = run(r, "vault_alpha", "alpha-NEW-1234567890");
        expect(res.code).toBe(1);
        expect(res.err).toContain("refusing to write the decrypted vault to disk");
        expect(leftovers(r.tmp)).toEqual([]);
      } finally {
        chmodSync(r.shm, 0o700);
      }
    });
  });

  describe.skipIf(!have("dash") || !have("pkill"))("panel-secrets.Jenkinsfile under /bin/sh", () => {
    const stage = /sh '''([\s\S]*?)'''/.exec(JENKINSFILE)?.[1] ?? "";
    const cleanup = /post\s*\{\s*always\s*\{\s*sh '([^']*)'/.exec(JENKINSFILE)?.[1] ?? "";

    function publishInfra(x: Rig) {
      mkdirSync(join(x.work, "infra", "jenkins"), { recursive: true });
      copyFileSync(SCRIPT, join(x.work, "infra", "jenkins", "panel-secrets.sh"));
      copyFileSync(VERIFY, join(x.work, "infra", "jenkins", "panel-secrets-verify.yml"));
      git(x.work, "add", "infra");
      git(x.work, "commit", "--quiet", "-m", "infra");
      git(x.work, "push", "--quiet", "origin", "main");
    }

    const stageEnv = (x: Rig, extra: Record<string, string> = {}) => {
      const ws = join(x.dir, "ws");
      mkdirSync(ws, { recursive: true });
      return {
        ws,
        env: {
          ...process.env,
          WORKSPACE: ws,
          VAULT_PASS: THROWAWAY_PASSWORD,
          PANEL_SECRETS_REPO: x.origin,
          VAR_NAME: "vault_alpha",
          VAR_VALUE: "alpha-NEW-1234567890",
          PANEL_SECRET_VARS: SECRET_VARS,
          PANEL_HASH_VARS: "traefik_dashboard_auth",
          PANEL_SECRET_MIN: "vault_min12:12",
          PUSH_RETRY_SLEEP: "0",
          SHM_DIR: x.shm,
          TMPDIR: x.tmp,
          ...extra,
        } as Record<string, string>,
      };
    };
    const body = (x: Rig) => stage.replaceAll("/dev/shm", x.shm);

    test("the stage script and the cleanup command can be extracted from the Jenkinsfile", () => {
      expect(stage).toContain("panel-secrets.sh");
      expect(cleanup).toContain("$WORKSPACE/repo");
    });

    test("the stage pushes the edit and leaves nothing in shared memory", () => {
      publishInfra(r);
      const { ws, env } = stageEnv(r);
      const res = Bun.spawnSync(["dash", "-c", body(r)], { cwd: r.dir, env, stdout: "pipe", stderr: "pipe" });
      expect({ code: res.exitCode, err: res.stderr.toString() }).toEqual({ code: 0, err: "" });
      expect(readFileSync(join(ws, "result.txt"), "utf8")).toMatch(/^commit [0-9a-f]{40}$/m);
      expect(readdirSync(r.shm)).toEqual([]);
    });

    test("the stage stops instead of writing the vault password to disk when shared memory is unusable", () => {
      publishInfra(r);
      const missing = join(r.dir, "no-such-dir");
      const { env } = stageEnv(r, { SHM_DIR: missing });
      const res = Bun.spawnSync(["dash", "-c", stage.replaceAll("/dev/shm", missing)], { cwd: r.dir, env, stdout: "pipe", stderr: "pipe" });
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr.toString()).toContain("refusing to write");
      expect(readdirSync(r.tmp)).toEqual([]);
      expect(stage).not.toContain("TMPDIR");
    });

    test("an abort that signals the process tree leaves no vault password or decrypted vault behind", async () => {
      publishInfra(r);
      const started = join(r.dir, "hook-started");
      const stop = join(r.dir, "stop");
      const hook = join(r.origin, "hooks", "pre-receive");
      writeFileSync(hook, `#!/bin/sh\ntouch "${started}"\nwhile [ ! -e "${stop}" ]; do sleep 0.1; done\nexit 1\n`);
      chmodSync(hook, 0o755);
      const { env } = stageEnv(r);
      const proc = Bun.spawn(["dash", "-c", body(r)], { cwd: r.dir, env, stdout: "pipe", stderr: "pipe" });
      try {
        for (let i = 0; i < 400 && !existsSync(started); i++) await Bun.sleep(100);
        expect(existsSync(started)).toBe(true);
        expect(readdirSync(r.shm).some((n) => existsSync(join(r.shm, n, "vault-pass")))).toBe(true);
        process.kill(proc.pid, "SIGTERM");
        Bun.spawnSync(["pkill", "-TERM", "-P", String(proc.pid)]);
        await Promise.race([proc.exited, Bun.sleep(20_000)]);
      } finally {
        writeFileSync(stop, "");
        proc.kill("SIGKILL");
      }
      expect(readdirSync(r.shm)).toEqual([]);
    });

    test("the post-always step removes scratch directories the stage could not", () => {
      const { ws } = stageEnv(r);
      mkdirSync(join(ws, "repo"), { recursive: true });
      for (const d of [join(r.shm, "panel-secrets.AbC123"), join(r.tmp, "panel-secrets.XyZ789")]) {
        mkdirSync(d);
        writeFileSync(join(d, "vault-pass"), "leaked");
      }
      mkdirSync(join(r.shm, "something-else"));
      mkdirSync(join(r.tmp, "panel-secrets-test-keep"));
      const res = sh(ws, ["dash", "-c", cleanup.replaceAll("/dev/shm", r.shm)], { WORKSPACE: ws, TMPDIR: r.tmp });
      expect(res.code).toBe(0);
      expect(readdirSync(r.shm)).toEqual(["something-else"]);
      expect(readdirSync(r.tmp)).toEqual(["panel-secrets-test-keep"]);
      expect(existsSync(join(ws, "repo"))).toBe(false);
    });
  });

  describe("hash variables in group_vars/all.yml", () => {
    const pyBcrypt = pythonHas("bcrypt");
    const makeLine = () => {
      const h = sh(r.dir, ["python3", "-I", "-c", "import bcrypt;print(bcrypt.hashpw(b'a-new-dashboard-password', bcrypt.gensalt(10)).decode(),end='')"]).out;
      return `${OLD_HASH_USER}:${h.replace(/^\$2b\$/, "$2y$")}`;
    };

    test.skipIf(!pyBcrypt)("writes the htpasswd line with every dollar doubled for compose, and touches only that file", () => {
      const line = makeLine();
      const before = originHead(r);
      const res = run(r, "traefik_dashboard_auth", line);
      ok(res);
      const head = originHead(r);
      expect(git(r.dir, "--git-dir", r.origin, "diff", "--name-only", before, head)).toBe("group_vars/all.yml");
      expect(originFile(r, "group_vars/all.yml")).toBe(replaceLine(GROUP, "traefik_dashboard_auth:", `traefik_dashboard_auth: "${line.replaceAll("$", "$$$$")}"`));
      expect(originFile(r, "vault.yml")).toBe(Bun.spawnSync(["git", "--git-dir", r.origin, "show", `${before}:vault.yml`]).stdout.toString());
      expect(everything(r, res)).not.toContain(line);
    });

    test.skipIf(!pyBcrypt)("edits the real group_vars/all.yml of this repository and changes exactly one line", () => {
      const real = readFileSync(resolve(import.meta.dir, "../../group_vars/all.yml"), "utf8");
      writeFileSync(join(r.work, "group_vars", "all.yml"), real);
      git(r.work, "add", "-A");
      git(r.work, "commit", "--quiet", "-m", "use the real group_vars");
      git(r.work, "push", "--quiet", "origin", "main");
      const line = makeLine();
      ok(run(r, "traefik_dashboard_auth", line));
      const after = originFile(r, "group_vars/all.yml");
      const was = real.split("\n");
      const now = after.split("\n");
      expect(now.length).toBe(was.length);
      const differing = was.flatMap((l, i) => (l === now[i] ? [] : [i]));
      expect(differing).toHaveLength(1);
      expect(was[differing[0]!]).toStartWith("traefik_dashboard_auth: ");
      expect(now[differing[0]!]).toBe(`traefik_dashboard_auth: "${line.replaceAll("$", "$$$$")}"`);
    });

    for (const bad of ["admin:plaintext", "admin:$2y$05$short", "no-colon$2y$05$0123456789012345678901uAbCdEfGhIjKlMnOpQrStUvWxYz01234", "a b:$2y$05$0123456789012345678901uAbCdEfGhIjKlMnOpQrStUvWxYz01234"]) {
      test(`refuses a malformed hash line (${bad.slice(0, 18)})`, () => {
        const before = originHead(r);
        const res = run(r, "traefik_dashboard_auth", bad);
        expect(res.code).not.toBe(0);
        expect(res.err).toContain("user:bcrypt");
        expect(originHead(r)).toBe(before);
      });
    }

    test("a hash variable cannot be set through the vault path and vice versa", () => {
      expect(run(r, "traefik_dashboard_auth", "x1234", { PANEL_HASH_VARS: "" }).err).toContain("not in the allowlist");
      expect(run(r, "vault_alpha", "x1234", { PANEL_SECRET_VARS: "" }).err).toContain("not in the allowlist");
    });
  });
});
