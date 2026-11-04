import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DnsActions } from "../src/actions/dns";
import { PdnsClient, ZONE_ID } from "../src/collectors/pdns";
import { AUDIT_DETAIL_MAX, AUDIT_TARGET_MAX, audit, openDb } from "../src/db";
import { startFakePdns, type FakePdns } from "./dev/pdns-fixture";

describe("ZONE_ID", () => {
  test("refuses names made only of dots, which would climb out of the zones path", () => {
    for (const bad of [".", "..", "...", "......"]) expect(ZONE_ID.test(bad)).toBe(false);
  });

  test("still accepts real zone ids", () => {
    for (const ok of ["web.example.test.", "example.org", "1.0.0.10.in-addr.arpa.", "a..b", ".a", "a.", "_x=y-z"]) expect(ZONE_ID.test(ok)).toBe(true);
  });

  describe("against PowerDNS", () => {
    let pdns: FakePdns;
    beforeEach(() => {
      pdns = startFakePdns();
    });
    afterEach(async () => {
      await pdns.stop();
    });

    test("the client refuses a dots-only zone before sending anything", async () => {
      const client = new PdnsClient(pdns.url, pdns.apiKey, 2000);
      for (const bad of [".", ".."]) {
        await expect(client.zone(bad)).rejects.toThrow(/invalid zone id/);
        await expect(client.patch(bad, [])).rejects.toThrow(/invalid zone id/);
      }
      expect(pdns.requests).toEqual([]);
    });

    test("a change aimed at a dots-only zone is rejected as an unknown zone without reaching PowerDNS", async () => {
      const actions = new DnsActions({ client: new PdnsClient(pdns.url, pdns.apiKey, 2000), db: openDb(":memory:") });
      const r = await actions.apply({ fields: { zone: "..", op: "delete", name: "x", type: "A" }, hash: "h", overwrite: true }, "owner");
      expect(r).toMatchObject({ ok: false, outcome: "rejected", message: "unknown zone" });
      expect(pdns.requests).toEqual([]);
    });
  });
});

describe("audit length caps", () => {
  const rows = (db: ReturnType<typeof openDb>) =>
    db.query<{ target: string | null; detail: string | null }, []>("SELECT target, detail FROM audit ORDER BY id").all();

  test("caps target and detail written from request data", () => {
    const db = openDb(":memory:");
    audit(db, { actor: "owner", action: "x", target: "t".repeat(50_000), outcome: "failed", detail: "d".repeat(50_000) });
    const [row] = rows(db);
    expect(row!.target!.length).toBeLessThanOrEqual(AUDIT_TARGET_MAX);
    expect(row!.detail!.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX);
    expect(row!.target!.startsWith("ttt")).toBe(true);
    expect(row!.detail!.startsWith("ddd")).toBe(true);
  });

  test("leaves ordinary values and absent ones alone", () => {
    const db = openDb(":memory:");
    audit(db, { actor: "owner", action: "x", target: "A fresh@web.example.test.", outcome: "ok", detail: "short" });
    audit(db, { actor: "owner", action: "x", outcome: "ok" });
    expect(rows(db)).toEqual([
      { target: "A fresh@web.example.test.", detail: "short" },
      { target: null, detail: null },
    ]);
  });

  test("a DNS request with an enormous name or type cannot bloat the audit table", async () => {
    const pdns = startFakePdns();
    try {
      const db = openDb(":memory:");
      const actions = new DnsActions({ client: new PdnsClient(pdns.url, pdns.apiKey, 2000), db });
      await actions.apply({ fields: { zone: pdns.zoneId, op: "upsert", name: "n".repeat(100_000), type: "T".repeat(100_000), ttl: "300", content: "x" }, hash: "h", overwrite: false }, "owner");
      const all = rows(db);
      expect(all.length).toBeGreaterThan(0);
      for (const r of all) {
        expect(r.target!.length).toBeLessThanOrEqual(AUDIT_TARGET_MAX);
        expect((r.detail ?? "").length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX);
      }
    } finally {
      await pdns.stop();
    }
  });
});

type Listener = () => void;

function browser() {
  const listeners = new Map<string, Set<Listener>>();
  const target = () => ({
    addEventListener: (type: string, fn: Listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
  });
  const document = { ...target(), querySelector: () => null };
  const registry: Record<string, new () => Record<string, any>> = {};
  const window = { ...target(), Stimulus: { Controller: class {}, register: (name: string, cls: new () => Record<string, any>) => void (registry[name] = cls) } };
  const source = require("node:fs").readFileSync("public/controllers/secret.js", "utf8") as string;
  new Function("window", "document", "crypto", "navigator", source)(window, document, {}, {});
  const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());
  fire("DOMContentLoaded");
  const count = (type: string) => listeners.get(type)?.size ?? 0;
  return { registry, fire, count, window, document };
}

const el = (text = "") => ({ textContent: text, hidden: false, disabled: false, classList: { remove() {} }, value: text });

describe("secret controllers wipe the value when the page is cached or left", () => {
  for (const event of ["turbo:before-cache", "pagehide"]) {
    test(`OnceController clears the shown value on ${event}`, () => {
      const b = browser();
      const c = new b.registry.once!();
      Object.assign(c, { secondsValue: 60, valueTarget: el("hunter2-hunter2"), noteTarget: el("Hides in 59 s") });
      c.connect!();
      b.fire(event);
      expect(c.valueTarget.textContent).not.toContain("hunter2");
      c.disconnect!();
    });

    test(`SecretController clears the revealed value on ${event}`, () => {
      const b = browser();
      const c = new b.registry.secret!();
      const mask = el();
      const value = el("hunter2-hunter2");
      Object.assign(c, {
        maskTarget: mask,
        valueTarget: value,
        showTarget: el(),
        hideTarget: el(),
        copyTarget: el(),
        noteTarget: el(),
        element: { setAttribute() {}, removeAttribute() {} },
      });
      c.connect!();
      c.secret = "hunter2-hunter2";
      b.fire(event);
      expect(c.secret).toBeNull();
      expect(value.textContent).toBe("");
      c.disconnect!();
    });
  }

  test("both controllers drop their listeners when disconnected", () => {
    const b = browser();
    const once = new b.registry.once!();
    Object.assign(once, { secondsValue: 60, valueTarget: el("x"), noteTarget: el() });
    once.connect!();
    once.disconnect!();
    const secret = new b.registry.secret!();
    Object.assign(secret, { maskTarget: el(), valueTarget: el(), showTarget: el(), hideTarget: el(), copyTarget: el(), noteTarget: el(), element: { setAttribute() {}, removeAttribute() {} } });
    secret.connect!();
    secret.disconnect!();
    expect(b.count("turbo:before-cache")).toBe(0);
    expect(b.count("pagehide")).toBe(0);
  });
});
