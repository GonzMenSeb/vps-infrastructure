import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_QUERY } from "../../src/collectors/databases";
import { QUERIES, seriesQuery } from "../../src/collectors/prometheus";
import { start } from "../../src/server";
import hostsFixture from "../fixtures/prometheus-hosts.json";
import containersFixture from "../fixtures/prometheus-containers.json";
import databasesFixture from "../fixtures/prometheus-databases.json";
import seriesFixture from "../fixtures/prometheus-series.json";
import { dockerContainers, dockerDf } from "./docker-fixture";
import { startFakeJenkins, type FakeJenkins } from "./jenkins-fixture";
import { startFakeLoki, type FakeLoki } from "./loki-fixture";
import { startFakePdns, type FakePdns } from "./pdns-fixture";
import { startFakeZot, type FakeZot } from "./zot-fixture";

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

export interface FixtureUpstreams {
  promUrl: string;
  dockerSocket: string;
  jenkins: FakeJenkins;
  loki: FakeLoki;
  zot: FakeZot;
  pdns: FakePdns;
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
        if (query === DB_QUERY) return Response.json(databasesFixture);
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
  const jenkins = startFakeJenkins();
  const loki = startFakeLoki();
  const zot = startFakeZot();
  const pdns = startFakePdns();
  return {
    promUrl: `http://127.0.0.1:${prom.port}`,
    dockerSocket,
    jenkins,
    loki,
    zot,
    pdns,
    stop: async () => {
      await jenkins.stop();
      await loki.stop();
      await zot.stop();
      await pdns.stop();
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
    SERVICES_MANIFEST_PATH: "tests/fixtures/dev-services.json",
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
    ZOT_URL: up.zot.url,
    ZOT_USER: "ci",
    ZOT_PASSWORD: "dev-password",
    PDNS_API_URL: up.pdns.url,
    PDNS_API_KEY: up.pdns.apiKey,
    TIME_ZONE: process.env.TIME_ZONE ?? "UTC",
  });
  console.log(`fixture panel on http://localhost:${port}/auth/dev (prometheus ${up.promUrl}, docker ${up.dockerSocket}, jenkins ${up.jenkins.url}, loki ${up.loki.url}, zot ${up.zot.url}, pdns ${up.pdns.url})`);
  const shutdown = async () => {
    await app.stop();
    await up.stop();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
