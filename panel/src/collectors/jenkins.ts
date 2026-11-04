import { z } from "zod";
import type { Config } from "../config";
import type { SourceOptions, Store } from "../store";

export const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class JenkinsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const REQUEST_TIMEOUT_MS = 10_000;

export class JenkinsClient {
  private auth: string;
  private base: string;

  constructor(baseUrl: string, user: string, token: string, private timeoutMs = REQUEST_TIMEOUT_MS) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  }

  async request(method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: this.auth },
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    const ok = method === "POST" ? res.status >= 200 && res.status < 400 : res.ok;
    if (!ok) {
      await res.body?.cancel();
      throw new JenkinsError(res.status, `jenkins ${method} ${path.split("?")[0]}: HTTP ${res.status}`);
    }
    return res;
  }

  async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.request("GET", path, signal)).json();
  }
}

export function jenkinsClientFromConfig(cfg: Pick<Config, "JENKINS_URL" | "JENKINS_USER" | "JENKINS_TOKEN">): JenkinsClient | null {
  if (!cfg.JENKINS_URL || !cfg.JENKINS_USER || !cfg.JENKINS_TOKEN) return null;
  return new JenkinsClient(cfg.JENKINS_URL, cfg.JENKINS_USER, cfg.JENKINS_TOKEN);
}

export const HISTORY_PER_JOB = 10;

const BUILD_TREE =
  "number,result,building,timestamp,duration,estimatedDuration,description," +
  "actions[causes[_class,shortDescription,userId],parameters[_class,name,value],lastBuiltRevision[SHA1]]";

export const JOBS_TREE =
  "jobs[name,buildable,inQueue,queueItem[id,why,inQueueSince,stuck,blocked,buildable]," +
  "property[parameterDefinitions[name,type]],lastCompletedBuild[number,result]," +
  `builds[${BUILD_TREE}]{0,${HISTORY_PER_JOB}}]`;

export const EXECUTORS_PATH = "/computer/api/json?tree=busyExecutors,totalExecutors";

export const JOBS_PATH = `/api/json?tree=${encodeURIComponent(JOBS_TREE)}`;

const causeSchema = z.object({
  _class: z.string().optional(),
  shortDescription: z.string().optional(),
  userId: z.string().nullish(),
});

const paramValueSchema = z.object({
  _class: z.string().optional(),
  name: z.string().optional(),
  value: z.union([z.string(), z.boolean(), z.number()]).nullish(),
});

const actionSchema = z.object({
  causes: z.array(causeSchema).optional(),
  parameters: z.array(paramValueSchema).optional(),
  lastBuiltRevision: z.object({ SHA1: z.string().optional() }).nullish(),
});

const buildSchema = z.object({
  number: z.number(),
  result: z.string().nullish(),
  building: z.boolean().optional(),
  timestamp: z.number(),
  duration: z.number().optional(),
  estimatedDuration: z.number().optional(),
  description: z.string().nullish(),
  actions: z.array(actionSchema).optional(),
});

const jobSchema = z.object({
  name: z.string(),
  buildable: z.boolean().optional(),
  inQueue: z.boolean().optional(),
  queueItem: z
    .object({
      id: z.number(),
      why: z.string().nullish(),
      inQueueSince: z.number().nullish(),
      stuck: z.boolean().optional(),
      blocked: z.boolean().optional(),
      buildable: z.boolean().optional(),
    })
    .nullish(),
  property: z
    .array(z.object({ parameterDefinitions: z.array(z.object({ name: z.string(), type: z.string().optional() })).optional() }))
    .optional(),
  lastCompletedBuild: z.object({ number: z.number(), result: z.string().nullish() }).nullish(),
  builds: z.array(buildSchema).optional(),
});

const rootSchema = z.object({ jobs: z.array(jobSchema) });

export type BuildResult = "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "NOT_BUILT";
export type TriggerKind = "push" | "manual" | "timer" | "upstream" | "other";

export interface BuildTrigger {
  kind: TriggerKind;
  label: string;
  user: string | null;
}

export interface JenkinsBuild {
  number: number;
  result: BuildResult | null;
  building: boolean;
  timestamp: number;
  durationMs: number | null;
  estimatedMs: number | null;
  description: string | null;
  sha: string | null;
  trigger: BuildTrigger | null;
  params: { name: string; value: string }[];
}

export interface QueuedBuild {
  id: number;
  since: number | null;
  why: string | null;
  stuck: boolean;
  blocked: boolean;
}

export interface JenkinsJob {
  name: string;
  buildable: boolean;
  parameterNames: string[];
  queued: QueuedBuild | null;
  lastCompleted: { number: number; result: BuildResult | null } | null;
  builds: JenkinsBuild[];
}

export interface JenkinsExecutors {
  busy: number;
  total: number;
}

export interface JenkinsJobs {
  jobs: JenkinsJob[];
  executors?: JenkinsExecutors | null;
}

const RESULTS: readonly string[] = ["SUCCESS", "FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT"];
const SHOWN_PARAMS = ["BooleanParameterValue", "ChoiceParameterValue"];

const toResult = (r: string | null | undefined): BuildResult | null => (r && RESULTS.includes(r) ? (r as BuildResult) : null);

function triggerKind(cls: string | undefined): TriggerKind {
  if (!cls) return "other";
  if (cls.endsWith("GitHubPushCause") || cls.endsWith("SCMTriggerCause")) return "push";
  if (cls.endsWith("UserIdCause")) return "manual";
  if (cls.endsWith("TimerTriggerCause")) return "timer";
  if (cls.endsWith("UpstreamCause")) return "upstream";
  return "other";
}

export function shortSha(sha: string | null | undefined): string | null {
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : null;
}

function parseBuild(b: z.infer<typeof buildSchema>): JenkinsBuild {
  const actions = b.actions ?? [];
  const cause = actions.flatMap((a) => a.causes ?? [])[0];
  const sha = actions.map((a) => a.lastBuiltRevision?.SHA1).find((s) => s);
  const building = b.building === true;
  return {
    number: b.number,
    result: building ? null : toResult(b.result),
    building,
    timestamp: b.timestamp,
    durationMs: !building && b.duration !== undefined && b.duration >= 0 ? b.duration : null,
    estimatedMs: b.estimatedDuration !== undefined && b.estimatedDuration > 0 ? b.estimatedDuration : null,
    description: b.description || null,
    sha: shortSha(sha),
    trigger: cause
      ? { kind: triggerKind(cause._class), label: cause.shortDescription ?? "", user: cause.userId || null }
      : null,
    params: actions
      .flatMap((a) => a.parameters ?? [])
      .filter((p) => p.name && p.value != null && SHOWN_PARAMS.some((c) => p._class?.endsWith(c)))
      .map((p) => ({ name: p.name!, value: String(p.value) })),
  };
}

export function parseJobs(raw: unknown): JenkinsJobs {
  const root = rootSchema.parse(raw);
  return {
    jobs: root.jobs
      .map((j) => ({
        name: j.name,
        buildable: j.buildable !== false,
        parameterNames: (j.property ?? []).flatMap((p) => (p.parameterDefinitions ?? []).map((d) => d.name)),
        queued: j.queueItem
          ? {
              id: j.queueItem.id,
              since: j.queueItem.inQueueSince ?? null,
              why: j.queueItem.why ?? null,
              stuck: j.queueItem.stuck === true,
              blocked: j.queueItem.blocked === true,
            }
          : null,
        lastCompleted: j.lastCompletedBuild
          ? { number: j.lastCompletedBuild.number, result: toResult(j.lastCompletedBuild.result) }
          : null,
        builds: (j.builds ?? []).map(parseBuild).sort((a, b) => b.number - a.number),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function fetchJobs(client: JenkinsClient, signal?: AbortSignal): Promise<JenkinsJobs> {
  const [raw, executors] = await Promise.all([client.getJson(JOBS_PATH, signal), fetchExecutors(client, signal)]);
  return { ...parseJobs(raw), executors };
}

const executorsSchema = z.object({ busyExecutors: z.number(), totalExecutors: z.number() });

export async function fetchExecutors(client: JenkinsClient, signal?: AbortSignal): Promise<JenkinsExecutors | null> {
  try {
    const r = executorsSchema.parse(await client.getJson(EXECUTORS_PATH, signal));
    return { busy: r.busyExecutors, total: r.totalExecutors };
  } catch {
    return null;
  }
}

export function progressPct(b: Pick<JenkinsBuild, "building" | "timestamp" | "estimatedMs">, now: number): number | null {
  if (!b.building || b.estimatedMs === null) return null;
  return Math.max(0, Math.min(99, Math.floor(((now - b.timestamp) / b.estimatedMs) * 100)));
}

export interface ConsoleChunk {
  text: string;
  nextOffset: number;
  more: boolean;
}

export const CONSOLE_MAX_BYTES = 256 * 1024;
export const CONSOLE_TIMEOUT_MS = 8_000;

const CONSOLE_NOTE = /\x1b\[8mha:[^\x1b]*\x1b\[0m/g;

export function stripConsoleNotes(text: string): string {
  return text.replace(CONSOLE_NOTE, "");
}

function utf8Boundary(bytes: Uint8Array, limit: number): number {
  let end = Math.min(limit, bytes.length);
  if (end === bytes.length) return end;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  if (total >= cap) await reader.cancel();
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function fetchConsole(
  client: JenkinsClient,
  job: string,
  build: number,
  start: number,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ConsoleChunk> {
  if (!JOB_NAME.test(job)) throw new Error(`invalid job name: ${job}`);
  if (!Number.isInteger(build) || build < 1) throw new Error(`invalid build number: ${build}`);
  if (!Number.isInteger(start)) throw new Error(`invalid offset: ${start}`);
  const signal = opts.signal ?? AbortSignal.timeout(CONSOLE_TIMEOUT_MS);
  const path = `/job/${encodeURIComponent(job)}/${build}/logText/progressiveText`;
  let from = start;
  if (start < 0) {
    const probe = await client.request("GET", `${path}?start=${Number.MAX_SAFE_INTEGER}`, signal);
    await probe.body?.cancel();
    const size = Number(probe.headers.get("x-text-size"));
    if (!Number.isFinite(size)) throw new JenkinsError(502, "jenkins console: missing X-Text-Size");
    from = Math.max(0, size + start);
  }
  const res = await client.request("GET", `${path}?start=${from}`, signal);
  const limit = opts.maxBytes ?? CONSOLE_MAX_BYTES;
  const bytes = await readCapped(res, limit + 1);
  const size = Number(res.headers.get("x-text-size"));
  const more = res.headers.get("x-more-data") === "true";
  const cut = utf8Boundary(bytes, limit);
  const truncated = cut < bytes.length;
  const consumed = truncated || !Number.isFinite(size) ? from + cut : size;
  return {
    text: stripConsoleNotes(new TextDecoder().decode(bytes.subarray(0, cut))),
    nextOffset: consumed,
    more: more || truncated,
  };
}

export const JENKINS_SOURCES = { jobs: "jenkins:jobs" } as const;

export const JENKINS_TTL = { jobsMs: 5_000, minTimeoutMs: 5_000 } as const;

export function registerJenkinsSources(store: Store, client: JenkinsClient, base: Omit<SourceOptions, "ttlMs">): void {
  store.register(JENKINS_SOURCES.jobs, (signal) => fetchJobs(client, signal), {
    ...base,
    ttlMs: JENKINS_TTL.jobsMs,
    timeoutMs: Math.max(base.timeoutMs, JENKINS_TTL.minTimeoutMs),
  });
}
