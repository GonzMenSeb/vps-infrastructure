import capture from "../fixtures/jenkins-jobs.json";

type Raw = Record<string, any>;

export interface FakeJenkinsOptions {
  now?: () => number;
  seedRunMs?: number;
  triggeredRunMs?: number;
  startDelayMs?: number;
  seedRunning?: string;
  seedQueued?: string;
}

export interface FakeJenkins {
  url: string;
  requests: { method: string; path: string }[];
  stop: () => Promise<void>;
}

interface Running {
  job: string;
  number: number;
  startedAt: number;
  endsAt: number;
  estimatedMs: number;
  endedAt: number | null;
  result: string | null;
}

interface QueueItem {
  id: number;
  job: string;
  since: number;
  startsAt: number;
  build: number | null;
}

const NOTE = "\u001b[8mha:////4AFakeNoteForTheDevFixtureOnly==\u001b[0m";

export function startFakeJenkins(opts: FakeJenkinsOptions = {}): FakeJenkins {
  const now = opts.now ?? (() => Date.now());
  const seedRunMs = opts.seedRunMs ?? 10 * 60_000;
  const triggeredRunMs = opts.triggeredRunMs ?? 20_000;
  const startDelayMs = opts.startDelayMs ?? 1500;
  const seedRunning = opts.seedRunning ?? "vps-deploy";
  const seedQueued = opts.seedQueued ?? "decabot-deploy";
  const jobs = structuredClone((capture as { jobs: Raw[] }).jobs);
  const t0 = now();
  const newest = Math.max(...jobs.flatMap((j) => j.builds.map((b: Raw) => b.timestamp as number)));
  const shift = t0 - 2 * 3_600_000 - newest;
  for (const j of jobs) for (const b of j.builds) b.timestamp += shift;

  const runs: Running[] = [];
  const queue: QueueItem[] = [];
  let nextQueueId = 900;
  const lastNumber = (job: string) => Math.max(0, ...(jobs.find((j) => j.name === job)?.builds ?? []).map((b: Raw) => b.number as number), ...runs.filter((r) => r.job === job).map((r) => r.number));

  const startRun = (job: string, at: number, runMs: number, by: string): Running => {
    const r: Running = { job, number: lastNumber(job) + 1, startedAt: at, endsAt: at + runMs, estimatedMs: runMs, endedAt: null, result: null };
    runs.push(r);
    byWho.set(`${job}#${r.number}`, by);
    return r;
  };
  const byWho = new Map<string, string>();
  if (jobs.some((j) => j.name === seedRunning)) startRun(seedRunning, t0 - 40_000, seedRunMs, "owner");
  if (jobs.some((j) => j.name === seedQueued)) queue.push({ id: nextQueueId++, job: seedQueued, since: t0 - 12_000, startsAt: Number.POSITIVE_INFINITY, build: null });

  const settle = () => {
    const t = now();
    for (const r of runs) if (r.endedAt === null && t >= r.endsAt) Object.assign(r, { endedAt: r.endsAt, result: "SUCCESS" });
    for (const q of queue) {
      if (q.build === null && t >= q.startsAt) q.build = startRun(q.job, q.startsAt, triggeredRunMs, "owner").number;
    }
  };

  const runningOf = (job: string, n: number) => runs.find((r) => r.job === job && r.number === n);
  const isBuilding = (r: Running) => r.endedAt === null;

  const rawRun = (r: Running): Raw => ({
    _class: "org.jenkinsci.plugins.workflow.job.WorkflowRun",
    number: r.number,
    building: isBuilding(r),
    result: r.result,
    timestamp: r.startedAt,
    duration: isBuilding(r) ? 0 : r.endedAt! - r.startedAt,
    estimatedDuration: r.estimatedMs,
    description: null,
    actions: [{ causes: [{ _class: "hudson.model.Cause$UserIdCause", shortDescription: `Started by user ${byWho.get(`${r.job}#${r.number}`) ?? "owner"}`, userId: "owner" }] }],
  });

  const jobJson = (j: Raw): Raw => {
    const mine = runs.filter((r) => r.job === j.name).map(rawRun);
    const pending = queue.find((q) => q.job === j.name && q.build === null);
    const builds = [...mine, ...j.builds].sort((a, b) => b.number - a.number).slice(0, 10);
    const done = builds.find((b) => !b.building);
    return {
      ...j,
      builds,
      inQueue: Boolean(pending),
      queueItem: pending
        ? { id: pending.id, why: "Waiting for next available executor", inQueueSince: pending.since, stuck: false, blocked: false, buildable: true }
        : null,
      lastCompletedBuild: done ? { number: done.number, result: done.result } : j.lastCompletedBuild,
    };
  };

  const consoleText = (job: string, n: number): { text: string; more: boolean } | null => {
    const r = runningOf(job, n);
    const seeded = jobs.find((j) => j.name === job)?.builds.find((b: Raw) => b.number === n);
    if (!r && !seeded) return null;
    const building = r ? isBuilding(r) : false;
    const result = r ? r.result : (seeded.result as string);
    const elapsed = r ? (building ? now() - r.startedAt : r.endedAt! - r.startedAt) : 0;
    const count = building ? 6 + Math.floor(elapsed / 700) : r ? 6 + Math.floor(elapsed / 700) : 48;
    const lines = [`Started by user owner${NOTE}`, `Running in Durability level: MAX_SURVIVABILITY`, `[Pipeline] Start of Pipeline`, `[Pipeline] node`, `Running on built-in in /var/jenkins_home/workspace/${job}`, `[Pipeline] stage`];
    for (let i = 0; lines.length < count; i++) {
      const step = i % 6;
      lines.push(
        step === 0 ? `[Pipeline] { (Stage ${i / 6 + 1})` : step === 1 ? `+ ansible-playbook --check playbook.yml --tags step${i}` : step === 2 ? `\u001b[0;32mok: [vps] => (item=step${i})\u001b[0m` : step === 3 ? `\u001b[0;33mchanged: [vps] => task ${i}\u001b[0m` : step === 4 ? `PLAY RECAP: ok=${i} changed=0 failed=0` : `[Pipeline] }`,
      );
    }
    if (!building) lines.push("[Pipeline] End of Pipeline", `Finished: ${result ?? "SUCCESS"}`);
    return { text: `${lines.join("\n")}\n`, more: building };
  };

  const requests: FakeJenkins["requests"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const path = u.pathname;
      requests.push({ method: req.method, path });
      if (!req.headers.get("authorization")?.startsWith("Basic ")) return new Response("Authentication required", { status: 403 });
      settle();
      if (req.method === "GET" && path === "/api/json") return Response.json({ _class: "hudson.model.Hudson", jobs: jobs.map(jobJson) });
      if (req.method === "GET" && path === "/computer/api/json") {
        return Response.json({ busyExecutors: runs.filter(isBuilding).length, totalExecutors: 2 });
      }
      let m = /^\/job\/([^/]+)\/api\/json$/.exec(path);
      if (m && req.method === "GET") {
        const j = jobs.find((x) => x.name === decodeURIComponent(m![1]!));
        if (!j) return new Response("Not Found", { status: 404 });
        const jj = jobJson(j);
        const last = jj.builds[0];
        return Response.json({ inQueue: jj.inQueue, buildable: jj.buildable, lastBuild: last ? { number: last.number, building: last.building } : null, property: j.property });
      }
      m = /^\/job\/([^/]+)\/(build|buildWithParameters)$/.exec(path);
      if (m && req.method === "POST") {
        const job = decodeURIComponent(m[1]!);
        if (!jobs.some((x) => x.name === job)) return new Response("Not Found", { status: 404 });
        const q: QueueItem = { id: nextQueueId++, job, since: now(), startsAt: now() + startDelayMs, build: null };
        queue.push(q);
        return new Response(null, { status: 201, headers: { location: `${u.origin}/queue/item/${q.id}/` } });
      }
      m = /^\/queue\/item\/(\d+)\/api\/json$/.exec(path);
      if (m && req.method === "GET") {
        const q = queue.find((x) => x.id === Number(m![1]));
        if (!q) return new Response("Not Found", { status: 404 });
        return Response.json({ cancelled: false, why: q.build === null ? "Waiting for next available executor" : null, executable: q.build === null ? null : { number: q.build } });
      }
      m = /^\/job\/([^/]+)\/(\d+)\/api\/json$/.exec(path);
      if (m && req.method === "GET") {
        const r = runningOf(decodeURIComponent(m[1]!), Number(m[2]));
        const seeded = jobs.find((x) => x.name === decodeURIComponent(m![1]!))?.builds.find((b: Raw) => b.number === Number(m![2]));
        if (!r && !seeded) return new Response("Not Found", { status: 404 });
        return Response.json(r ? { building: isBuilding(r), result: r.result } : { building: false, result: seeded.result });
      }
      m = /^\/job\/([^/]+)\/(\d+)\/stop$/.exec(path);
      if (m && req.method === "POST") {
        const r = runningOf(decodeURIComponent(m[1]!), Number(m[2]));
        if (!r) return new Response("Not Found", { status: 404 });
        if (isBuilding(r)) Object.assign(r, { endedAt: now(), result: "ABORTED" });
        return new Response(null, { status: 302, headers: { location: `${u.origin}/job/${m[1]}/${m[2]}/` } });
      }
      m = /^\/job\/([^/]+)\/(\d+)\/logText\/progressiveText$/.exec(path);
      if (m && req.method === "GET") {
        const c = consoleText(decodeURIComponent(m[1]!), Number(m[2]));
        if (!c) return new Response("Not Found", { status: 404 });
        const bytes = Buffer.from(c.text);
        const start = Math.min(Math.max(Number(u.searchParams.get("start") ?? 0), 0), bytes.length);
        return new Response(bytes.subarray(start), {
          headers: { "content-type": "text/plain;charset=utf-8", "x-text-size": String(bytes.length), ...(c.more ? { "x-more-data": "true" } : {}) },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}
