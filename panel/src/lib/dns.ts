import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import {
  PANEL_ACCOUNT,
  PANEL_COMMENT,
  PDNS_SERVER,
  ZONE_ID,
  type DnsRecord,
  type DnsRecordSet,
  type DnsZone,
  type PatchRrset,
} from "../collectors/pdns";

export const DNS_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

export const TTL_MIN = 1;
export const TTL_MAX = 2_147_483_647;
export const TTL_DEFAULT = 3600;
export const MAX_RECORDS = 20;
export const MAX_CONTENT_CHARS = 4000;
export const TXT_CHUNK_MAX = 255;
export const NAME_MAX = 253;

const LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;
const TXT_QUOTED = /^"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")*$/;
const TXT_CHUNK = /"((?:[^"\\]|\\.)*)"/g;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export const NOT_EDITABLE_ZONE_TYPES = "SOA and NS records belong to the zone itself, so the panel never edits them";

export interface DnsChange {
  zone: string;
  zoneName: string;
  op: "upsert" | "delete";
  name: string;
  type: DnsType;
  ttl: number;
  contents: string[];
}

export interface DnsReview {
  change: DnsChange;
  existing: DnsRecordSet | null;
  needsOverwrite: boolean;
  unchanged: boolean;
  patch: PatchRrset;
  request: string;
  hash: string;
}

export type DnsParse<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const rawSchema = z.object({
  zone: z.string().regex(ZONE_ID, "unknown zone"),
  op: z.enum(["upsert", "delete"], { message: "unknown operation" }),
  name: z.string().trim().min(1, "the name is required").max(NAME_MAX, "the name is too long"),
  type: z.string().trim().min(1, "the type is required").max(10, "unknown record type"),
  ttl: z.string().trim().max(12).optional(),
  content: z.string().max(MAX_CONTENT_CHARS, "the content is too long").optional(),
});

function checkLabels(bare: string, wildcardOk: boolean): string | null {
  const labels = bare.split(".");
  for (const [i, l] of labels.entries()) {
    if (l === "*" && wildcardOk && i === 0 && labels.length > 1) continue;
    if (!LABEL.test(l)) return `"${l}" is not a valid DNS label`;
  }
  return null;
}

export function toFqdn(input: string, zoneName: string): DnsParse<string> {
  const zone = zoneName.toLowerCase();
  const bareZone = zone.replace(/\.$/, "");
  const n = input.trim().toLowerCase();
  if (n === "@") return { ok: true, value: zone };
  const explicit = n.endsWith(".");
  const fq = explicit ? n : `${n}.${zone}`;
  if (!explicit && (n === bareZone || n.endsWith(`.${bareZone}`))) {
    return fail(`${input} already ends with the zone name; write it relative to the zone, or finish it with a dot`);
  }
  if (fq !== zone && !fq.endsWith(`.${zone}`)) return fail(`${input} is outside the zone ${bareZone}`);
  if (fq.length - 1 > NAME_MAX) return fail("the name is too long");
  if (fq === zone) return { ok: true, value: fq };
  const bad = checkLabels(fq.slice(0, fq.length - zone.length - 1), true);
  return bad ? fail(bad) : { ok: true, value: fq };
}

function hostTarget(line: string, what: string): DnsParse<string> {
  const host = line.trim().toLowerCase();
  const bare = host.replace(/\.$/, "");
  if (bare === "" || bare.length > NAME_MAX) return fail(`${what} needs a host name`);
  const bad = checkLabels(bare, false);
  return bad ? fail(`${what}: ${bad}`) : { ok: true, value: `${bare}.` };
}

function txtRecord(line: string): DnsParse<string> {
  if (!PRINTABLE_ASCII.test(line)) return fail("TXT content must be printable ASCII");
  if (line.startsWith('"')) {
    if (!TXT_QUOTED.test(line)) return fail("TXT content starting with a quote must be one or more complete quoted strings");
    for (const m of line.matchAll(TXT_CHUNK)) {
      if (m[1]!.replace(/\\(.)/g, "$1").length > TXT_CHUNK_MAX) return fail(`a quoted TXT string is longer than ${TXT_CHUNK_MAX} characters`);
    }
    return { ok: true, value: line };
  }
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += TXT_CHUNK_MAX) chunks.push(line.slice(i, i + TXT_CHUNK_MAX));
  return { ok: true, value: chunks.map((c) => `"${c.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ") };
}

export function normalizeContents(type: DnsType, text: string, apex: boolean): DnsParse<string[]> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return fail("the content is required");
  if (lines.length > MAX_RECORDS) return fail(`at most ${MAX_RECORDS} records per name and type`);
  const out: string[] = [];
  for (const line of lines) {
    let r: DnsParse<string>;
    switch (type) {
      case "A":
        r = isIPv4(line) ? { ok: true, value: line } : fail(`${line} is not an IPv4 address`);
        break;
      case "AAAA":
        r = isIPv6(line) && !line.includes("%") ? { ok: true, value: line.toLowerCase() } : fail(`${line} is not an IPv6 address`);
        break;
      case "CNAME":
        r = hostTarget(line, "CNAME target");
        break;
      case "MX": {
        const m = /^(\d{1,5})\s+(\S+)$/.exec(line);
        if (!m || Number(m[1]) > 65535) {
          r = fail(`${line} is not "<priority 0-65535> <mail host>"`);
          break;
        }
        const host = hostTarget(m[2]!, "MX host");
        r = host.ok ? { ok: true, value: `${Number(m[1])} ${host.value}` } : host;
        break;
      }
      case "TXT":
        r = txtRecord(line);
        break;
    }
    if (!r.ok) return r;
    if (!out.includes(r.value)) out.push(r.value);
  }
  if (type === "CNAME") {
    if (out.length !== 1) return fail("a CNAME has exactly one target");
    if (apex) return fail("a CNAME cannot sit at the zone apex");
  }
  return { ok: true, value: out };
}

export function parseChange(raw: Record<string, unknown>, zones: readonly DnsZone[]): DnsParse<DnsChange> {
  const shape = rawSchema.safeParse(raw);
  if (!shape.success) return fail(shape.error.issues[0]!.message);
  const v = shape.data;
  const zone = zones.find((z) => z.id === v.zone);
  if (!zone) return fail("unknown zone");
  const type = v.type.toUpperCase();
  if (type === "SOA" || type === "NS") return fail(NOT_EDITABLE_ZONE_TYPES);
  if (!(DNS_TYPES as readonly string[]).includes(type)) return fail(`${type} records are not editable here; supported types are ${DNS_TYPES.join(", ")}`);
  const name = toFqdn(v.name, zone.name);
  if (!name.ok) return name;
  const base = { zone: zone.id, zoneName: zone.name, op: v.op, name: name.value, type: type as DnsType };
  if (v.op === "delete") return { ok: true, value: { ...base, ttl: 0, contents: [] } };
  const ttl = Number(v.ttl ?? "");
  if (!/^\d+$/.test(v.ttl ?? "") || ttl < TTL_MIN || ttl > TTL_MAX) return fail(`the TTL must be a whole number from ${TTL_MIN} to ${TTL_MAX}`);
  const contents = normalizeContents(base.type, v.content ?? "", name.value === zone.name.toLowerCase());
  if (!contents.ok) return contents;
  return { ok: true, value: { ...base, ttl, contents: contents.value } };
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const recordKey = (r: Pick<DnsRecordSet, "name" | "type">) => `${r.type}:${r.name.toLowerCase()}`;

export function sameRecords(a: readonly DnsRecord[], b: readonly DnsRecord[]): boolean {
  const key = (r: DnsRecord) => `${r.disabled ? "0" : "1"}|${r.content}`;
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

export function buildPatch(change: DnsChange, existing: DnsRecordSet | null): PatchRrset {
  if (change.op === "delete") return { name: change.name, type: change.type, changetype: "DELETE" };
  const disabled = new Map((existing?.records ?? []).map((r) => [r.content, r.disabled]));
  return {
    name: change.name,
    type: change.type,
    ttl: change.ttl,
    changetype: "REPLACE",
    records: change.contents.map((content) => ({ content, disabled: disabled.get(content) ?? false })),
    ...(existing ? {} : { comments: [{ content: PANEL_COMMENT, account: PANEL_ACCOUNT }] }),
  };
}

export const patchRequest = (zoneId: string, patch: PatchRrset): string =>
  `PATCH /api/v1/servers/${PDNS_SERVER}/zones/${encodeURIComponent(zoneId)}\n${JSON.stringify({ rrsets: [patch] }, null, 2)}`;

export const requestHash = (zoneId: string, patch: PatchRrset): string =>
  createHash("sha256").update(JSON.stringify({ zoneId, patch })).digest("base64url").slice(0, 32);

export function reviewChange(raw: Record<string, unknown>, zones: readonly DnsZone[]): DnsParse<DnsReview> {
  const parsed = parseChange(raw, zones);
  if (!parsed.ok) return parsed;
  const change = parsed.value;
  const zone = zones.find((z) => z.id === change.zone)!;
  const existing = zone.rrsets.find((r) => sameName(r.name, change.name) && r.type === change.type) ?? null;
  if (change.op === "delete" && !existing) return fail(`there is no ${change.type} record named ${change.name}`);
  const others = zone.rrsets.filter((r) => sameName(r.name, change.name) && r.type !== change.type);
  if (change.op === "upsert") {
    if (change.type === "CNAME" && others.length > 0) {
      return fail(`${change.name} already has ${others.map((o) => o.type).join(", ")} records, and a CNAME cannot sit beside other records`);
    }
    if (change.type !== "CNAME" && others.some((o) => o.type === "CNAME")) {
      return fail(`${change.name} is a CNAME; remove it before adding ${change.type} records there`);
    }
  }
  const patch = buildPatch(change, existing);
  const unchanged =
    change.op === "upsert" &&
    existing !== null &&
    existing.ttl === change.ttl &&
    sameRecords(existing.records, patch.records ?? []);
  return {
    ok: true,
    value: {
      change,
      existing,
      needsOverwrite: existing !== null && existing.owner === "other",
      unchanged,
      patch,
      request: patchRequest(change.zone, patch),
      hash: requestHash(change.zone, patch),
    },
  };
}

export const relativeName = (fqdn: string, zoneName: string): string => {
  const f = fqdn.toLowerCase();
  const z = zoneName.toLowerCase();
  if (f === z) return "@";
  return f.endsWith(`.${z}`) ? f.slice(0, f.length - z.length - 1) : f;
};
