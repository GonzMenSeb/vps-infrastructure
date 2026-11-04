import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const group = Bun.YAML.parse(read("group_vars/all.yml")) as Record<string, any>;

const referenced = [...new Set(Object.values<any>(group.panel_service_auth).flatMap((a) => a.vault_vars as string[]))].sort();
const editable: string[] = group.panel_secret_editable ?? [];
const locked = Object.keys(group.panel_secret_locked);
const minLength: Record<string, number> = group.panel_secret_min_length;

describe("the secret edit allowlist fails closed", () => {
  test("panel_secret_editable is an explicit list without duplicates", () => {
    expect(Array.isArray(group.panel_secret_editable)).toBe(true);
    expect(new Set(editable).size).toBe(editable.length);
  });

  test("every vault variable of panel_service_auth is editable or locked, exactly once", () => {
    const unclassified = referenced.filter((v) => !editable.includes(v) && !locked.includes(v));
    const both = referenced.filter((v) => editable.includes(v) && locked.includes(v));
    expect({ unclassified, both }).toEqual({ unclassified: [], both: [] });
  });

  test("neither list names a variable that no service uses", () => {
    expect([...editable, ...locked].filter((v) => !referenced.includes(v))).toEqual([]);
  });

  test("every locked variable carries a reason", () => {
    for (const reason of Object.values<unknown>(group.panel_secret_locked)) expect(String(reason).trim().length).toBeGreaterThan(20);
  });
});

describe("minimum lengths", () => {
  const SELF_CHOSEN = [
    "vault_vaultwarden_admin_token",
    "vault_decabot_password",
    "vault_brujula_password",
    "vault_huella_password",
    "vault_judicabot_password",
    "vault_miplata_admin_password",
    "vault_pdns_api_key",
    "vault_pdns_admin_secret_key",
    "vault_miplata_jwt_secret",
  ];

  test("every gate password, token and self-chosen key has a floor of 12", () => {
    expect(SELF_CHOSEN.filter((v) => (minLength[v] ?? 0) < 12)).toEqual([]);
  });

  test("only editable variables have a minimum", () => {
    expect(Object.keys(minLength).filter((v) => !editable.includes(v))).toEqual([]);
  });

  test("rotation always produces at least the floor", () => {
    for (const v of group.panel_secret_rotatable as string[]) expect(minLength[v] ?? 0).toBeGreaterThanOrEqual(12);
  });
});

const have = (bin: string) => Bun.which(bin) !== null;
const ansible = have("ansible-playbook") ? describe : describe.skip;

const scratch = mkdtempSync(join(tmpdir(), "panel-secrets-policy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let runs = 0;

function play(tasks: unknown[], extra: Record<string, unknown> = {}, files: string[] = []) {
  const dir = join(scratch, `run-${runs++}`);
  Bun.spawnSync(["mkdir", "-p", dir]);
  const names = new Set<string>();
  for (const f of ["group_vars/all.yml", "host_vars/jenkins.yml", "roles/jenkins/templates/casc.yml.j2", ...files]) {
    for (const m of read(f).matchAll(/\bvault_[a-z0-9_]+/g)) names.add(m[0]);
  }
  writeFileSync(join(dir, "stubs.json"), JSON.stringify(Object.fromEntries([...names].map((n) => [n, `stub-${n}`]))));
  writeFileSync(join(dir, "extra.json"), JSON.stringify(extra));
  const playbook = [
    {
      hosts: "localhost",
      connection: "local",
      gather_facts: false,
      vars_files: [join(ROOT, "group_vars/all.yml"), join(ROOT, "host_vars/jenkins.yml"), join(dir, "stubs.json")],
      tasks,
    },
  ];
  writeFileSync(join(dir, "play.json"), JSON.stringify(playbook));
  const r = Bun.spawnSync(["ansible-playbook", "-e", `@${join(dir, "extra.json")}`, join(dir, "play.json")], {
    cwd: dir,
    env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: "False", ANSIBLE_INVENTORY_UNPARSED_WARNING: "False", ANSIBLE_NOCOLOR: "True" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), dir };
}

function renderCasc(extra: Record<string, unknown> = {}) {
  const r = play([{ "ansible.builtin.template": { src: join(ROOT, "roles/jenkins/templates/casc.yml.j2"), dest: "out.yml" } }], extra);
  if (r.code !== 0) throw new Error(`casc render failed:\n${r.out.slice(-1500)}`);
  const casc = Bun.YAML.parse(readFileSync(join(r.dir, "out.yml"), "utf8")) as any;
  const env = new Map<string, string>(casc.jenkins.globalNodeProperties[0].envVars.env.map((e: { key: string; value: string }) => [e.key, e.value]));
  return { casc, env };
}

ansible("what Ansible hands to the Jenkins job", () => {
  test("PANEL_SECRET_VARS is exactly the editable list minus the locked variables", () => {
    const { env } = renderCasc();
    expect(env.get("PANEL_SECRET_VARS")!.split(" ")).toEqual([...editable].filter((v) => !locked.includes(v)).sort());
  });

  test("a vault variable nobody classified is not editable", () => {
    const auth = structuredClone(group.panel_service_auth);
    auth.decabot.vault_vars.push("vault_brand_new_thing");
    const { env } = renderCasc({ panel_service_auth: auth });
    expect(env.get("PANEL_SECRET_VARS")!.split(" ")).not.toContain("vault_brand_new_thing");
    expect(env.get("PANEL_SECRET_VARS")!.split(" ")).toContain("vault_decabot_password");
  });

  test("a variable that is both editable and locked is not editable", () => {
    const { env } = renderCasc({ panel_secret_locked: { ...group.panel_secret_locked, vault_decabot_password: "both lists on purpose for this test" } });
    expect(env.get("PANEL_SECRET_VARS")!.split(" ")).not.toContain("vault_decabot_password");
  });

  test("PANEL_SECRET_MIN carries name:length pairs for the same numbers the panel manifest gets", () => {
    const { env } = renderCasc();
    const pairs = Object.entries(minLength)
      .map(([k, v]) => `${k}:${v}`)
      .sort();
    expect(env.get("PANEL_SECRET_MIN")!.split(" ").sort()).toEqual(pairs);
    expect(pairs.length).toBeGreaterThanOrEqual(9);
    const manifest = read("roles/panel/templates/services.json.j2");
    expect(manifest).toContain("panel_secret_min_length");
    expect(manifest).toContain("panel_secret_vars");
  });

  test("the write credential is described as global, not as restricted to panel-secrets", () => {
    const { casc } = renderCasc();
    const cred = casc.credentials.system.domainCredentials[0].credentials.map((c: any) => c.basicSSHUserPrivateKey).find((c: any) => c?.id === "github-write-ssh-key");
    expect(cred.scope).toBe("GLOBAL");
    expect(cred.description).not.toMatch(/panel-secrets only/i);
    expect(read("roles/jenkins/templates/casc.yml.j2")).not.toMatch(/Only panel-secrets uses it/);
  });
});

ansible("the roles/panel guard", () => {
  const tasks = Bun.YAML.parse(read("roles/panel/tasks/main.yml")) as Record<string, any>[];
  const guard = tasks.find((t) => t.assert && /secret variable/i.test(String(t.name)));
  const runGuard = (extra: Record<string, unknown> = {}) => (guard ? play([guard], extra) : { code: 99, out: "no guard task found in roles/panel/tasks/main.yml", dir: "" });

  test("passes for the real group_vars", () => {
    const r = runGuard();
    expect({ code: r.code, out: r.code === 0 ? "" : r.out.slice(-800) }).toEqual({ code: 0, out: "" });
  });

  test("fails and names a vault variable that is neither editable nor locked", () => {
    const auth = structuredClone(group.panel_service_auth);
    auth.decabot.vault_vars.push("vault_brand_new_thing");
    const r = runGuard({ panel_service_auth: auth });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("vault_brand_new_thing");
  });

  test("fails and names a variable that is both editable and locked", () => {
    const r = runGuard({ panel_secret_locked: { ...group.panel_secret_locked, vault_decabot_password: "both lists on purpose for this test" } });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("vault_decabot_password");
  });
});
