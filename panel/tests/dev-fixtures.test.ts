import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DockerClient, fetchContainers, fetchDiskUsage } from "../src/collectors/docker";
import { PromClient, fetchAgentHosts, fetchContainerMetrics, fetchHostMetrics, fetchHostSeries } from "../src/collectors/prometheus";
import { loadManifest } from "../src/manifest";
import { DEV_AGENT_DRIFTED, DEV_AGENT_IDS } from "./dev/agent-fixture";
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

  test("the agent source answers for w1 only, with one drifted setting and a pending reboot", async () => {
    const prom = new PromClient(up.promUrl);
    const agent = await fetchAgentHosts(prom);
    expect(agent.map((a) => a.host)).toEqual(["w1"]);
    const w1 = agent[0]!;
    expect(w1.settings.map((s) => s.id).sort()).toEqual([...DEV_AGENT_IDS].sort());
    expect(w1.settings.filter((s) => !s.ok).map((s) => s.id)).toEqual([DEV_AGENT_DRIFTED]);
    expect(w1.rebootRequired).toBe(true);
    expect(w1.kernelRunning).not.toBe(w1.kernelNewest);
    expect(Date.now() / 1000 - w1.runTimestampSec!).toBeLessThan(120);
    for (const k of ["swapInBps", "swapOutBps", "memPressurePct", "tcpRetransPct", "filesOpen", "tcpEstablished", "oomKills24h"] as const) {
      expect(w1[k]).not.toBeNull();
    }
    const series = (await fetchHostSeries(prom)).find((s) => s.host === "w1")!;
    for (const k of ["swapUsed", "memPressure", "tcpRetrans", "filesOpen"] as const) {
      expect(series[k]).toHaveLength(301);
      expect(Math.max(...series[k])).toBeGreaterThan(0);
    }
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
