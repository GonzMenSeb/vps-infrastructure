import type { Database } from "bun:sqlite";
import { audit } from "../db";
import { PDNS_SOURCES, PdnsError, ZONE_ID, type DnsZone, type PdnsClient } from "../collectors/pdns";
import { recordKey, reviewChange, sameRecords, type DnsReview } from "../lib/dns";
import type { Store } from "../store";
import { errMessage, KeyedLocks, type ActionResult } from "./result";

export interface DnsActionDeps {
  client: PdnsClient;
  db: Database;
  store?: Store;
}

export interface DnsApplyInput {
  fields: Record<string, unknown>;
  hash: string | undefined;
  overwrite: boolean;
}

export class DnsActions {
  private locks = new KeyedLocks();

  constructor(private deps: DnsActionDeps) {}

  locked(zone: string): boolean {
    return this.locks.has(zone);
  }

  async apply(input: DnsApplyInput, actor: string): Promise<ActionResult> {
    const raw = input.fields;
    const zoneId = typeof raw.zone === "string" ? raw.zone : "";
    const op = raw.op === "delete" ? "dns.delete" : "dns.upsert";
    const target = `${String(raw.type ?? "").toUpperCase()} ${String(raw.name ?? "")}@${zoneId}`;
    const record = (r: ActionResult): ActionResult => {
      audit(this.deps.db, { actor, action: op, target, outcome: r.outcome, detail: r.message });
      return r;
    };
    if (!ZONE_ID.test(zoneId)) return record({ ok: false, outcome: "rejected", message: "unknown zone" });
    if (!input.hash) return record({ ok: false, outcome: "rejected", message: "review the change before applying it" });
    if (this.locks.has(zoneId)) return record({ ok: false, outcome: "busy", message: `another change to ${zoneId} is in progress` });
    return this.locks.run(zoneId, async () => {
      try {
        let zone: DnsZone;
        try {
          zone = await this.deps.client.zone(zoneId);
        } catch (err) {
          if (err instanceof PdnsError && err.status === 404) return record({ ok: false, outcome: "rejected", message: "unknown zone" });
          throw err;
        }
        const reviewed = reviewChange(raw, [zone]);
        if (!reviewed.ok) return record({ ok: false, outcome: "rejected", message: reviewed.error });
        const review = reviewed.value;
        if (review.hash !== input.hash) {
          return record({ ok: false, outcome: "rejected", message: "the record changed since you reviewed it; review it again" });
        }
        if (review.needsOverwrite && !input.overwrite) {
          return record({
            ok: false,
            outcome: "rejected",
            message: `${review.change.type} ${review.change.name} is managed by Ansible or another tool; tick the overwrite box to change it`,
          });
        }
        if (review.unchanged) return record({ ok: true, outcome: "verified", message: `${review.change.type} ${review.change.name} already has these values` });
        audit(this.deps.db, { actor, action: op, target, outcome: "requested", detail: review.needsOverwrite ? "overwrites a record not created by the panel" : undefined });
        await this.deps.client.patch(review.change.zone, [review.patch]);
        return record(await this.verify(review));
      } catch (err) {
        return record({ ok: false, outcome: "failed", message: errMessage(err) });
      } finally {
        if (this.deps.store) void this.deps.store.refresh(PDNS_SOURCES.zones).catch(() => {});
      }
    });
  }

  private async verify(review: DnsReview): Promise<ActionResult> {
    const { change } = review;
    const zone: DnsZone = await this.deps.client.zone(change.zone);
    const found = zone.rrsets.find((r) => recordKey(r) === recordKey(change));
    const label = `${change.type} ${change.name}`;
    if (change.op === "delete") {
      return found
        ? { ok: false, outcome: "unverified", message: `PowerDNS accepted the delete but ${label} is still there` }
        : { ok: true, outcome: "verified", message: `deleted ${label}${review.needsOverwrite ? "; Ansible recreates it on its next run" : ""}` };
    }
    if (!found) return { ok: false, outcome: "unverified", message: `PowerDNS accepted the change but ${label} cannot be read back` };
    const good = found.ttl === change.ttl && sameRecords(found.records, review.patch.records ?? []);
    if (!good) return { ok: false, outcome: "unverified", message: `PowerDNS accepted the change but ${label} reads back with different values` };
    return {
      ok: true,
      outcome: "verified",
      message: `${review.existing ? "updated" : "added"} ${label}${review.needsOverwrite ? "; Ansible restores its own values on its next run" : ""}`,
    };
  }
}
