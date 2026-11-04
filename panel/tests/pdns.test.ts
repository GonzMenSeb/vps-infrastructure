import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PANEL_COMMENT,
  PDNS_SOURCES,
  PdnsClient,
  PdnsError,
  fetchDns,
  ownerOf,
  pdnsClientFromConfig,
  registerPdnsSources,
} from "../src/collectors/pdns";
import { Store } from "../src/store";
import { startFakePdns, type FakePdns } from "./dev/pdns-fixture";

let pdns: FakePdns;
let client: PdnsClient;

beforeAll(() => {
  pdns = startFakePdns();
  client = new PdnsClient(pdns.url, pdns.apiKey, 2000);
});
afterAll(async () => {
  await pdns.stop();
});

describe("pdns collector", () => {
  test("lists the real zones with their rrsets and who owns each", async () => {
    const snap = await fetchDns(client);
    expect(snap.zones.map((z) => z.name)).toEqual(["web.example.test."]);
    const z = snap.zones[0]!;
    const by = (n: string, t: string) => z.rrsets.find((r) => r.name === n && r.type === t)!;
    expect(by("miplata.web.example.test.", "A").owner).toBe("other");
    expect(by("scratch.web.example.test.", "A").owner).toBe("panel");
    expect(by("web.example.test.", "SOA").owner).toBe("zone");
    expect(by("web.example.test.", "NS").owner).toBe("zone");
    const demo = by("demo.web.example.test.", "A");
    expect(demo.records).toEqual([
      { content: "198.51.100.7", disabled: false },
      { content: "198.51.100.8", disabled: true },
    ]);
  });

  test("ownership is the exact panel comment on a non-apex name", () => {
    expect(ownerOf("z.", "a.z.", "A", [PANEL_COMMENT])).toBe("panel");
    expect(ownerOf("z.", "a.z.", "A", [` ${PANEL_COMMENT} `])).toBe("panel");
    expect(ownerOf("z.", "a.z.", "A", ["managed-by: ansible"])).toBe("other");
    expect(ownerOf("z.", "a.z.", "A", [])).toBe("other");
    expect(ownerOf("z.", "z.", "NS", [PANEL_COMMENT])).toBe("zone");
    expect(ownerOf("z.", "z.", "SOA", [])).toBe("zone");
    expect(ownerOf("z.", "z.", "MX", [])).toBe("other");
  });

  test("reads the server counters it needs and ignores the rest", async () => {
    const s = await client.statistics();
    expect(s.backendLatencyUs).toBe(547);
    expect(s.backendQueries).toBeGreaterThan(3000);
    expect(s.uptimeSec).toBeGreaterThan(43_000);
    expect(s.servfailPackets).toBe(0);
    expect(s.queueSize).toBe(0);
    expect(pdns.requests.at(-1)!.path).toBe("/api/v1/servers/localhost/statistics?includerings=false");
  });

  test("a wrong key is a PdnsError with the status, and PATCH errors carry PowerDNS's reason", async () => {
    const bad = new PdnsClient(pdns.url, "wrong", 2000);
    const e1 = await bad.zones().catch((e) => e);
    expect(e1).toBeInstanceOf(PdnsError);
    expect((e1 as PdnsError).status).toBe(401);
    const e2 = await client
      .patch(pdns.zoneId, [{ name: "x.elsewhere.test.", type: "A", changetype: "REPLACE", ttl: 60, records: [{ content: "192.0.2.1", disabled: false }] }])
      .catch((e) => e);
    expect((e2 as PdnsError).status).toBe(422);
    expect((e2 as PdnsError).message).toContain("Name is out of zone");
  });

  test("zone ids are validated before they reach a path", async () => {
    await expect(client.zone("../etc")).rejects.toThrow("invalid zone id");
    await expect(client.patch("a b", [])).rejects.toThrow("invalid zone id");
  });

  test("sources go stale with the error when PowerDNS stops answering", async () => {
    const store = new Store();
    registerPdnsSources(store, client, { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 15_000 });
    await store.refresh(PDNS_SOURCES.zones);
    await store.refresh(PDNS_SOURCES.stats);
    pdns.setDown(true);
    try {
      await store.refresh(PDNS_SOURCES.zones);
      const snap = store.peek(PDNS_SOURCES.zones);
      expect(snap.data).toBeDefined();
      expect(snap.lastError).toContain("503");
    } finally {
      pdns.setDown(false);
    }
  });

  test("the client needs both URL and key", () => {
    expect(pdnsClientFromConfig({ PDNS_API_URL: "http://pdns:8081", PDNS_API_KEY: undefined })).toBeNull();
    expect(pdnsClientFromConfig({ PDNS_API_URL: undefined, PDNS_API_KEY: "k" })).toBeNull();
    expect(pdnsClientFromConfig({ PDNS_API_URL: "http://pdns:8081", PDNS_API_KEY: "k" })?.host).toBe("pdns:8081");
  });
});
