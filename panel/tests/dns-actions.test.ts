import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DnsActions } from "../src/actions/dns";
import { PDNS_SOURCES, PdnsClient, PdnsError, fetchDns, registerPdnsSources } from "../src/collectors/pdns";
import { openDb } from "../src/db";
import { reviewChange } from "../src/lib/dns";
import { Store } from "../src/store";
import { startFakePdns, type FakePdns } from "./dev/pdns-fixture";

let pdns: FakePdns;
let client: PdnsClient;

beforeEach(() => {
  pdns = startFakePdns();
  client = new PdnsClient(pdns.url, pdns.apiKey, 2000);
});
afterEach(async () => {
  await pdns.stop();
});

const rig = (c: PdnsClient = client, store?: Store) => {
  const db = openDb(":memory:");
  const actions = new DnsActions({ client: c, db, store });
  const rows = () =>
    db.query<{ action: string; target: string; outcome: string; detail: string | null }, []>("SELECT action, target, outcome, detail FROM audit ORDER BY id").all();
  return { actions, rows };
};

const fields = (o: Record<string, unknown>) => ({ zone: pdns.zoneId, op: "upsert", name: "fresh", type: "A", ttl: "300", content: "192.0.2.50", ...o });

async function submit(actions: DnsActions, o: Record<string, unknown>, overwrite = false, actor = "owner") {
  const zones = (await fetchDns(client)).zones;
  const r = reviewChange(fields(o), zones);
  if (!r.ok) throw new Error(r.error);
  return actions.apply({ fields: fields(o), hash: r.value.hash, overwrite }, actor);
}

const find = (name: string, type: string) => pdns.rrsets.find((r) => r.name === `${name}.${pdns.zoneId}` && r.type === type);
const patches = () => pdns.requests.filter((r) => r.method === "PATCH");

describe("dns actions", () => {
  test("adding a record sends the panel comment, verifies by reading it back, and audits", async () => {
    const { actions, rows } = rig();
    const r = await submit(actions, {});
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    expect(r.message).toContain("added A fresh.web.example.test.");
    const made = find("fresh", "A")!;
    expect(made.records).toEqual([{ content: "192.0.2.50", disabled: false }]);
    expect(made.comments.map((c) => c.content)).toEqual(["managed-by: panel"]);
    expect(patches().length).toBe(1);
    expect(rows().map((x) => x.outcome)).toEqual(["requested", "verified"]);
    expect(rows()[0]!.action).toBe("dns.upsert");
    expect(rows()[0]!.target).toBe("A fresh@web.example.test.");
  });

  test("updating a panel record keeps its comment and its disabled flags", async () => {
    const { actions } = rig();
    const r = await submit(actions, { name: "demo", content: "198.51.100.7\n198.51.100.8", ttl: "900" });
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    const demo = find("demo", "A")!;
    expect(demo.ttl).toBe(900);
    expect(demo.records.find((x) => x.content === "198.51.100.8")!.disabled).toBe(true);
    expect(demo.comments.length).toBe(1);
    const sent = patches().at(-1)!.body as { rrsets: Record<string, unknown>[] };
    expect("comments" in sent.rrsets[0]!).toBe(false);
  });

  test("a record not created by the panel is refused without the overwrite confirmation, and no PATCH is sent", async () => {
    const { actions, rows } = rig();
    const before = structuredClone(find("miplata", "A"));
    const r = await submit(actions, { name: "miplata", content: "192.0.2.99" });
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
    expect(r.message).toContain("tick the overwrite box");
    expect(patches().length).toBe(0);
    expect(find("miplata", "A")).toEqual(before);
    expect(rows().map((x) => x.outcome)).toEqual(["rejected"]);
  });

  test("with the overwrite confirmation the record changes, stays unowned by the panel, and the audit says so", async () => {
    const { actions, rows } = rig();
    const r = await submit(actions, { name: "miplata", content: "192.0.2.99" }, true);
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    expect(r.message).toContain("Ansible restores");
    expect(find("miplata", "A")!.records[0]!.content).toBe("192.0.2.99");
    expect(find("miplata", "A")!.comments).toEqual([]);
    expect(rows()[0]!.detail).toContain("not created by the panel");
  });

  test("deleting a panel record and an Ansible record", async () => {
    const { actions } = rig();
    const a = await submit(actions, { op: "delete", name: "scratch" });
    expect(a).toMatchObject({ ok: true, outcome: "verified" });
    expect(find("scratch", "A")).toBeUndefined();
    const b = await submit(actions, { op: "delete", name: "zot" });
    expect(b).toMatchObject({ ok: false, outcome: "rejected" });
    expect(find("zot", "A")).toBeDefined();
    const c = await submit(actions, { op: "delete", name: "zot" }, true);
    expect(c).toMatchObject({ ok: true, outcome: "verified" });
    expect(c.message).toContain("Ansible recreates it");
    expect(find("zot", "A")).toBeUndefined();
  });

  test("an apply without the reviewed hash, or with a stale one, is rejected", async () => {
    const { actions } = rig();
    const none = await actions.apply({ fields: fields({}), hash: undefined, overwrite: false }, "o");
    expect(none).toMatchObject({ ok: false, outcome: "rejected" });
    expect(none.message).toContain("review the change");
    const zones = (await fetchDns(client)).zones;
    const edit = { name: "demo", content: "198.51.100.7\n198.51.100.8" };
    const reviewed = reviewChange(fields(edit), zones);
    if (!reviewed.ok) throw new Error(reviewed.error);
    find("demo", "A")!.records[1]!.disabled = false;
    const stale = await actions.apply({ fields: fields(edit), hash: reviewed.value.hash, overwrite: false }, "o");
    expect(stale).toMatchObject({ ok: false, outcome: "rejected" });
    expect(stale.message).toContain("changed since you reviewed");
    expect(patches().length).toBe(0);
  });

  describe("a record changed between review and apply is refused", () => {
    async function reviewThen(o: Record<string, unknown>, mutate: () => void, overwrite = false) {
      const { actions, rows } = rig();
      const reviewed = reviewChange(fields(o), (await fetchDns(client)).zones);
      if (!reviewed.ok) throw new Error(reviewed.error);
      mutate();
      const r = await actions.apply({ fields: fields(o), hash: reviewed.value.hash, overwrite }, "o");
      return { r, rows };
    }
    const upsert = { name: "scratch", content: "192.0.2.99" };
    const remove = { op: "delete", name: "scratch" };

    test("upsert over an existing set whose ttl changed", async () => {
      const { r } = await reviewThen(upsert, () => (find("scratch", "A")!.ttl = 600));
      expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("changed since you reviewed") });
      expect(patches().length).toBe(0);
      expect(find("scratch", "A")!.records[0]!.content).toBe("192.0.2.10");
    });

    test("upsert over an existing set whose records changed", async () => {
      const { r } = await reviewThen(upsert, () => find("scratch", "A")!.records.push({ content: "192.0.2.77", disabled: false }));
      expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("changed since you reviewed") });
      expect(patches().length).toBe(0);
    });

    test("delete of a set whose records changed", async () => {
      const { r } = await reviewThen(remove, () => find("scratch", "A")!.records.push({ content: "192.0.2.77", disabled: false }));
      expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("changed since you reviewed") });
      expect(patches().length).toBe(0);
      expect(find("scratch", "A")).toBeDefined();
    });

    test("delete of a set whose ttl changed", async () => {
      const { r } = await reviewThen(remove, () => (find("scratch", "A")!.ttl = 1));
      expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("changed since you reviewed") });
      expect(patches().length).toBe(0);
    });

    test("overwrite ticked, but the set stopped being the panel's after the review", async () => {
      const { r } = await reviewThen(upsert, () => (find("scratch", "A")!.comments = []), true);
      expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("changed since you reviewed") });
      expect(patches().length).toBe(0);
    });

    test("nothing changed in between still applies", async () => {
      const { r } = await reviewThen(upsert, () => {});
      expect(r).toMatchObject({ ok: true, outcome: "verified" });
      expect(patches().length).toBe(1);
    });
  });

  test("SOA, NS and unsupported types never reach PowerDNS", async () => {
    const { actions } = rig();
    for (const type of ["SOA", "NS", "SRV"]) {
      const r = await actions.apply({ fields: fields({ type, name: "@" }), hash: "x", overwrite: true }, "o");
      expect(r.outcome).toBe("rejected");
    }
    expect(patches().length).toBe(0);
    expect(pdns.rrsets.filter((r) => r.type === "SOA" || r.type === "NS").length).toBe(2);
  });

  test("an unknown zone is rejected without any request", async () => {
    const { actions } = rig();
    const r = await actions.apply({ fields: fields({ zone: "nope.test." }), hash: "x", overwrite: false }, "o");
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
  });

  test("identical values are a no-op", async () => {
    const { actions } = rig();
    const r = await submit(actions, { name: "scratch", content: "192.0.2.10", ttl: "300" });
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    expect(r.message).toContain("already has these values");
    expect(patches().length).toBe(0);
  });

  test("PowerDNS rejecting the change is a failed outcome with its reason", async () => {
    const stub = Object.create(client) as PdnsClient;
    stub.patch = async () => {
      throw new PdnsError(422, "pdns PATCH /zones/x: HTTP 422 (RRset a IN A: Conflicts with pre-existing RRset)");
    };
    const { actions, rows } = rig(stub);
    const zones = (await fetchDns(client)).zones;
    const reviewed = reviewChange(fields({}), zones);
    if (!reviewed.ok) throw new Error(reviewed.error);
    const r = await actions.apply({ fields: fields({}), hash: reviewed.value.hash, overwrite: false }, "o");
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.message).toContain("Conflicts with pre-existing RRset");
    expect(rows().at(-1)!.outcome).toBe("failed");
  });

  test("a change PowerDNS accepts but does not store is reported as unverified", async () => {
    pdns.ignorePatches(true);
    const { actions } = rig();
    const r = await submit(actions, {});
    expect(r).toMatchObject({ ok: false, outcome: "unverified" });
    expect(r.message).toContain("cannot be read back");
    const d = await submit(actions, { op: "delete", name: "scratch" });
    expect(d).toMatchObject({ ok: false, outcome: "unverified" });
    expect(d.message).toContain("still there");
  });

  test("a second change in the same zone while one runs is busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = Object.create(client) as PdnsClient;
    slow.patch = async (id, rrsets, signal) => {
      await gate;
      return client.patch(id, rrsets, signal);
    };
    const { actions } = rig(slow);
    const zones = (await fetchDns(client)).zones;
    const reviewed = reviewChange(fields({}), zones);
    if (!reviewed.ok) throw new Error(reviewed.error);
    const first = actions.apply({ fields: fields({}), hash: reviewed.value.hash, overwrite: false }, "o");
    await Bun.sleep(40);
    expect(actions.locked(pdns.zoneId)).toBe(true);
    const second = await actions.apply({ fields: fields({ name: "other" }), hash: "x", overwrite: false }, "o");
    expect(second.outcome).toBe("busy");
    release();
    expect((await first).outcome).toBe("verified");
    expect(actions.locked(pdns.zoneId)).toBe(false);
  });

  test("the zones snapshot is refreshed after a change", async () => {
    const store = new Store();
    registerPdnsSources(store, client, { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 1000 });
    await store.refresh(PDNS_SOURCES.zones);
    const { actions } = rig(client, store);
    await submit(actions, {});
    await Bun.sleep(50);
    const data = store.peek<{ zones: { rrsets: { name: string }[] }[] }>(PDNS_SOURCES.zones).data!;
    expect(data.zones[0]!.rrsets.some((r) => r.name.startsWith("fresh."))).toBe(true);
  });
});
