import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DockerClient, fetchContainers, fetchDiskUsage } from "../src/collectors/docker";
import { PromClient, fetchContainerMetrics, fetchHostMetrics, fetchHostSeries } from "../src/collectors/prometheus";
import { loadManifest } from "../src/manifest";
import { startFixtureUpstreams, type FixtureUpstreams } from "./dev/fixture-upstreams";

let up: FixtureUpstreams;

beforeAll(async () => {
  up = await startFixtureUpstreams();
});

afterAll(async () => {
  await up.stop();
});

describe("dev fixture upstreams", () => {
  test("serve every query the collectors send", async () => {
    const prom = new PromClient(up.promUrl);
    expect((await fetchHostMetrics(prom)).map((h) => h.host)).toEqual(["jenkins", "vps"]);
    expect((await fetchContainerMetrics(prom)).length).toBeGreaterThan(20);
    const series = await fetchHostSeries(prom);
    expect(series.every((s) => s.dataStartSec !== null && s.cpu.length === 301)).toBe(true);
    const docker = new DockerClient(up.dockerSocket);
    const containers = await fetchContainers(docker);
    expect(containers.find((c) => c.name === "llama-server")?.state).toBe("restarting");
    expect((await fetchDiskUsage(docker)).volumes.length).toBeGreaterThan(0);
  });

  test("docker names match the vps names in the prometheus fixture, plus the crash-looping llama-server", async () => {
    const prom = new PromClient(up.promUrl);
    const vps = (await fetchContainerMetrics(prom)).filter((m) => m.host === "vps").map((m) => m.name);
    const docker = (await fetchContainers(new DockerClient(up.dockerSocket))).map((c) => c.name);
    expect(docker.sort()).toEqual([...vps, "llama-server"].sort());
  });

  test("the dev manifest parses and uses only the example.test domain", async () => {
    const text = await Bun.file("tests/fixtures/dev-services.json").text();
    await loadManifest("tests/fixtures/dev-services.json");
    const hosts = [...text.matchAll(/"hostname": "([^"]+)"/g)].map((m) => m[1]!);
    expect(hosts.length).toBeGreaterThan(5);
    expect(hosts.every((h) => h.endsWith(".example.test"))).toBe(true);
  });
});
