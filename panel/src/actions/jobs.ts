import type { Database } from "bun:sqlite";
import { z } from "zod";
import { audit } from "../db";
import { JENKINS_SOURCES, JOB_NAME, type JenkinsClient, JenkinsError } from "../collectors/jenkins";
import type { Store } from "../store";

export type JobOutcome = "verified" | "queued" | "unverified" | "failed" | "rejected" | "busy";

export interface JobActionResult {
  ok: boolean;
  outcome: JobOutcome;
  message: string;
  build?: number;
  queueId?: number;
}

export interface JobActionDeps {
  client: JenkinsClient;
  db: Database;
  knownJobs: () => Iterable<string>;
  store?: Store;
  verifyTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const jobStateSchema = z.object({
  inQueue: z.boolean().optional(),
  buildable: z.boolean().optional(),
  lastBuild: z.object({ number: z.number(), building: z.boolean().optional() }).nullish(),
  property: z.array(z.object({ parameterDefinitions: z.array(z.object({ name: z.string() })).optional() })).optional(),
});

const queueItemSchema = z.object({
  cancelled: z.boolean().optional(),
  why: z.string().nullish(),
  executable: z.object({ number: z.number() }).nullish(),
});

const buildStateSchema = z.object({ building: z.boolean().optional(), result: z.string().nullish() });

const STATE_TREE = encodeURIComponent("inQueue,buildable,lastBuild[number,building],property[parameterDefinitions[name]]");

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class JobActions {
  private locks = new Set<string>();
  private verifyTimeoutMs: number;
  private pollMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: JobActionDeps) {
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? 15_000;
    this.pollMs = deps.pollMs ?? 500;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  locked(job: string): boolean {
    return this.locks.has(job);
  }

  async trigger(job: string, actor: string): Promise<JobActionResult> {
    return this.guarded("jenkins.build", job, null, actor, () => this.runTrigger(job));
  }

  async stop(job: string, build: number, actor: string): Promise<JobActionResult> {
    return this.guarded("jenkins.stop", job, build, actor, () => this.runStop(job, build));
  }

  private async guarded(
    action: string,
    job: string,
    build: number | null,
    actor: string,
    run: () => Promise<JobActionResult>,
  ): Promise<JobActionResult> {
    const target = build === null ? job : `${job}#${build}`;
    const record = (r: JobActionResult) => {
      audit(this.deps.db, { actor, action, target, outcome: r.outcome, detail: r.message });
      return r;
    };
    if (!JOB_NAME.test(job) || ![...this.deps.knownJobs()].includes(job)) {
      return record({ ok: false, outcome: "rejected", message: `unknown job ${job}` });
    }
    if (build !== null && (!Number.isInteger(build) || build < 1)) {
      return record({ ok: false, outcome: "rejected", message: `invalid build number ${build}` });
    }
    if (this.locks.has(job)) return record({ ok: false, outcome: "busy", message: `another action on ${job} is in progress` });
    this.locks.add(job);
    try {
      audit(this.deps.db, { actor, action, target, outcome: "requested" });
      return record(await run());
    } catch (err) {
      return record({ ok: false, outcome: "failed", message: errMessage(err) });
    } finally {
      this.locks.delete(job);
      if (this.deps.store) void this.deps.store.refresh(JENKINS_SOURCES.jobs).catch(() => {});
    }
  }

  private async runTrigger(job: string): Promise<JobActionResult> {
    const { client } = this.deps;
    const j = encodeURIComponent(job);
    const state = jobStateSchema.parse(await client.getJson(`/job/${j}/api/json?tree=${STATE_TREE}`));
    if (state.buildable === false) return { ok: false, outcome: "rejected", message: `${job} is disabled` };
    if (state.inQueue) return { ok: false, outcome: "rejected", message: `${job} is already queued` };
    if (state.lastBuild?.building) {
      return { ok: false, outcome: "rejected", message: `${job} is already running build #${state.lastBuild.number}`, build: state.lastBuild.number };
    }
    const parameterized = (state.property ?? []).some((p) => (p.parameterDefinitions ?? []).length > 0);
    let res: Response;
    try {
      res = await client.request("POST", `/job/${j}/${parameterized ? "buildWithParameters" : "build"}`);
    } catch (err) {
      if (err instanceof JenkinsError) throw err;
      return { ok: false, outcome: "unverified", message: `build request sent but no answer from jenkins: ${errMessage(err)}` };
    }
    await res.body?.cancel();
    const queueId = Number(/\/queue\/item\/(\d+)\/?$/.exec(res.headers.get("location") ?? "")?.[1]);
    if (!Number.isInteger(queueId)) {
      return { ok: false, outcome: "unverified", message: "jenkins accepted the request but returned no queue item to verify" };
    }
    return this.verifyQueued(queueId);
  }

  private async verifyQueued(queueId: number): Promise<JobActionResult> {
    const deadline = this.now() + this.verifyTimeoutMs;
    let why: string | null = null;
    for (;;) {
      try {
        const item = queueItemSchema.parse(await this.deps.client.getJson(`/queue/item/${queueId}/api/json?tree=cancelled,why,executable[number]`));
        if (item.executable) {
          return { ok: true, outcome: "verified", message: `build #${item.executable.number} started`, build: item.executable.number, queueId };
        }
        if (item.cancelled) return { ok: false, outcome: "failed", message: "the queued build was cancelled", queueId };
        why = item.why ?? null;
      } catch (err) {
        if (err instanceof JenkinsError && err.status === 404) {
          return { ok: false, outcome: "unverified", message: "the queue item vanished before a build number was reported", queueId };
        }
        return { ok: false, outcome: "unverified", message: `build requested but verification failed: ${errMessage(err)}`, queueId };
      }
      if (this.now() >= deadline) break;
      await this.sleep(this.pollMs);
    }
    return { ok: true, outcome: "queued", message: why ? `queued: ${why}` : "queued, waiting for an executor", queueId };
  }

  private async runStop(job: string, build: number): Promise<JobActionResult> {
    const { client } = this.deps;
    const path = `/job/${encodeURIComponent(job)}/${build}`;
    const before = buildStateSchema.parse(await client.getJson(`${path}/api/json?tree=building,result`));
    if (!before.building) {
      return { ok: false, outcome: "rejected", message: `#${build} is not running (${before.result ?? "unknown"})`, build };
    }
    const res = await client.request("POST", `${path}/stop`);
    await res.body?.cancel();
    const deadline = this.now() + this.verifyTimeoutMs;
    for (;;) {
      await this.sleep(this.pollMs);
      let s: z.infer<typeof buildStateSchema>;
      try {
        s = buildStateSchema.parse(await client.getJson(`${path}/api/json?tree=building,result`));
      } catch (err) {
        return { ok: false, outcome: "unverified", message: `stop sent but verification failed: ${errMessage(err)}`, build };
      }
      if (!s.building) {
        const ok = s.result === "ABORTED";
        return {
          ok,
          outcome: ok ? "verified" : "failed",
          message: ok ? `#${build} aborted` : `#${build} finished as ${s.result ?? "unknown"} before the stop took effect`,
          build,
        };
      }
      if (this.now() >= deadline) {
        return { ok: false, outcome: "unverified", message: `stop sent but #${build} was still running after ${Math.round(this.verifyTimeoutMs / 1000)}s`, build };
      }
    }
  }
}
