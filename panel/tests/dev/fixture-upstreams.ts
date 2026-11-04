import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUERIES, seriesQuery } from "../../src/collectors/prometheus";
import { loadManifest } from "../../src/manifest";
import { start } from "../../src/server";
import hostsFixture from "../fixtures/prometheus-hosts.json";
import containersFixture from "../fixtures/prometheus-containers.json";
import seriesFixture from "../fixtures/prometheus-series.json";
import { dockerContainers, dockerDf } from "./docker-fixture";
import { startFakeJenkins, type FakeJenkins } from "./jenkins-fixture";
import { startFakeLoki, type FakeLoki } from "./loki-fixture";
import { makeFakeOpt, type FakeOpt } from "./opt-fixture";

type Matrix = { status: string; data: { resultType: string; result: { metric: Record<string, string>; values: [number, string][] }[] } };

const promError = (error: string, status = 400) =>
  Response.json({ status: "error", errorType: "bad_data", error }, { status });

function rebasedSeries(startSec: number, stepSec: number): Matrix {
  const { params, body } = seriesFixture as unknown as { params: { start: number; step: number }; body: Matrix };
  return {
    ...body,
    data: {
      ...body.data,
      result: body.data.result.map((r) => ({
        metric: r.metric,
        values: r.values.map(([t, v]) => [startSec + Math.round((t - params.start) / params.step) * stepSec, v] as [number, string]),
      })),
    },
  };
}

const DEV_MANIFEST = "tests/fixtures/dev-services.json";

export interface FixtureUpstreams {
  promUrl: string;
  dockerSocket: string;
  jenkins: FakeJenkins;
  loki: FakeLoki;
  opt: FakeOpt;
  stop: () => Promise<void>;
}

export async function startFixtureUpstreams(): Promise<FixtureUpstreams> {
  const dir = mkdtempSync(join(tmpdir(), "vesp-"));
  const dockerSocket = join(dir, "docker.sock");
  const prom = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST") return promError("fixture serves POST only", 405);
      const form = new URLSearchParams(await req.text());
      const query = form.get("query") ?? "";
      if (path === "/api/v1/query") {
        if (query === QUERIES.hosts) return Response.json(hostsFixture);
        if (query === QUERIES.containers) return Response.json(containersFixture);
        return promError("fixture has no answer for this instant query");
      }
      if (path === "/api/v1/query_range") {
        const startSec = Number(form.get("start"));
        const stepSec = Number.parseInt(form.get("step") ?? "", 10);
        if (!Number.isFinite(startSec) || !stepSec || query !== seriesQuery(stepSec)) return promError("fixture has no answer for this range query");
        return Response.json(rebasedSeries(startSec, stepSec));
      }
      return promError(`unknown path ${path}`, 404);
    },
  });
  const docker = Bun.serve({
    unix: dockerSocket,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/containers/json") return Response.json(dockerContainers());
      if (u.pathname === "/system/df") return Response.json(dockerDf());
      return Response.json({ message: "page not found" }, { status: 404 });
    },
  });
  const manifest = await loadManifest(DEV_MANIFEST);
  const opt = makeFakeOpt(manifest);
  const jenkins = startFakeJenkins({
    secrets: {
      job: "panel-secrets",
      applyJob: "vps-deploy",
      secretRunMs: Number(process.env.FAKE_SECRET_RUN_MS ?? 4000),
      deployRunMs: Number(process.env.FAKE_DEPLOY_RUN_MS ?? 8000),
      onApply: (name, value) => opt.applyVar(name, value),
    },
  });
  const loki = startFakeLoki();
  return {
    promUrl: `http://127.0.0.1:${prom.port}`,
    dockerSocket,
    jenkins,
    loki,
    opt,
    stop: async () => {
      opt.stop();
      await jenkins.stop();
      await loki.stop();
      await prom.stop(true);
      await docker.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const up = await startFixtureUpstreams();
  const port = process.env.PORT ?? "3000";
  const dataDir = mkdtempSync(join(tmpdir(), "vesp-data-"));
  const app = await start({
    NODE_ENV: "development",
    DEV_AUTH_BYPASS: "1",
    PUBLIC_URL: `http://localhost:${port}`,
    PORT: port,
    DATA_DIR: dataDir,
    SERVICES_MANIFEST_PATH: DEV_MANIFEST,
    ENV_FILES_ROOT: up.opt.root,
    GITHUB_CLIENT_ID: "dev",
    GITHUB_CLIENT_SECRET: "dev",
    GITHUB_ALLOWED_LOGIN: "owner",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    PROMETHEUS_URL: up.promUrl,
    DOCKER_SOCKET: up.dockerSocket,
    JENKINS_URL: up.jenkins.url,
    JENKINS_USER: "admin",
    JENKINS_TOKEN: "dev-token",
    LOKI_URL: up.loki.url,
    TIME_ZONE: process.env.TIME_ZONE ?? "UTC",
  });
  console.log(`fixture panel on http://localhost:${port}/auth/dev (prometheus ${up.promUrl}, docker ${up.dockerSocket}, jenkins ${up.jenkins.url}, loki ${up.loki.url})`);
  const shutdown = async () => {
    await app.stop();
    await up.stop();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
