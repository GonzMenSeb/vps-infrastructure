import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  JOBS_PATH,
  JenkinsClient,
  JenkinsError,
  fetchConsole,
  EXECUTORS_PATH,
  fetchJobs,
  jenkinsClientFromConfig,
  parseJobs,
  progressPct,
  registerJenkinsSources,
  shortSha,
  stripConsoleNotes,
} from "../src/collectors/jenkins";
import { Store } from "../src/store";
import jobsFixture from "./fixtures/jenkins-jobs.json";

const AUTH = `Basic ${Buffer.from("admin:tok").toString("base64")}`;
const NOTE = "\x1b[8mha:////4MjzuNIWTSO4mnuywUf6=\x1b[0m";

let server: ReturnType<typeof Bun.serve>;
let client: JenkinsClient;
let jobsBody: unknown;
let seen: { method: string; path: string; auth: string | null }[] = [];
let consoleText = "";
let consoleMore = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get("authorization") });
      if (req.headers.get("authorization") !== AUTH) return new Response("no", { status: 403 });
      if (u.pathname === "/api/json") return Response.json(jobsBody);
      if (u.pathname === "/computer/api/json") return Response.json({ busyExecutors: 1, totalExecutors: 2 });
      const m = /^\/job\/([^/]+)\/(\d+)\/logText\/progressiveText$/.exec(u.pathname);
      if (m) {
        if (m[1] !== "vps-deploy") return new Response("nf", { status: 404 });
        const start = Number(u.searchParams.get("start"));
        const bytes = Buffer.from(consoleText);
        const slice = bytes.subarray(Math.min(start, bytes.length));
        const h: Record<string, string> = { "x-text-size": String(bytes.length) };
        if (consoleMore) h["x-more-data"] = "true";
        return new Response(slice, { headers: h });
      }
      return new Response("nf", { status: 404 });
    },
  });
  client = new JenkinsClient(`http://127.0.0.1:${server.port}/`, "admin", "tok");
});
afterAll(() => void server.stop(true));
beforeEach(() => {
  jobsBody = jobsFixture;
  seen = [];
  consoleText = "";
  consoleMore = false;
});

describe("parseJobs against the live-captured fixture", () => {
  const { jobs } = parseJobs(jobsFixture);
  const job = (n: string) => jobs.find((j) => j.name === n)!;

  test("lists every job, sorted, builds newest first", () => {
    expect(jobs.map((j) => j.name)).toEqual([
      "brujula-deploy", "categorizer-deploy", "decabot-deploy", "huella-deploy", "judicabot-deploy", "miplata-deploy", "vps-deploy",
    ]);
    for (const j of jobs) expect(j.builds.map((b) => b.number)).toEqual([...j.builds.map((b) => b.number)].sort((a, b) => b - a));
    expect(job("categorizer-deploy").builds).toHaveLength(10);
  });

  test("maps result, duration, estimate, sha and description", () => {
    const b = job("judicabot-deploy").builds[0]!;
    expect(b).toMatchObject({ number: 5, result: "SUCCESS", building: false, sha: "c19ab44", description: "c19ab44", estimatedMs: 86831 });
    expect(b.durationMs).toBe(99721);
    expect(job("vps-deploy").builds.find((x) => x.result === "FAILURE")?.number).toBe(37);
    expect(job("vps-deploy").lastCompleted).toEqual({ number: 38, result: "SUCCESS" });
  });

  test("classifies triggers and de-duplicates nothing it should not", () => {
    expect(job("vps-deploy").builds[0]!.trigger).toEqual({ kind: "manual", label: "Started by user admin", user: "admin" });
    expect(job("decabot-deploy").builds[0]!.trigger).toMatchObject({ kind: "push", user: null });
  });

  test("reports boolean parameters only, and parameter definitions", () => {
    expect(job("judicabot-deploy").parameterNames).toEqual(["FORCE_DEPLOY"]);
    expect(job("vps-deploy").parameterNames).toEqual([]);
    expect(job("judicabot-deploy").builds[1]!.params).toEqual([{ name: "FORCE_DEPLOY", value: "true" }]);
  });

  test("fixture holds no real domain, email or owner login", () => {
    const raw = JSON.stringify(jobsFixture);
    expect(raw).not.toMatch(/vespiridion|@|GonzMenSeb/i);
  });
});

describe("parseJobs on synthetic running and queued states", () => {
  const synthetic = {
    jobs: [
      {
        name: "decabot-deploy",
        buildable: true,
        inQueue: true,
        queueItem: { id: 77, why: "Waiting for next available executor", inQueueSince: 1000, stuck: false, blocked: false, buildable: true },
        property: [{}, { parameterDefinitions: [{ name: "FORCE_DEPLOY", type: "BooleanParameterDefinition" }] }],
        lastCompletedBuild: { number: 11, result: "FAILURE" },
        builds: [
          {
            number: 12, result: null, building: true, timestamp: 1_000_000, duration: 0, estimatedDuration: 100_000, description: null,
            actions: [
              { causes: [{ _class: "hudson.triggers.TimerTrigger$TimerTriggerCause", shortDescription: "Started by timer" }] },
              { parameters: [{ _class: "hudson.model.PasswordParameterValue", name: "SECRET", value: "x" }, { _class: "hudson.model.StringParameterValue", name: "S", value: "y" }] },
              { lastBuiltRevision: { SHA1: "ABCDEF1234567890" } },
            ],
          },
          { number: 11, result: "FAILURE", building: false, timestamp: 1, duration: 5, estimatedDuration: -1, actions: [{}] },
          { number: 10, result: "WEIRD", building: false, timestamp: 1, duration: 5, estimatedDuration: 0 },
        ],
      },
    ],
  };
  const j = parseJobs(synthetic).jobs[0]!;

  test("running build has no result or duration and keeps a progress estimate", () => {
    const b = j.builds[0]!;
    expect(b).toMatchObject({ building: true, result: null, durationMs: null, estimatedMs: 100_000, sha: "abcdef1" });
    expect(b.trigger?.kind).toBe("timer");
    expect(b.params).toEqual([]);
    expect(progressPct(b, 1_050_000)).toBe(50);
    expect(progressPct(b, 9_000_000)).toBe(99);
    expect(progressPct(b, 0)).toBe(0);
  });

  test("unknown estimate and unknown result degrade to null", () => {
    expect(j.builds[1]!.estimatedMs).toBeNull();
    expect(j.builds[1]!.sha).toBeNull();
    expect(j.builds[2]!.result).toBeNull();
    expect(progressPct({ building: true, timestamp: 0, estimatedMs: null }, 10)).toBeNull();
    expect(progressPct({ building: false, timestamp: 0, estimatedMs: 10 }, 5)).toBeNull();
  });

  test("queue entry is mapped", () => {
    expect(j.queued).toEqual({ id: 77, since: 1000, why: "Waiting for next available executor", stuck: false, blocked: false });
  });

  test("rejects a body without jobs", () => {
    expect(() => parseJobs({ nope: 1 })).toThrow();
  });
});

describe("client and source", () => {
  test("sends basic auth and the single tree request", async () => {
    const out = await fetchJobs(client);
    expect(out.jobs).toHaveLength(7);
    expect(out.executors).toEqual({ busy: 1, total: 2 });
    expect(seen.map((s) => s.path).sort()).toEqual([EXECUTORS_PATH, JOBS_PATH].sort());
    expect(seen.every((s) => s.auth === AUTH)).toBe(true);
  });

  test("a rejected credential surfaces as JenkinsError with status", async () => {
    const bad = new JenkinsClient(`http://127.0.0.1:${server.port}`, "admin", "wrong");
    await expect(fetchJobs(bad)).rejects.toMatchObject({ status: 403 });
    await expect(fetchJobs(bad)).rejects.toBeInstanceOf(JenkinsError);
  });

  test("registers jenkins:jobs on the store", async () => {
    const store = new Store();
    registerJenkinsSources(store, client, { timeoutMs: 2000, failureThreshold: 3, cooldownMs: 1000 });
    expect(store.names()).toEqual(["jenkins:jobs"]);
    expect(store.info("jenkins:jobs").opts.timeoutMs).toBe(5000);
    const snap = await store.refresh<{ jobs: unknown[] }>("jenkins:jobs");
    expect(snap.data?.jobs).toHaveLength(7);
  });

  test("client is only built when all three variables are set", () => {
    expect(jenkinsClientFromConfig({ JENKINS_URL: "https://j.example.test", JENKINS_USER: "u", JENKINS_TOKEN: undefined })).toBeNull();
    expect(jenkinsClientFromConfig({ JENKINS_URL: "https://j.example.test", JENKINS_USER: "u", JENKINS_TOKEN: "t" })).toBeInstanceOf(JenkinsClient);
  });

  test("shortSha accepts hex only", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha("nothex!")).toBeNull();
    expect(shortSha(undefined)).toBeNull();
  });
});

describe("console", () => {
  test("strips Jenkins console notes", () => {
    expect(stripConsoleNotes(`Started by user ${NOTE}admin\n`)).toBe("Started by user admin\n");
  });

  test("returns text, next offset and more flag from headers", async () => {
    consoleText = `Started by user ${NOTE}admin\nline 2\n`;
    consoleMore = true;
    const first = await fetchConsole(client, "vps-deploy", 38, 0);
    expect(first.text).toBe("Started by user admin\nline 2\n");
    expect(first.nextOffset).toBe(Buffer.byteLength(consoleText));
    expect(first.more).toBe(true);
    consoleText += "line 3\n";
    consoleMore = false;
    const next = await fetchConsole(client, "vps-deploy", 38, first.nextOffset);
    expect(next).toEqual({ text: "line 3\n", nextOffset: Buffer.byteLength(consoleText), more: false });
    expect(seen.at(-1)?.path).toContain(`start=${first.nextOffset}`);
  });

  test("offsets are bytes, not characters", async () => {
    consoleText = "é✓\n";
    const r = await fetchConsole(client, "vps-deploy", 1, 0);
    expect(r.nextOffset).toBe(6);
    const tail = await fetchConsole(client, "vps-deploy", 1, r.nextOffset);
    expect(tail.text).toBe("");
    expect(tail.nextOffset).toBe(6);
  });

  test("negative start reads the tail", async () => {
    consoleText = "0123456789";
    const r = await fetchConsole(client, "vps-deploy", 1, -4);
    expect(r).toEqual({ text: "6789", nextOffset: 10, more: false });
    const all = await fetchConsole(client, "vps-deploy", 1, -999);
    expect(all.text).toBe("0123456789");
  });

  test("a chunk over the cap is cut on a character boundary and flagged as more", async () => {
    consoleText = "a✓b✓c";
    const r = await fetchConsole(client, "vps-deploy", 1, 0, { maxBytes: 6 });
    expect(r.text).toBe("a✓b");
    expect(r.nextOffset).toBe(5);
    expect(r.more).toBe(true);
    const rest = await fetchConsole(client, "vps-deploy", 1, r.nextOffset);
    expect(r.text + rest.text).toBe(consoleText);
  });

  test("validates inputs and maps a missing build to JenkinsError 404", async () => {
    await expect(fetchConsole(client, "../x", 1, 0)).rejects.toThrow("invalid job name");
    await expect(fetchConsole(client, "vps-deploy", 0, 0)).rejects.toThrow("invalid build number");
    await expect(fetchConsole(client, "vps-deploy", 1, 1.5)).rejects.toThrow("invalid offset");
    await expect(fetchConsole(client, "other-job", 1, 0)).rejects.toMatchObject({ status: 404 });
  });
});
