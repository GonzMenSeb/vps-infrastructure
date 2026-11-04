import { describe, expect, test } from "bun:test";
import type { DnsRecordSet, DnsZone } from "../src/collectors/pdns";
import { normalizeContents, parseChange, relativeName, reviewChange, toFqdn } from "../src/lib/dns";

const ZONE = "web.example.test.";

const rr = (name: string, type: string, owner: DnsRecordSet["owner"], records: [string, boolean?][], ttl = 300): DnsRecordSet => ({
  name,
  type,
  ttl,
  owner,
  records: records.map(([content, disabled]) => ({ content, disabled: disabled === true })),
});

const zone = (): DnsZone => ({
  id: ZONE,
  name: ZONE,
  kind: "Native",
  rrsets: [
    rr(`miplata.${ZONE}`, "A", "other", [["192.0.2.10"]], 3600),
    rr(`scratch.${ZONE}`, "A", "panel", [["192.0.2.11"]]),
    rr(`demo.${ZONE}`, "A", "panel", [["198.51.100.7"], ["198.51.100.8", true]]),
    rr(`alias.${ZONE}`, "CNAME", "panel", [["target.example.test."]]),
    rr(ZONE, "SOA", "zone", [["ns1.example.test. hostmaster.example.test. 0 10800 3600 604800 3600"]], 3600),
    rr(ZONE, "NS", "zone", [["ns1.example.test."]], 3600),
  ],
});

const change = (o: Record<string, unknown>) => ({ zone: ZONE, op: "upsert", name: "app", type: "A", ttl: "300", content: "192.0.2.50", ...o });

describe("dns names", () => {
  test("names are relative to the zone, @ is the apex, and results are lower-case FQDNs", () => {
    expect(toFqdn("@", ZONE)).toEqual({ ok: true, value: ZONE });
    expect(toFqdn("App", ZONE)).toEqual({ ok: true, value: `app.${ZONE}` });
    expect(toFqdn("a.b", ZONE)).toEqual({ ok: true, value: `a.b.${ZONE}` });
    expect(toFqdn(`x.${ZONE}`, ZONE)).toEqual({ ok: true, value: `x.${ZONE}` });
    expect(toFqdn("*.wild", ZONE)).toEqual({ ok: true, value: `*.wild.${ZONE}` });
    expect(toFqdn("_acme-challenge.test", ZONE)).toMatchObject({ ok: true });
  });

  test("names that repeat the zone, leave it, or contain bad labels are refused", () => {
    expect(toFqdn("app.web.example.test", ZONE)).toMatchObject({ ok: false });
    expect(toFqdn("app.other.org.", ZONE)).toMatchObject({ ok: false, error: expect.stringContaining("outside the zone") });
    expect(toFqdn("-bad", ZONE)).toMatchObject({ ok: false });
    expect(toFqdn("bad name", ZONE)).toMatchObject({ ok: false });
    expect(toFqdn("a..b", ZONE)).toMatchObject({ ok: false });
    expect(toFqdn(`${"a".repeat(64)}`, ZONE)).toMatchObject({ ok: false });
    expect(toFqdn(`${Array(60).fill("abcd").join(".")}`, ZONE)).toMatchObject({ ok: false, error: "the name is too long" });
    expect(toFqdn("x.*.y", ZONE)).toMatchObject({ ok: false });
  });

  test("relativeName inverts the normalisation", () => {
    expect(relativeName(ZONE, ZONE)).toBe("@");
    expect(relativeName(`a.b.${ZONE}`, ZONE)).toBe("a.b");
  });
});

describe("dns contents", () => {
  test("A and AAAA accept only addresses and drop duplicates", () => {
    expect(normalizeContents("A", "192.0.2.1\n192.0.2.1\r\n\n192.0.2.2", false)).toEqual({ ok: true, value: ["192.0.2.1", "192.0.2.2"] });
    expect(normalizeContents("A", "999.0.0.1", false)).toMatchObject({ ok: false });
    expect(normalizeContents("A", "01.2.3.4", false)).toMatchObject({ ok: false });
    expect(normalizeContents("AAAA", "2001:DB8::1", false)).toEqual({ ok: true, value: ["2001:db8::1"] });
    expect(normalizeContents("AAAA", "fe80::1%eth0", false)).toMatchObject({ ok: false });
    expect(normalizeContents("A", "", false)).toMatchObject({ ok: false, error: "the content is required" });
  });

  test("CNAME and MX targets get their trailing dot, and CNAME is single and never at the apex", () => {
    expect(normalizeContents("CNAME", "Target.Example.Test", false)).toEqual({ ok: true, value: ["target.example.test."] });
    expect(normalizeContents("CNAME", "a.example.test.\nb.example.test.", false)).toMatchObject({ ok: false });
    expect(normalizeContents("CNAME", "a.example.test.", true)).toMatchObject({ ok: false, error: expect.stringContaining("apex") });
    expect(normalizeContents("MX", "10 mail.example.test\n20 mail2.example.test.", false)).toEqual({
      ok: true,
      value: ["10 mail.example.test.", "20 mail2.example.test."],
    });
    expect(normalizeContents("MX", "70000 mail.example.test.", false)).toMatchObject({ ok: false });
    expect(normalizeContents("MX", "mail.example.test.", false)).toMatchObject({ ok: false });
    expect(normalizeContents("CNAME", "bad_host!.example.test", false)).toMatchObject({ ok: false });
  });

  test("TXT is quoted and escaped when plain, validated when already quoted, and split at 255", () => {
    expect(normalizeContents("TXT", 'v=spf1 "x" \\ -all', false)).toEqual({ ok: true, value: ['"v=spf1 \\"x\\" \\\\ -all"'] });
    expect(normalizeContents("TXT", '"already quoted"', false)).toEqual({ ok: true, value: ['"already quoted"'] });
    expect(normalizeContents("TXT", '"one" "two"', false)).toMatchObject({ ok: true });
    expect(normalizeContents("TXT", '"unterminated', false)).toMatchObject({ ok: false });
    const long = normalizeContents("TXT", "a".repeat(300), false);
    expect(long).toEqual({ ok: true, value: [`"${"a".repeat(255)}" "${"a".repeat(45)}"`] });
    expect(normalizeContents("TXT", `"${"a".repeat(256)}"`, false)).toMatchObject({ ok: false });
    expect(normalizeContents("TXT", "café", false)).toMatchObject({ ok: false });
  });

  test("more than twenty records for one name and type are refused", () => {
    const many = Array.from({ length: 21 }, (_, i) => `192.0.2.${i + 1}`).join("\n");
    expect(normalizeContents("A", many, false)).toMatchObject({ ok: false });
  });
});

describe("dns change parsing", () => {
  test("SOA and NS are never editable, other unsupported types are named", () => {
    expect(parseChange(change({ type: "SOA", name: "@" }), [zone()])).toMatchObject({ ok: false, error: expect.stringContaining("never edits them") });
    expect(parseChange(change({ type: "ns", name: "@" }), [zone()])).toMatchObject({ ok: false, error: expect.stringContaining("never edits them") });
    expect(parseChange(change({ type: "NS", name: "sub" }), [zone()])).toMatchObject({ ok: false });
    expect(parseChange(change({ type: "SRV" }), [zone()])).toMatchObject({ ok: false, error: expect.stringContaining("not editable here") });
  });

  test("TTL must be a whole number in range and is not needed for deletes", () => {
    for (const ttl of ["0", "-5", "abc", "1.5", "", "2147483648"]) {
      expect(parseChange(change({ ttl }), [zone()])).toMatchObject({ ok: false });
    }
    expect(parseChange(change({ ttl: "1" }), [zone()])).toMatchObject({ ok: true });
    expect(parseChange(change({ ttl: "2147483647" }), [zone()])).toMatchObject({ ok: true });
    expect(parseChange(change({ op: "delete", ttl: undefined, content: undefined, name: "scratch" }), [zone()])).toMatchObject({ ok: true });
  });

  test("unknown zones, operations and missing fields are refused", () => {
    expect(parseChange(change({ zone: "other.test." }), [zone()])).toMatchObject({ ok: false, error: "unknown zone" });
    expect(parseChange(change({ zone: "bad zone" }), [zone()])).toMatchObject({ ok: false });
    expect(parseChange(change({ op: "drop" }), [zone()])).toMatchObject({ ok: false, error: "unknown operation" });
    expect(parseChange(change({ name: "" }), [zone()])).toMatchObject({ ok: false });
    expect(parseChange({}, [zone()])).toMatchObject({ ok: false });
  });
});

describe("dns review", () => {
  test("a new record carries the panel comment and no overwrite flag", () => {
    const r = reviewChange(change({ name: "fresh" }), [zone()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.existing).toBeNull();
    expect(r.value.needsOverwrite).toBe(false);
    expect(r.value.patch).toEqual({
      name: `fresh.${ZONE}`,
      type: "A",
      ttl: 300,
      changetype: "REPLACE",
      records: [{ content: "192.0.2.50", disabled: false }],
      comments: [{ content: "managed-by: panel", account: "panel" }],
    });
    expect(r.value.request).toContain(`PATCH /api/v1/servers/localhost/zones/${ZONE}`);
    expect(r.value.request).toContain('"changetype": "REPLACE"');
  });

  test("updating a panel record leaves its comments out and keeps disabled flags for unchanged content", () => {
    const r = reviewChange(change({ name: "demo", content: "198.51.100.7\n198.51.100.8\n198.51.100.9", ttl: "600" }), [zone()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.needsOverwrite).toBe(false);
    expect("comments" in r.value.patch).toBe(false);
    expect(r.value.patch.records).toEqual([
      { content: "198.51.100.7", disabled: false },
      { content: "198.51.100.8", disabled: true },
      { content: "198.51.100.9", disabled: false },
    ]);
  });

  test("a record the panel did not create needs the overwrite confirmation, for edits and deletes", () => {
    const edit = reviewChange(change({ name: "miplata", content: "192.0.2.99" }), [zone()]);
    expect(edit).toMatchObject({ ok: true, value: { needsOverwrite: true } });
    const del = reviewChange({ zone: ZONE, op: "delete", name: "miplata", type: "A" }, [zone()]);
    expect(del).toMatchObject({ ok: true, value: { needsOverwrite: true, patch: { changetype: "DELETE" } } });
  });

  test("deleting what does not exist is an error, and an identical record is flagged as unchanged", () => {
    expect(reviewChange({ zone: ZONE, op: "delete", name: "ghost", type: "A" }, [zone()])).toMatchObject({ ok: false });
    expect(reviewChange(change({ name: "scratch", content: "192.0.2.11", ttl: "300" }), [zone()])).toMatchObject({ ok: true, value: { unchanged: true } });
    expect(reviewChange(change({ name: "scratch", content: "192.0.2.11", ttl: "301" }), [zone()])).toMatchObject({ ok: true, value: { unchanged: false } });
  });

  test("a CNAME cannot be added beside other records and other records cannot join a CNAME", () => {
    expect(reviewChange(change({ name: "miplata", type: "CNAME", content: "x.example.test." }), [zone()])).toMatchObject({ ok: false, error: expect.stringContaining("beside other records") });
    expect(reviewChange(change({ name: "alias", type: "A", content: "192.0.2.5" }), [zone()])).toMatchObject({ ok: false, error: expect.stringContaining("is a CNAME") });
  });

  test("the hash follows the exact request", () => {
    const a = reviewChange(change({}), [zone()]);
    const b = reviewChange(change({}), [zone()]);
    const c = reviewChange(change({ content: "192.0.2.51" }), [zone()]);
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected valid reviews");
    expect(a.value.hash).toBe(b.value.hash);
    expect(a.value.hash).not.toBe(c.value.hash);
  });

  describe("the hash also follows the record set that is there now", () => {
    const hashFor = (o: Record<string, unknown>, mutate: (z: DnsZone) => void = () => {}) => {
      const z = zone();
      mutate(z);
      const r = reviewChange(o, [z]);
      if (!r.ok) throw new Error(r.error);
      return r.value.hash;
    };
    const set = (z: DnsZone, name: string) => z.rrsets.find((r) => r.name === `${name}.${ZONE}` && r.type === "A")!;
    const upsert = change({ name: "scratch", content: "192.0.2.99" });
    const remove = { zone: ZONE, op: "delete", name: "demo", type: "A" };

    test("an upsert over an existing set changes when only the existing ttl changes", () => {
      expect(hashFor(upsert, (z) => (set(z, "scratch").ttl = 600))).not.toBe(hashFor(upsert));
    });

    test("an upsert over an existing set changes when the existing records change", () => {
      expect(hashFor(upsert, (z) => set(z, "scratch").records.push({ content: "192.0.2.77", disabled: false }))).not.toBe(hashFor(upsert));
    });

    test("an upsert changes when the owner of the existing set flips", () => {
      expect(hashFor(upsert, (z) => (set(z, "scratch").owner = "other"))).not.toBe(hashFor(upsert));
    });

    test("a delete changes when the existing ttl, records, disabled flags or owner change", () => {
      const base = hashFor(remove);
      expect(hashFor(remove, (z) => (set(z, "demo").ttl = 60))).not.toBe(base);
      expect(hashFor(remove, (z) => set(z, "demo").records.push({ content: "198.51.100.9", disabled: false }))).not.toBe(base);
      expect(hashFor(remove, (z) => (set(z, "demo").records[1]!.disabled = false))).not.toBe(base);
      expect(hashFor(remove, (z) => (set(z, "demo").owner = "other"))).not.toBe(base);
    });

    test("the order PowerDNS lists the records in does not matter", () => {
      expect(hashFor(remove, (z) => set(z, "demo").records.reverse())).toBe(hashFor(remove));
      const two = change({ name: "demo", content: "198.51.100.7\n198.51.100.8" });
      expect(hashFor(two, (z) => set(z, "demo").records.reverse())).toBe(hashFor(two));
    });

    test("a new name hashes the same whatever else is in the zone", () => {
      const add = change({ name: "fresh" });
      expect(hashFor(add, (z) => (set(z, "scratch").ttl = 1))).toBe(hashFor(add));
    });
  });
});
