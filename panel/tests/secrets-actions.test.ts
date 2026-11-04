import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretActions } from "../src/actions/secrets";
import { JenkinsClient } from "../src/collectors/jenkins";
import { openDb } from "../src/db";
import { loadManifest, type Manifest } from "../src/manifest";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "Sup3r-Secret-Value-123";

interface Fake {
  job: Record<string, unknown> | null;
  postStatus: number;
  queue: Record<string, unknown> | "gone";
  build: Record<string, unknown>;
  apply: Record<string, unknown>;
  posts: { path: string; search: string; type: string | null; body: string }[];
  unreachable: boolean;
}

let server: ReturnType<typeof Bun.serve>;
let client: JenkinsClient;
let fake: Fake;
let db: Database;
let manifest: Manifest;
let clock: number;
let root: string;

const fresh = (): Fake => ({
  job: { buildable: true, property: [{ parameterDefinitions: [{ name: "VAR_NAME" }, { name: "VAR_VALUE" }] }] },
  postStatus: 201,
  queue: { executable: null },
  build: { building: true },
  apply: { builds: [] },
  posts: [],
  unreachable: false,
});

beforeAll(async () => {
  manifest = await loadManifest("tests/fixtures/dev-services.json");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (fake.unreachable) return new Response("down", { status: 503 });
      if (req.method === "POST") {
        fake.posts.push({ path: u.pathname, search: u.search, type: req.headers.get("content-type"), body: await req.text() });
        return new Response(null, { status: fake.postStatus, headers: { location: "http://jenkins.example.test/queue/item/77/" } });
      }
      if (u.pathname === "/job/panel-secrets/api/json") return fake.job ? Response.json(fake.job) : new Response("nf", { status: 404 });
      if (u.pathname === "/queue/item/77/api/json") return fake.queue === "gone" ? new Response("nf", { status: 404 }) : Response.json(fake.queue);
      if (u.pathname === "/job/panel-secrets/5/api/json") return Response.json(fake.build);
      if (u.pathname === "/job/vps-deploy/api/json") return Response.json(fake.apply);
      return new Response("nf", { status: 404 });
    },
  });
  client = new JenkinsClient(`http://127.0.0.1:${server.port}`, "admin", "tok");
  root = mkdtempSync(join(tmpdir(), "secret-actions-"));
  mkdirSync(join(root, "opt/huella"), { recursive: true });
  writeFileSync(join(root, "opt/huella/.env"), "HUELLA_PASSWORD=env-file-password\nGEMINI_API_KEY=env-file-gemini\nOTHER=not-listed\n");
});
afterAll(() => {
  void server.stop(true);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  fake = fresh();
  db = openDb(":memory:");
  clock = 1_000_000;
});

const make = (o: Partial<ConstructorParameters<typeof SecretActions>[0]> = {}) =>
  new SecretActions({ client, db, manifest, job: "panel-secrets", applyJob: "vps-deploy", trackTimeoutMs: 40 * 60_000, envRoot: root, hashCost: 4, now: () => clock, ...o });

const audits = () => db.query<{ actor: string; action: string; target: string; outcome: string; detail: string | null }, []>("SELECT actor, action, target, outcome, detail FROM audit ORDER BY id").all();
const row = (a: SecretActions, id = 1) => a.store.get(id)!;

describe("reveal", () => {
  test("returns only the requested manifest key from the .env and audits without the value", async () => {
    const a = make();
    const r = await a.reveal("owner", "huella", "HUELLA_PASSWORD");
    expect(r).toEqual({ ok: true, value: "env-file-password" });
    expect(audits()).toEqual([{ actor: "owner", action: "secret.reveal", target: "huella/HUELLA_PASSWORD", outcome: "ok", detail: null }]);
    expect(JSON.stringify(audits())).not.toContain("env-file-password");
  });

  test("refuses keys the manifest does not list, vault-only variables, hashes and unknown services", async () => {
    const a = make();
    for (const [svc, key] of [["huella", "OTHER"], ["huella", "vault_huella_password"], ["traefik", "traefik_dashboard_auth"], ["jenkins", "vault_jenkins_admin_password"], ["nope", "X"]] as const) {
      expect(await a.reveal("owner", svc, key)).toMatchObject({ ok: false, status: 404 });
    }
    expect(audits().every((x) => x.outcome === "denied")).toBe(true);
  });

  test("reports an unreadable file and a key missing from it, each audited", async () => {
    const a = make();
    expect(await a.reveal("owner", "decabot", "DECABOT_PASSWORD")).toMatchObject({ ok: false, status: 500 });
    expect(await a.reveal("owner", "huella", "STRAVA_CLIENT_ID")).toMatchObject({ ok: false, status: 404 });
    expect(audits().map((x) => x.outcome)).toEqual(["error", "missing"]);
  });

  test("works without a Jenkins connection", async () => {
    const a = make({ client: null });
    expect(a.canEdit).toBe(false);
    expect(await a.reveal("owner", "huella", "GEMINI_API_KEY")).toEqual({ ok: true, value: "env-file-gemini" });
  });
});

describe("edit", () => {
  test("sends the value as a form body to buildWithParameters, never in the URL, and keeps it out of the database and audit log", async () => {
    const a = make();
    const r = await a.edit("owner", "decabot", "DECABOT_PASSWORD", SECRET);
    expect(r).toMatchObject({ ok: true, outcome: "queued", id: 1 });
    expect(fake.posts).toHaveLength(1);
    const p = fake.posts[0]!;
    expect(p.path).toBe("/job/panel-secrets/buildWithParameters");
    expect(p.search).toBe("");
    expect(p.type).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(p.body))).toEqual({ VAR_NAME: "vault_decabot_password", VAR_VALUE: SECRET });
    expect(row(a)).toMatchObject({ stage: "queued", queue_id: 77, var_name: "vault_decabot_password", service: "decabot" });
    const everything = JSON.stringify([audits(), db.query("SELECT * FROM secret_edits").all(), r]);
    expect(everything).not.toContain(SECRET);
    expect(audits().map((x) => x.outcome)).toEqual(["requested", "queued"]);
  });

  test("a hash credential sends a bcrypt htpasswd line, not the plaintext", async () => {
    const a = make();
    await a.edit("owner", "traefik", "traefik_dashboard_auth", "a-long-dashboard-password");
    const sent = new URLSearchParams(fake.posts[0]!.body);
    expect(sent.get("VAR_NAME")).toBe("traefik_dashboard_auth");
    expect(sent.get("VAR_VALUE")).toMatch(/^admin:\$2y\$04\$[./A-Za-z0-9]{53}$/);
    expect(fake.posts[0]!.body).not.toContain("a-long-dashboard-password");
  });

  test("validation, read-only credentials and unknown targets are rejected before Jenkins is contacted", async () => {
    const a = make();
    const cases: [string, string, string, string][] = [
      ["decabot", "DECABOT_PASSWORD", "bad\nvalue", "single line"],
      ["decabot", "DECABOT_PASSWORD", "{{ x }}", "template"],
      ["judicabot", "JUDICABOT_PASSWORD", "short-one", "at least 12"],
      ["miplata", "POSTGRES_PASSWORD", "new-value-1234", "Postgres"],
      ["jenkins", "vault_jenkins_admin_password", "new-value-1234", "Jenkins host"],
      ["nope", "X", "new-value-1234", "Unknown"],
    ];
    for (const [svc, key, value, msg] of cases) {
      const r = await a.edit("owner", svc, key, value);
      expect(r.ok).toBe(false);
      expect(r.outcome).toBe("rejected");
      expect(r.message).toContain(msg);
    }
    expect(fake.posts).toEqual([]);
    expect(a.store.active()).toEqual([]);
  });

  test("one pending change per service and per variable", async () => {
    const a = make();
    expect((await a.edit("owner", "huella", "HUELLA_PASSWORD", "first-password-1")).ok).toBe(true);
    const sameService = await a.edit("owner", "huella", "STRAVA_CLIENT_ID", "12345");
    expect(sameService).toMatchObject({ ok: false, outcome: "busy" });
    const sharedVar = await a.edit("owner", "decabot", "GEMINI_API_KEY", "gemini-key-0001");
    expect(sharedVar.ok).toBe(true);
    const sameVar = await a.edit("owner", "brujula", "GEMINI_API_KEY", "gemini-key-0002");
    expect(sameVar).toMatchObject({ ok: false, outcome: "busy" });
    expect(sameVar.message).toContain("decabot");
    expect(fake.posts).toHaveLength(2);
  });

  test("a missing job, undeclared parameters, a disabled job and a refused request fail with a reason and release the lock", async () => {
    const a = make();
    fake.job = null;
    expect(await a.edit("owner", "decabot", "DECABOT_PASSWORD", "value-number-1")).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("no job called panel-secrets") });
    fake.job = { buildable: true, property: [] };
    expect((await a.edit("owner", "decabot", "DECABOT_PASSWORD", "value-number-1")).message).toContain("VAR_NAME and VAR_VALUE");
    fake.job = { buildable: false, property: [{ parameterDefinitions: [{ name: "VAR_NAME" }, { name: "VAR_VALUE" }] }] };
    expect((await a.edit("owner", "decabot", "DECABOT_PASSWORD", "value-number-1")).message).toContain("disabled");
    fake = { ...fresh(), postStatus: 500 };
    const refused = await a.edit("owner", "decabot", "DECABOT_PASSWORD", "value-number-1");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("HTTP 500");
    expect(refused.message).not.toContain("value-number-1");
    expect(a.store.active()).toEqual([]);
    expect(row(a, 4).stage).toBe("failed");
  });

  test("editing is blocked with the stated reason when the dev bypass points at a real Jenkins", async () => {
    const a = make({ editBlocked: "blocked for the test" });
    expect(await a.edit("owner", "decabot", "DECABOT_PASSWORD", "value-number-1")).toMatchObject({ ok: false, outcome: "rejected", message: "blocked for the test" });
    expect(fake.posts).toEqual([]);
  });
});

describe("tracking", () => {
  const start = async (a: SecretActions) => {
    expect((await a.edit("owner", "decabot", "DECABOT_PASSWORD", SECRET)).ok).toBe(true);
  };

  test("queue, edit build, commit, deploy build, applied", async () => {
    const a = make();
    await start(a);
    fake.queue = { executable: null };
    await a.tick();
    expect(row(a).stage).toBe("queued");
    fake.queue = { executable: { number: 5 } };
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "editing", edit_build: 5 });
    fake.build = { building: true };
    await a.tick();
    expect(row(a).stage).toBe("editing");
    fake.build = { building: false, result: "SUCCESS", description: `commit ${SHA}` };
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "deploying", commit_sha: SHA });
    fake.apply = { builds: [{ number: 40, building: false, result: "SUCCESS", actions: [{ lastBuiltRevision: { SHA1: "f".repeat(40) } }] }] };
    await a.tick();
    expect(row(a).stage).toBe("deploying");
    fake.apply = { builds: [{ number: 41, building: true, actions: [{}, { lastBuiltRevision: { SHA1: SHA } }] }, ...(fake.apply.builds as unknown[])] };
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "deploying", deploy_build: 41 });
    fake.apply = { builds: [{ number: 41, building: false, result: "SUCCESS", actions: [{ lastBuiltRevision: { SHA1: SHA } }] }] };
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "applied", deploy_build: 41, message: null });
    expect(a.store.active()).toEqual([]);
    expect(audits().map((x) => x.outcome)).toEqual(["requested", "queued", "applied"]);
    expect(audits().at(-1)!.detail).toBe("var=vault_decabot_password; panel-secrets #5; vps-deploy #41");
    expect(JSON.stringify(audits())).not.toContain(SECRET);
  });

  test("a failed edit build, a cancelled queue item and a vanished queue item end the change with a reason", async () => {
    let a = make();
    await start(a);
    fake.queue = { executable: { number: 5 } };
    fake.build = { building: false, result: "FAILURE" };
    await a.tick();
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "failed" });
    expect(row(a).message).toContain("panel-secrets #5 finished as FAILURE");

    a = make();
    await start(a);
    fake.queue = { cancelled: true };
    await a.tick();
    expect(row(a, 2)).toMatchObject({ stage: "failed" });

    await start(a);
    fake.queue = "gone";
    await a.tick();
    expect(row(a, 3)).toMatchObject({ stage: "unverified" });
  });

  test("an unchanged value and a build that reports no commit are not reported as applied", async () => {
    const a = make();
    await start(a);
    fake.queue = { executable: { number: 5 } };
    fake.build = { building: false, result: "SUCCESS", description: "unchanged" };
    await a.tick();
    await a.tick();
    expect(row(a).stage).toBe("unchanged");
    await start(a);
    fake.build = { building: false, result: "SUCCESS", description: null };
    await a.tick();
    await a.tick();
    expect(row(a, 2).stage).toBe("unverified");
  });

  test("when pushes coalesce, a later apply build that started after the push counts, and an earlier one does not", async () => {
    const a = make();
    await start(a);
    fake.queue = { executable: { number: 5 } };
    fake.build = { building: false, result: "SUCCESS", description: `commit ${SHA}`, timestamp: 5_000_000, duration: 30_000 };
    await a.tick();
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "deploying", edit_done_at: 5_030_000 });
    const other = (n: number, at: number, result: string | null, building = false) => ({ number: n, timestamp: at, building, result, actions: [{ lastBuiltRevision: { SHA1: "e".repeat(40) } }] });
    fake.apply = { builds: [other(40, 5_029_999, "SUCCESS")] };
    await a.tick();
    expect(row(a).stage).toBe("deploying");
    fake.apply = { builds: [other(42, 5_040_000, null, true), other(41, 5_031_000, "SUCCESS"), other(40, 5_029_999, "SUCCESS")] };
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "applied", deploy_build: 41 });
    expect(row(a).message).toContain("vps-deploy #41 started after the commit was pushed");
  });

  test("a failed deploy says the change is committed but not applied", async () => {
    const a = make();
    await start(a);
    fake.queue = { executable: { number: 5 } };
    fake.build = { building: false, result: "SUCCESS", description: `commit ${SHA}` };
    await a.tick();
    await a.tick();
    fake.apply = { builds: [{ number: 41, building: false, result: "FAILURE", actions: [{ lastBuiltRevision: { SHA1: SHA } }] }] };
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "failed", deploy_build: 41 });
    expect(row(a).message).toContain("committed (0123456)");
    expect(row(a).message).toContain("vps-deploy #41 finished as FAILURE");
  });

  test("Jenkins being unreachable keeps the stage, and the change is given up on after the timeout", async () => {
    const a = make({ trackTimeoutMs: 10 * 60_000 });
    await start(a);
    fake.unreachable = true;
    await a.tick();
    expect(row(a).stage).toBe("queued");
    clock += 11 * 60_000;
    await a.tick();
    expect(row(a)).toMatchObject({ stage: "unverified" });
    expect(row(a).message).toContain("Stopped following");
    fake.unreachable = false;
    expect(await make().edit("owner", "decabot", "DECABOT_PASSWORD", "value-number-2")).toMatchObject({ ok: true });
  });

  test("after a restart, a change that never left 'starting' is marked unverified and in-flight ones resume", async () => {
    const a = make();
    await start(a);
    db.query("UPDATE secret_edits SET stage = 'starting' WHERE id = 1").run();
    await a.edit("owner", "huella", "HUELLA_PASSWORD", "another-password-1");
    const b = make();
    expect(b.store.get(1)).toMatchObject({ stage: "unverified" });
    expect(b.store.get(2)).toMatchObject({ stage: "queued" });
    fake.queue = { executable: { number: 5 } };
    await b.tick();
    expect(b.store.get(2)).toMatchObject({ stage: "editing", edit_build: 5 });
  });

  test("finished changes stay listed for a while, newest first", async () => {
    const a = make();
    await start(a);
    expect(a.store.recent("decabot", clock - 1000)).toHaveLength(1);
    expect(a.store.recent("huella", clock - 1000)).toEqual([]);
    clock += 2 * 60 * 60_000;
    expect(a.store.recent("decabot", clock - 30 * 60_000)).toHaveLength(1);
    a.store.update(1, { stage: "applied" }, clock - 60 * 60_000);
    expect(a.store.recent("decabot", clock - 30 * 60_000)).toEqual([]);
  });
});
