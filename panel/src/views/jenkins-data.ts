import type { JenkinsJobs } from "../collectors/jenkins";
import type { LogTargets } from "../collectors/loki";
import type { Snapshot } from "../store";
import type { JenkinsData, LogContainer } from "./model";

export function toJenkinsData(src: JenkinsJobs): JenkinsData {
  return {
    jobs: src.jobs.map((j) => j.name),
    parameterized: src.jobs.filter((j) => j.parameterNames.length > 0).map((j) => j.name),
    executors: src.executors ?? null,
    queue: src.jobs.flatMap((j) => (j.queued ? [{ id: j.queued.id, job: j.name, why: j.queued.why, since: j.queued.since }] : [])),
    builds: src.jobs.flatMap((j) =>
      j.builds.map((b) => ({
        job: j.name,
        number: b.number,
        result: b.result,
        building: b.building,
        timestamp: b.timestamp,
        duration: b.durationMs ?? 0,
        estimatedDuration: b.estimatedMs,
        cause: b.trigger?.label ?? null,
      })),
    ),
  };
}

const mapSnapshot = <A, B>(snap: Snapshot<A>, fn: (a: A) => B): Snapshot<B> => ({
  ...snap,
  data: snap.data === undefined ? undefined : fn(snap.data),
});

export const jenkinsSnapshot = (snap: Snapshot<JenkinsJobs>): Snapshot<JenkinsData> => mapSnapshot(snap, toJenkinsData);

export const lokiSnapshot = (snap: Snapshot<LogTargets>): Snapshot<LogContainer[]> =>
  mapSnapshot(snap, (t) => t.targets.map(({ host, container }) => ({ host, container })));
