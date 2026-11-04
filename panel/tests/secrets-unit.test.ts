import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, parseManifest, type Manifest } from "../src/manifest";
import { NOT_ALLOWLISTED, credentialsFor, secretAllowlist } from "../src/secrets/credentials";
import { envPath, parseEnv, readEnvKeys } from "../src/secrets/envfile";
import { ALPHABET, GENERATED_LENGTH, SAFE_VALUE_SOURCE, generatePassword, htpasswdLine, validateValue } from "../src/secrets/values";

let manifest: Manifest;
const svc = (id: string) => manifest.services.find((s) => s.id === id)!;
const cred = (service: string, id: string) => credentialsFor(manifest, svc(service)).find((c) => c.id === id)!;

beforeAll(async () => {
  manifest = await loadManifest("tests/fixtures/dev-services.json");
});

describe("allowlist and credentials", () => {
  test("the allowlist is the main-VPS vault variables minus the locked ones, as Ansible renders it", () => {
    const a = secretAllowlist(manifest);
    expect([...a.vault].sort()).toEqual([
      "vault_brujula_password",
      "vault_decabot_gemini_api_key",
      "vault_decabot_password",
      "vault_grafana_oauth_client_id",
      "vault_grafana_oauth_client_secret",
      "vault_huella_password",
      "vault_judicabot_password",
      "vault_miplata_admin_password",
      "vault_miplata_jwt_secret",
      "vault_pdns_admin_secret_key",
      "vault_pdns_api_key",
      "vault_strava_client_id",
      "vault_strava_client_secret",
      "vault_vaultwarden_admin_token",
    ]);
    expect([...a.hash]).toEqual(["traefik_dashboard_auth"]);
  });

  test("a vault variable missing from the manifest's editable list is read-only, even when it is not locked", () => {
    const m = structuredClone(manifest);
    m.secrets.editable = m.secrets.editable.filter((v) => v !== "vault_decabot_password");
    expect(secretAllowlist(m).vault.has("vault_decabot_password")).toBe(false);
    const c = credentialsFor(m, m.services.find((s) => s.id === "decabot")!).find((x) => x.id === "DECABOT_PASSWORD")!;
    expect(c).toMatchObject({ editable: false, readOnlyReason: NOT_ALLOWLISTED });
  });

  test("a variable that is both editable and locked stays read-only", () => {
    const m = structuredClone(manifest);
    m.secrets.locked["vault_decabot_password"] = "locked on purpose";
    expect(secretAllowlist(m).vault.has("vault_decabot_password")).toBe(false);
  });

  test("a manifest without an editable list allows no vault variable", () => {
    const raw = JSON.parse(JSON.stringify(manifest));
    delete raw.secrets.editable;
    const m = parseManifest(raw);
    expect(m.secrets.editable).toEqual([]);
    expect(secretAllowlist(m).vault.size).toBe(0);
    expect(secretAllowlist(m).hash.size).toBe(1);
  });

  test("env keys map to their own variable and keep the lock reason", () => {
    const pw = cred("miplata", "POSTGRES_PASSWORD");
    expect(pw).toMatchObject({ var: "vault_miplata_db_password", revealable: true, editable: false, source: "env" });
    expect(pw.readOnlyReason).toContain("Postgres");
    const jwt = cred("miplata", "JWT_SECRET");
    expect(jwt).toMatchObject({ var: "vault_miplata_jwt_secret", editable: true, rotatable: false });
  });

  test("two keys can render one variable, and shared variables name the other services", () => {
    const a = cred("metabase", "MB_DB_PASS");
    const b = cred("metabase", "POSTGRES_PASSWORD");
    expect(a.var).toBe(b.var);
    const g = cred("huella", "GEMINI_API_KEY");
    expect(g.alsoUsedBy.map((s) => s.id).sort()).toEqual(["brujula", "decabot"]);
    expect(g.editable).toBe(true);
  });

  test("variables the .env does not render are listed as editable, not revealable", () => {
    const rows = credentialsFor(manifest, svc("metabase"));
    expect(rows.map((r) => r.id)).toEqual(["MB_DB_PASS", "POSTGRES_PASSWORD", "vault_miplata_ro_password", "vault_metabase_admin_password"]);
    const ro = rows.find((r) => r.id === "vault_miplata_ro_password")!;
    expect(ro).toMatchObject({ revealable: false, editable: false });
    expect(ro.readOnlyReason).toContain("Metabase keeps its own copy");
  });

  test("the traefik hash is editable, rotatable, never revealable, and carries the manifest note", () => {
    const [c, ...rest] = credentialsFor(manifest, svc("traefik"));
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ id: "traefik_dashboard_auth", source: "hash", user: "admin", revealable: false, editable: true, rotatable: true, minLength: 12 });
    expect(c!.note).toContain("Prometheus UI");
  });

  test("gate passwords are rotatable, others are not, and the judicabot minimum comes from the manifest", () => {
    expect(cred("judicabot", "JUDICABOT_PASSWORD")).toMatchObject({ rotatable: true, minLength: 12, editable: true });
    expect(cred("decabot", "GEMINI_API_KEY").rotatable).toBe(false);
  });

  test("jenkins host services and locked vault variables are read-only", () => {
    const j = credentialsFor(manifest, svc("jenkins"));
    expect(j.every((c) => !c.editable && !c.revealable)).toBe(true);
    expect(j[0]!.readOnlyReason).toContain("Jenkins host");
    const panel = credentialsFor(manifest, svc("panel"));
    expect(panel.length).toBe(4);
    expect(panel.every((c) => !c.editable)).toBe(true);
    expect(credentialsFor(manifest, svc("zot")).every((c) => !c.editable)).toBe(true);
  });

  test("a service with no secrets has no credentials", () => {
    expect(credentialsFor(manifest, svc("llm_inference"))).toEqual([]);
  });

  test("the manifest rejects an env_vars entry that points outside the service", () => {
    const base = JSON.parse(JSON.stringify({ services: [(manifest.services[1] as unknown) as object] }));
    base.services[0].auth.env_vars = { NOT_A_KEY: "vault_pdns_db_password" };
    expect(() => parseManifest(base)).toThrow(/env_vars key not in env_keys/);
    base.services[0].auth.env_vars = { DB_PASSWORD: "vault_other" };
    expect(() => parseManifest(base)).toThrow(/env_vars value not in vault_vars/);
  });
});

describe("value validation", () => {
  const plain = { source: "env" as const, minLength: 1 };
  test("accepts letters, digits and the allowed punctuation, and rejects newlines, tabs, controls and non-ASCII", () => {
    expect(validateValue(plain, "a-Z_0.9/:@!%^*~+=?,").ok).toBe(true);
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0000b", "café", "\u{1F600}"]) {
      expect(validateValue(plain, bad).ok).toBe(false);
    }
  });

  test("rejects every printable character the services' parsers would rewrite or cut off, and names the first one", () => {
    const excluded = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).filter((c) => !new RegExp(SAFE_VALUE_SOURCE).test(`ab${c}cd`));
    expect(excluded.join("")).toBe("\"#$&'();<>[\\]`{|}");
    for (const c of excluded) {
      const r = validateValue(plain, `ab${c}cd-efgh`);
      if (r.ok) throw new Error(`${c} was accepted`);
      expect(r.error).toContain(`"${c}" is not allowed.`);
      expect(r.error).toContain("may only contain letters, digits and . _ ~ + = : @ % ^ * ! ? , / -");
    }
    const space = validateValue(plain, "abc def-ghi");
    expect(space).toMatchObject({ ok: false, error: expect.stringContaining("A space is not allowed.") });
    for (const example of ["ab$cd", "abc #def", "'unterminated", "back\\slash"]) expect(validateValue(plain, example).ok).toBe(false);
  });

  test("the first problem wins: length, then printable ASCII, then Jinja, then the character set", () => {
    const m = { source: "env" as const, minLength: 12 };
    expect((validateValue(m, "a$b") as { error: string }).error).toContain("at least 12");
    expect((validateValue(m, "a$b\ncdefghijklm") as { error: string }).error).toContain("printable ASCII");
    expect((validateValue(m, "a{{b}}cdefghijkl") as { error: string }).error).toContain("{{");
    expect((validateValue(m, "a$bcdefghijklm") as { error: string }).error).toContain('"$" is not allowed.');
  });

  test("a hash password is hashed, not stored, so any printable ASCII is fine", () => {
    expect(validateValue({ source: "hash", minLength: 12 }, `it's a "phrase" with $ # \\ and spaces`).ok).toBe(true);
  });

  test("length bounds, surrounding spaces and Jinja delimiters", () => {
    expect(validateValue(plain, "").ok).toBe(false);
    expect(validateValue(plain, "x".repeat(512)).ok).toBe(true);
    expect(validateValue(plain, "x".repeat(513)).ok).toBe(false);
    expect(validateValue(plain, " x").ok).toBe(false);
    expect(validateValue(plain, "x ").ok).toBe(false);
    for (const j of ["{{ x }}", "a{%b", "a{#b"]) expect(validateValue(plain, j).ok).toBe(false);
    expect(validateValue({ source: "env", minLength: 12 }, "elevenchars").ok).toBe(false);
    expect(validateValue({ source: "env", minLength: 12 }, "twelve-chars").ok).toBe(true);
    expect(validateValue(plain, 42 as unknown).ok).toBe(false);
  });

  test("hash passwords are capped at 72 bytes, where bcrypt stops reading", () => {
    const h = { source: "hash" as const, minLength: 12 };
    expect(validateValue(h, "x".repeat(72)).ok).toBe(true);
    expect(validateValue(h, "x".repeat(73)).ok).toBe(false);
  });
});

describe("generated secrets and hashes", () => {
  test("random passwords are long, from the unambiguous alphabet, and different each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(seen.size).toBe(50);
    for (const p of seen) {
      expect(p).toHaveLength(GENERATED_LENGTH);
      expect(p).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    }
    expect(GENERATED_LENGTH).toBeGreaterThanOrEqual(24);
  });

  test("the rotate alphabet and the browser generator stay inside the allowed character set", () => {
    const safe = new RegExp(SAFE_VALUE_SOURCE);
    expect(safe.test(ALPHABET)).toBe(true);
    for (let i = 0; i < 200; i++) expect(safe.test(generatePassword())).toBe(true);
    const browser = /const ALPHABET = "([^"]+)";/.exec(readFileSync("public/controllers/secret.js", "utf8"))?.[1];
    expect(browser).toBe(ALPHABET);
    expect(validateValue({ source: "env", minLength: 12 }, generatePassword()).ok).toBe(true);
  });

  test("panel-secrets.sh checks against the same character set as the panel", () => {
    const script = readFileSync("../infra/jenkins/panel-secrets.sh", "utf8");
    expect(/safe_re='([^']+)'/.exec(script)?.[1]).toBe(SAFE_VALUE_SOURCE);
  });

  test("htpasswd lines use the $2y$ prefix and verify with Bun", async () => {
    const line = await htpasswdLine("admin", "correct horse battery", 4);
    expect(line).toMatch(/^admin:\$2y\$04\$[./A-Za-z0-9]{53}$/);
    expect(await Bun.password.verify("correct horse battery", line.slice(6).replace("$2y$", "$2b$"))).toBe(true);
    expect(await Bun.password.verify("wrong password!!", line.slice(6).replace("$2y$", "$2b$"))).toBe(false);
  });

  const py = Bun.which("python3") !== null && Bun.spawnSync(["python3", "-I", "-c", "import bcrypt"]).exitCode === 0;
  test.skipIf(!py)("an independent bcrypt implementation accepts the hash for the full 72 bytes", async () => {
    const password = "p".repeat(71) + "q";
    const line = await htpasswdLine("admin", password, 5);
    const hash = line.slice("admin:".length);
    const check = (pw: string) =>
      Bun.spawnSync(["python3", "-I", "-c", "import sys,bcrypt;print(bcrypt.checkpw(sys.argv[2].encode(), sys.argv[1].encode()))", hash, pw]).stdout.toString().trim();
    expect(check(password)).toBe("True");
    expect(check("p".repeat(71) + "r")).toBe("False");
    expect(check("short")).toBe("False");
  });
});

describe("env files", () => {
  test("parses plain, quoted, exported and commented lines the way compose reads them", () => {
    const env = parseEnv(
      [
        "# comment",
        "",
        "PLAIN=abc123",
        "SPACED = padded  ",
        'DQ="quoted \\"x\\" value"',
        "SQ='single # not a comment'",
        "INLINE=value # comment",
        "HASHINSIDE=ab#cd",
        "export EXPORTED=yes",
        "EMPTY=",
        "CRLF=windows\r",
        "not a line",
        "=novalue",
      ].join("\n"),
    );
    expect(Object.fromEntries(env)).toEqual({
      PLAIN: "abc123",
      SPACED: "padded",
      DQ: 'quoted "x" value',
      SQ: "single # not a comment",
      INLINE: "value",
      HASHINSIDE: "ab#cd",
      EXPORTED: "yes",
      EMPTY: "",
      CRLF: "windows",
    });
  });

  test("the path is the manifest directory plus .env, re-rooted for the fake tree, and rejects traversal", () => {
    expect(envPath({ dir: "/opt/miplata" })).toBe("/opt/miplata/.env");
    expect(envPath({ dir: "/opt/miplata/" })).toBe("/opt/miplata/.env");
    expect(envPath({ dir: "/opt/miplata" }, "/tmp/fake")).toBe("/tmp/fake/opt/miplata/.env");
    expect(envPath({ dir: "/opt/../etc" })).toBeNull();
    expect(envPath({ dir: "/opt//miplata" })).toBeNull();
  });

  test("only the requested keys come back, absent ones as null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "env-read-"));
    try {
      mkdirSync(join(dir, "opt/x"), { recursive: true });
      writeFileSync(join(dir, "opt/x/.env"), "A=1\nB=2\nC=3\n");
      const r = await readEnvKeys(envPath({ dir: "/opt/x" }, dir), ["A", "MISSING"]);
      expect(r.ok).toBe(true);
      if (r.ok) expect([...r.values.entries()]).toEqual([["A", "1"], ["MISSING", null]]);
      expect(await readEnvKeys(join(dir, "nope/.env"), ["A"])).toEqual({ ok: false, reason: "unreadable" });
      expect(await readEnvKeys(null, ["A"])).toEqual({ ok: false, reason: "bad-path" });
      writeFileSync(join(dir, "big"), "x".repeat(1024 * 1024 + 1));
      expect(await readEnvKeys(join(dir, "big"), ["A"])).toEqual({ ok: false, reason: "too-large" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the allowed character set survives the services' parsers", () => {
  const punctuation = "._~+=:@%^*!?,/-";
  const values = [
    ...[...punctuation].flatMap((c) => [`ab${c}cd${c}ef`, `${c}abcdefgh`, `abcdefgh${c}`]),
    "ab.cd_ef~gh+ij=kl:mn@op%qr^st*uv!wx?yz,01/23-45",
  ];

  test("the reveal path reads each value back from an unquoted .env line unchanged", () => {
    const env = parseEnv(values.map((v, i) => `K${i}=${v}`).join("\n"));
    expect(values.filter((v, i) => env.get(`K${i}`) !== v)).toEqual([]);
  });

  const haveCompose = Bun.which("docker") !== null && Bun.spawnSync(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  const compose = (envLines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "compose-env-"));
    try {
      const keys = envLines.map((_, i) => `E${i}`);
      writeFileSync(join(dir, ".env"), envLines.join("\n") + "\n");
      writeFileSync(join(dir, "docker-compose.yml"), ["services:", "  a:", "    image: busybox", "    env_file: .env", "    environment:", ...keys.map((k, i) => `      I${i}: \${E${i}}`)].join("\n") + "\n");
      const r = Bun.spawnSync(["docker", "compose", "config", "--format", "json"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, env: r.exitCode === 0 ? (JSON.parse(r.stdout.toString()).services.a.environment as Record<string, string>) : {}, err: r.stderr.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test.skipIf(!haveCompose)("docker compose reads each value back unchanged both from env_file and through interpolation", () => {
    const r = compose(values.map((v, i) => `E${i}=${v}`));
    expect(r.code).toBe(0);
    expect(values.flatMap((v, i) => [r.env[`E${i}`] === v ? [] : [`env_file ${v}`], r.env[`I${i}`] === v ? [] : [`interpolation ${v}`]].flat())).toEqual([]);
  });

  test.skipIf(!haveCompose)("control: the same check does catch the characters the allowlist excludes", () => {
    const r = compose(["E0=abc #def", "E1=ab'cd"]);
    expect(r.code === 0 && r.env["E0"] === "abc #def").toBe(false);
  });
});
