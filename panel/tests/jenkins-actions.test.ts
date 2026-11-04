import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { JobActions } from "../src/actions/jobs";
import { JenkinsClient } from "../src/collectors/jenkins";
import { openDb } from "../src/db";

interface Fake {
  state: Record<string, unknown>;
  queue: Record<string, unknown>;
  build: Record<string, unknown>;
  buildPolls: Record<string, unknown>[];
  postStatus: number;
  location: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let client: JenkinsClient;
let fake: Fake;
let posts: string[];
let gets: string[];
let db: Database;

const fresh = (): Fake => ({
  state: { inQueue: false, buildable: true, lastBuild: { number: 7, building: false }, property: [{}] },
  queue: { executable: { number: 8 } },
  build: { building: true, result: null },
  buildPolls: [],
  postStatus: 201,
  location: "https://j.example.test/queue/item/55/",
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (req.method === "POST") {
        posts.push(u.pathname);
        return new Response(null, { status: fake.postStatus, headers: fake.location ? { location: fake.location } : {} });
      }
      gets.push(u.pathname);
      if (u.pathname === "/job/hang/api/json") return new Promise<Response>(() => {});
      if (u.pathname === "/job/vps-deploy/api/json") return Response.json(fake.state);
      if (fake.queue.broken && u.pathname.startsWith("/queue/")) return new Response("x", { status: 500 });
      if (fake.build.broken && u.pathname === "/job/vps-deploy/7/api/json" && fake.buildPolls.length === 0 && posts.length) return new Response("x", { status: 500 });
      if (u.pathname === "/queue/item/55/api/json") return fake.queue.gone ? new Response("nf", { status: 404 }) : Response.json(fake.queue);
      if (u.pathname === "/job/vps-deploy/7/api/json") return Response.json(fake.buildPolls.shift() ?? fake.build);
      return new Response("nf", { status: 404 });
    },
  });
  client = new JenkinsClient(`http://127.0.0.1:${server.port}`, "admin", "tok");
});
afterAll(() => void server.stop(true));
beforeEach(() => {
  fake = fresh();
  posts = [];
  gets = [];
  db = openDb(":memory:");
});

function actions(extra: Partial<ConstructorParameters<typeof JobActions>[0]> = {}) {
  let t = 0;
  return new JobActions({
    client,
    db,
    knownJobs: () => ["vps-deploy", "other-deploy"],
    now: () => t,
    sleep: async (ms) => void (t += ms),
    verifyTimeoutMs: 2000,
    pollMs: 500,
    ...extra,
  });
}

const rows = () => db.query<{ action: string; target: string; outcome: string; actor: string }, []>("SELECT action, target, outcome, actor FROM audit ORDER BY id").all();

describe("trigger", () => {
  test("posts /build for a plain job and verifies the build number from the queue item", async () => {
    const r = await actions().trigger("vps-deploy", "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified", build: 8, queueId: 55 });
    expect(posts).toEqual(["/job/vps-deploy/build"]);
    expect(rows()).toEqual([
      { action: "jenkins.build", target: "vps-deploy", outcome: "requested", actor: "owner" },
      { action: "jenkins.build", target: "vps-deploy", outcome: "verified", actor: "owner" },
    ]);
  });

  test("uses buildWithParameters when the job declares parameters", async () => {
    fake.state = { ...fake.state, property: [{ parameterDefinitions: [{ name: "FORCE_DEPLOY" }] }] };
    await actions().trigger("vps-deploy", "owner");
    expect(posts).toEqual(["/job/vps-deploy/buildWithParameters"]);
  });

  test("a build that stays queued is reported as queued with the reason", async () => {
    fake.queue = { why: "Waiting for next available executor", executable: null };
    const r = await actions().trigger("vps-deploy", "owner");
    expect(r).toMatchObject({ ok: true, outcome: "queued", queueId: 55 });
    expect(r.message).toContain("Waiting for next available executor");
  });

  test("a cancelled queue item is a failure", async () => {
    fake.queue = { cancelled: true };
    expect(await actions().trigger("vps-deploy", "owner")).toMatchObject({ ok: false, outcome: "failed" });
  });

  test("a vanished queue item and a missing Location are both unverified", async () => {
    fake.queue = { gone: true };
    expect(await actions().trigger("vps-deploy", "owner")).toMatchObject({ ok: false, outcome: "unverified" });
    fake.location = null;
    expect(await actions().trigger("vps-deploy", "owner")).toMatchObject({ ok: false, outcome: "unverified" });
  });

  test("refuses when already running, already queued or disabled, without posting", async () => {
    fake.state = { ...fake.state, lastBuild: { number: 7, building: true } };
    expect(await actions().trigger("vps-deploy", "owner")).toMatchObject({ outcome: "rejected", build: 7 });
    fake.state = { inQueue: true };
    expect(await actions().trigger("vps-deploy", "owner")).toMatchObject({ outcome: "rejected" });
    fake.state = { buildable: false };
    expect(await actions().trigger("vps-deploy", "owner")).toMatchObject({ outcome: "rejected" });
    expect(posts).toEqual([]);
  });

  test("a rejected POST is a failed outcome and is audited", async () => {
    fake.postStatus = 403;
    const r = await actions().trigger("vps-deploy", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.message).toContain("403");
    expect(rows().at(-1)?.outcome).toBe("failed");
  });

  test("unknown or malformed job names never reach Jenkins", async () => {
    const a = actions();
    expect(await a.trigger("nope", "owner")).toMatchObject({ outcome: "rejected" });
    expect(await a.trigger("../vps-deploy", "owner")).toMatchObject({ outcome: "rejected" });
    expect(gets).toEqual([]);
    expect(posts).toEqual([]);
    expect(rows()).toHaveLength(2);
  });
});

describe("stop", () => {
  test("posts /stop and verifies the build ends ABORTED", async () => {
    fake.buildPolls = [{ building: true, result: null }, { building: true, result: null }, { building: false, result: "ABORTED" }];
    fake.build = { building: false, result: "ABORTED" };
    const r = await actions().stop("vps-deploy", 7, "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified", build: 7 });
    expect(posts).toEqual(["/job/vps-deploy/7/stop"]);
    expect(rows().map((x) => [x.target, x.outcome])).toEqual([["vps-deploy#7", "requested"], ["vps-deploy#7", "verified"]]);
  });

  test("refuses to stop a build that is not running", async () => {
    fake.build = { building: false, result: "SUCCESS" };
    const r = await actions().stop("vps-deploy", 7, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
    expect(posts).toEqual([]);
  });

  test("a build that finishes another way is not claimed as stopped", async () => {
    fake.buildPolls = [{ building: true, result: null }, { building: false, result: "SUCCESS" }];
    expect(await actions().stop("vps-deploy", 7, "owner")).toMatchObject({ ok: false, outcome: "failed" });
  });

  test("a build that keeps running after the deadline is unverified", async () => {
    const r = await actions({ verifyTimeoutMs: 1000 }).stop("vps-deploy", 7, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "unverified" });
  });

  test("validates the build number", async () => {
    expect(await actions().stop("vps-deploy", 0, "owner")).toMatchObject({ outcome: "rejected" });
    expect(await actions().stop("vps-deploy", 1.5, "owner")).toMatchObject({ outcome: "rejected" });
  });
});

describe("per-job lock", () => {
  test("a second action on the same job is busy while the first verifies, other jobs are free", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.queue = { executable: null, why: "wait" };
    const a = actions({ sleep: () => gate });
    const first = a.trigger("vps-deploy", "owner");
    await Bun.sleep(50);
    expect(a.locked("vps-deploy")).toBe(true);
    expect(await a.stop("vps-deploy", 7, "owner")).toMatchObject({ ok: false, outcome: "busy" });
    expect(a.locked("other-deploy")).toBe(false);
    release();
    fake.queue = { executable: { number: 8 } };
    await first;
    expect(a.locked("vps-deploy")).toBe(false);
  });

  test("a hanging jenkins times out, releases the lock and reports failed", async () => {
    const slow = new JenkinsClient(`http://127.0.0.1:${server.port}`, "admin", "tok", 150);
    const a = actions({ client: slow, knownJobs: () => ["hang"] });
    const r = await a.trigger("hang", "me");
    expect(r.outcome).toBe("failed");
    expect(a.locked("hang")).toBe(false);
  });

  test("a queue verification error after the POST is unverified, not failed", async () => {
    fake.queue = { broken: true };
    const r = await actions().trigger("vps-deploy", "me");
    expect(r.outcome).toBe("unverified");
    expect(posts).toEqual(["/job/vps-deploy/build"]);
  });

  test("a verification error after the stop POST is unverified, not failed", async () => {
    fake.build = { building: true, result: null, broken: true };
    fake.buildPolls = [{ building: true, result: null }];
    const a = actions();
    const r = await a.stop("vps-deploy", 7, "me");
    expect(posts).toEqual(["/job/vps-deploy/7/stop"]);
    expect(r.outcome).toBe("unverified");
  });
});
