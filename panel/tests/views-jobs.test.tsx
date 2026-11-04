import { describe, expect, test } from "bun:test";
import {
  buildJobs,
  buildService,
  fmtDuration,
  fmtSince,
  resultChip,
  type JenkinsBuildData,
  type JenkinsData,
  type JenkinsView,
} from "../src/views/model";
import { JobsFrame, JobsPage } from "../src/views/jobs";
import { ServiceFrame } from "../src/views/service";
import { chrome, input, render, snap, styleAttrs } from "./views-fixtures";

const NOW = 1_800_000_000_000;
const BASE = "https://jenkins.web.example.test";

const b = (o: Partial<JenkinsBuildData> & { job: string; number: number }): JenkinsBuildData => ({
  result: "SUCCESS",
  building: false,
  timestamp: NOW - 3600_000,
  duration: 200_000,
  estimatedDuration: 180_000,
  cause: "Started by user owner",
  ...o,
});

const data = (o: Partial<JenkinsData> = {}): JenkinsData => ({
  jobs: ["vps-deploy", "miplata-deploy", "judicabot-deploy", "categorizer-deploy"],
  executors: { busy: 1, total: 2 },
  queue: [{ id: 9, job: "categorizer-deploy", why: "Waiting for next available executor", since: NOW - 75_000 }],
  builds: [
    b({ job: "vps-deploy", number: 38, timestamp: NOW - 3 * 86400_000, duration: 422_000 }),
    b({ job: "vps-deploy", number: 37, result: "FAILURE", timestamp: NOW - 4 * 86400_000, cause: "Started by GitHub push" }),
    b({ job: "miplata-deploy", number: 5, result: null, building: true, timestamp: NOW - 40_000, estimatedDuration: 100_000, duration: 0 }),
    b({ job: "judicabot-deploy", number: 7, result: "ABORTED", timestamp: NOW - 86400_000 }),
    b({ job: "judicabot-deploy", number: 6, result: "UNSTABLE", timestamp: NOW - 2 * 86400_000 }),
    b({ job: "categorizer-deploy", number: 3, result: "NOT_BUILT", timestamp: NOW - 5 * 86400_000 }),
  ],
  ...o,
});

const view = (d: JenkinsData | undefined = data(), o: Partial<JenkinsView> = {}): JenkinsView => ({
  snapshot: snap(d),
  baseUrl: BASE,
  actions: true,
  ttlMs: 5000,
  now: NOW,
  ...o,
});

const withJenkins = (v: JenkinsView | undefined, csrf = "tok-123") => ({ ...input(), csrf, jenkins: v });
const jobsPage = (v: JenkinsView | undefined, q = {}) => render(<JobsPage chrome={chrome} vm={buildJobs(withJenkins(v), q)} />);

describe("jobs model helpers", () => {
  test("formats durations and ages", () => {
    expect(fmtDuration(200_000)).toBe("3m 20s");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(3_720_000)).toBe("1h 02m");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtSince(2000)).toBe("just now");
    expect(fmtSince(3 * 86400_000)).toBe("3 d ago");
  });

  test("maps Jenkins results to chips, unknown values stay neutral", () => {
    expect(resultChip({ result: "SUCCESS", building: false })).toMatchObject({ label: "Passed", tone: "ok" });
    expect(resultChip({ result: "FAILURE", building: false })).toMatchObject({ label: "Failed", tone: "bad" });
    expect(resultChip({ result: "UNSTABLE", building: false })).toMatchObject({ tone: "warn" });
    expect(resultChip({ result: "ABORTED", building: false })).toMatchObject({ label: "Stopped", tone: "" });
    expect(resultChip({ result: "NOT_BUILT", building: false })).toMatchObject({ label: "Not built", tone: "" });
    expect(resultChip({ result: "WEIRD", building: false })).toMatchObject({ label: "Unknown", tone: "", title: "Jenkins result: WEIRD" });
    expect(resultChip({ result: null, building: true })).toMatchObject({ label: "Running", tone: "info" });
  });
});

describe("jobs view", () => {
  test("shows running with progress and stop, queue, history and per-job run", async () => {
    const html = await jobsPage(view());
    expect(html).toContain('<turbo-frame id="live" refresh="morph" target="_top">');
    expect(html).toContain("1 of 2 executors busy");
    expect(html).toContain('width="40%"');
    expect(html).toContain("categorizer-deploy");
    expect(html).toContain("Waiting for next available executor");
    expect(html).toContain("1m 15s");
    expect(html).toContain("Passed");
    expect(html).toContain("Failed");
    expect(html).toContain("Unstable");
    expect(html).toContain(">Stopped<");
    expect(html).toContain("Not built");
    expect(html).toContain('href="/jobs?job=vps-deploy&amp;build=38"');
    expect(html).toContain(`href="${BASE}/job/vps-deploy/38/"`);
    expect(styleAttrs(html)).toEqual([]);
  });

  test("stop and run forms carry csrf and the exact request", async () => {
    const html = await jobsPage(view());
    expect(html).toContain('action="/jobs/miplata-deploy/5/stop"');
    expect(html).toContain('data-confirm-request-value="POST /job/miplata-deploy/5/stop\nHost: jenkins.web.example.test"');
    expect(html).toContain('action="/jobs/vps-deploy/build"');
    expect(html).toContain('data-confirm-request-value="POST /job/vps-deploy/build\nHost: jenkins.web.example.test"');
    expect(html).toContain('<input type="hidden" name="_csrf" value="tok-123"/>');
    expect(html).toContain('data-confirm-danger-value="true"');
    expect(html).toContain("A run is already in progress.");
    expect((html.match(/action="\/jobs\/[^"]+\/build"/g) ?? []).length).toBe(4);
  });

  test("without credentials there are no mutation forms", async () => {
    const html = await jobsPage(view(data(), { actions: false }));
    expect(html).not.toContain("data-controller=\"confirm\"");
    expect(html).toContain("Jenkins credentials are not configured");
  });

  test("progress has no bar without an estimate and never reaches 100", () => {
    const noEst = data({ builds: [b({ job: "vps-deploy", number: 1, building: true, result: null, estimatedDuration: 0 })] });
    expect(buildJobs(withJenkins(view(noEst))).running[0]!.progressPct).toBeNull();
    const over = data({ builds: [b({ job: "vps-deploy", number: 1, building: true, result: null, timestamp: NOW - 900_000, estimatedDuration: 100_000 })] });
    expect(buildJobs(withJenkins(view(over))).running[0]!.progressPct).toBe(99);
  });

  test("lists manifest jobs that Jenkins does not have", async () => {
    const html = await jobsPage(view(data({ jobs: ["vps-deploy"] })));
    expect(html).toContain("Jenkins does not have yet");
    expect(html).toContain("judicabot-deploy, miplata-deploy");
  });

  test("console panel is wired to the proxied source and validates the build", async () => {
    const html = await jobsPage(view(), { job: "miplata-deploy", build: "5" });
    expect(html).toContain('data-controller="console"');
    expect(html).toContain('data-console-src-value="/jobs/miplata-deploy/5/console"');
    expect(html).toContain('data-console-running-value="true"');
    expect(html).toContain("Stop following");
    expect(buildJobs(withJenkins(view()), { job: "nope", build: "1" }).console).toBeNull();
    expect(buildJobs(withJenkins(view()), { job: "nope", build: "1" }).consoleNote).toContain("no job called nope");
    expect(buildJobs(withJenkins(view()), { job: "vps-deploy", build: "../x" }).console).toBeNull();
    expect(buildJobs(withJenkins(view()), { job: "vps-deploy", build: "0" }).console).toBeNull();
    const done = buildJobs(withJenkins(view()), { job: "vps-deploy", build: "38" }).console!;
    expect(done.running).toBe(false);
    expect(done.result?.label).toBe("Passed");
  });

  test("source states: off, loading, error, stale", async () => {
    expect(await jobsPage(undefined)).toContain("Jenkins is not configured, so Jenkins runs cannot be shown.");
    const loading = await render(<JobsFrame vm={buildJobs(withJenkins(view(undefined, { snapshot: snap<JenkinsData>(undefined) })))} />);
    expect(loading).toContain("Waiting for the first answer from Jenkins.");
    const err = await render(
      <JobsFrame vm={buildJobs(withJenkins(view(undefined, { snapshot: snap<JenkinsData>(undefined, { lastError: "jenkins /queue: HTTP 503", breaker: "open" }) })))} />,
    );
    expect(err).toContain("Jenkins is not answering");
    expect(err).toContain("jenkins /queue: HTTP 503");
    const stale = await jobsPage(view(data(), { snapshot: snap(data(), { lastError: "timeout", ageMs: 90_000 }) }));
    expect(stale).toContain("Stale");
    expect(stale).toContain("miplata-deploy");
  });

  test("empty queue and nothing running", async () => {
    const html = await jobsPage(view(data({ queue: [], builds: [] })));
    expect(html).toContain("Nothing is running.");
    expect(html).toContain("The queue is empty.");
    expect(html).toContain("Jenkins reports no finished runs.");
  });

  test("service builds tab replaces the placeholder", async () => {
    const vm = buildService(withJenkins(view()), "judicabot", "builds")!;
    const html = await render(<ServiceFrame vm={vm} />);
    expect(html).not.toContain("Phase 3");
    expect(html).toContain('href="/jobs?job=judicabot-deploy&amp;build=7"');
    expect(html).toContain(">Stopped<");
    expect(html).toContain('action="/jobs/judicabot-deploy/build"');
    expect(html).toContain('href="/jobs?job=judicabot-deploy"');
    expect(html).toContain('href="/logs?host=vps&amp;container=judicabot"');
    expect(html).toContain("View logs");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("service builds tab edge states", async () => {
    const none = await render(<ServiceFrame vm={buildService(withJenkins(view()), "jenkins", "builds")!} />);
    expect(none).toContain("The manifest lists no Jenkins job for this service.");
    const missing = await render(<ServiceFrame vm={buildService(withJenkins(view(data({ jobs: ["vps-deploy"] }))), "judicabot", "builds")!} />);
    expect(missing).toContain("Jenkins has no job called judicabot-deploy yet.");
    const fresh = await render(<ServiceFrame vm={buildService(withJenkins(view(data({ builds: [] }))), "judicabot", "builds")!} />);
    expect(fresh).toContain("judicabot-deploy has not run yet.");
  });

  test("builds are not computed for other tabs", () => {
    expect(buildService(withJenkins(view()), "judicabot")!.builds).toBeNull();
  });
});
