import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchDbMetrics } from "../src/collectors/databases";
import { PdnsClient, fetchDns } from "../src/collectors/pdns";
import { PromClient } from "../src/collectors/prometheus";
import { ZotClient, fetchRegistry } from "../src/collectors/zot";
import { startFixtureUpstreams, type FixtureUpstreams } from "./dev/fixture-upstreams";

let up: FixtureUpstreams;

beforeAll(async () => {
  up = await startFixtureUpstreams();
});
afterAll(async () => {
  await up.stop();
});

describe("phase 4 dev fixtures", () => {
  test("the fixture Prometheus answers the database query with the shapes the collector reads", async () => {
    const m = await fetchDbMetrics(new PromClient(up.promUrl));
    expect(Object.keys(m.postgres)).toEqual(["miplata"]);
    expect(m.postgres.miplata).toMatchObject({ pgUp: true, version: "16.13.0", connections: 14, maxConnections: 100 });
    expect(m.redis.miplata).toMatchObject({ redisUp: true, version: "7.4.12", memMaxBytes: 256e6 });
  });

  test("the fake Zot and fake PowerDNS serve what the collectors send, on example.test only", async () => {
    const repos = (await fetchRegistry(new ZotClient(up.zot.url, "ci", "dev-password"))).repos;
    expect(repos.length).toBeGreaterThan(5);
    expect(repos.every((r) => r.error === null && r.tags.length > 0)).toBe(true);
    const zones = (await fetchDns(new PdnsClient(up.pdns.url, up.pdns.apiKey))).zones;
    expect(zones.map((z) => z.name)).toEqual(["web.example.test."]);
    expect(zones[0]!.rrsets.every((r) => r.name.endsWith("example.test."))).toBe(true);
    const owners = new Set(zones[0]!.rrsets.map((r) => r.owner));
    expect([...owners].sort()).toEqual(["other", "panel", "zone"]);
  });

  test("mutations are held by the fakes, not by any real host", async () => {
    expect(up.zot.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(up.pdns.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});
