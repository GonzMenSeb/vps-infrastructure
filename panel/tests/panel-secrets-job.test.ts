import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../infra/jenkins/panel-secrets.sh");
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
}

function sh(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
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
  return { dir, origin, work, pass, out: join(dir, "result.txt") };
}

const SECRET_VARS = "vault_alpha vault_beta vault_gamma vault_block vault_empty vault_dup vault_multi vault_last vault_missing_everywhere";

function run(r: Rig, name: string, value: string, extra: Record<string, string> = {}) {
  return sh(r.dir, ["bash", SCRIPT], {
    VAR_NAME: name,
    VAR_VALUE: value,
    PANEL_SECRET_VARS: SECRET_VARS,
    PANEL_HASH_VARS: "traefik_dashboard_auth",
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

  test.skipIf(!pythonHas("yaml"))("values with quotes, backslashes, dollars and hashes parse back byte for byte", () => {
    const value = `p"a\\ss'w$o rd #x:y [z] {k}`;
    ok(run(r, "vault_last", value));
    const f = join(r.dir, "parsed.yml");
    writeFileSync(f, originVault(r));
    const py = sh(r.dir, ["python3", "-I", "-c", "import sys,yaml;print(yaml.safe_load(open(sys.argv[1]))['vault_last'],end='')", f]);
    expect(py.out).toBe(value);
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
