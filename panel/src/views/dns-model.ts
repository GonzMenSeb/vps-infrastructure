import type { DnsOwner, DnsRecordSet, DnsZone } from "../collectors/pdns";
import { DNS_TYPES, TTL_DEFAULT, relativeName, reviewChange, type DnsReview } from "../lib/dns";
import { snapshotStatus, upOf, type ChipTone, type Flash, type SourceStatus, type UpVM, type ViewInput } from "./model";

export const DNS_PATH = "/dns";
export const DNS_APPLY_PATH = "/dns/apply";

export interface DnsRowVM {
  key: string;
  type: string;
  name: string;
  fqdn: string;
  contents: { text: string; disabled: boolean }[];
  ttl: number;
  owner: DnsOwner;
  ownerLabel: string;
  ownerTone: ChipTone;
  editHref: string | null;
  deleteHref: string | null;
  note: string | null;
}

export interface DnsFormVM {
  mode: "add" | "edit";
  zone: string;
  type: string;
  name: string;
  ttl: string;
  content: string;
  error: string | null;
  cancelHref: string | null;
}

export interface DnsReviewVM {
  op: "upsert" | "delete";
  title: string;
  request: string;
  hash: string;
  needsOverwrite: boolean;
  unchanged: boolean;
  fields: Record<string, string>;
  csrf: string;
  ownerNote: string | null;
  cancelHref: string;
  canApply: boolean;
}

export interface DnsZoneTab {
  id: string;
  name: string;
  href: string;
  selected: boolean;
}

export interface DnsVM {
  configured: boolean;
  status: SourceStatus;
  zones: DnsZoneTab[];
  zone: { id: string; name: string; bare: string } | null;
  rows: DnsRowVM[];
  filter: string;
  countText: string;
  panelOnly: number;
  form: DnsFormVM;
  review: DnsReviewVM | null;
  reviewError: string | null;
  flash: Flash | null;
  actionsEnabled: boolean;
  csrf: string;
  types: readonly string[];
  up: UpVM;
}

export interface DnsQuery {
  zone?: string;
  q?: string;
  edit?: string;
  review?: boolean;
  fields?: Record<string, string>;
  flash?: Flash | null;
}

const EDITABLE: readonly string[] = DNS_TYPES;

const OWNER: Record<DnsOwner, { label: string; tone: ChipTone }> = {
  panel: { label: "Panel only", tone: "warn" },
  other: { label: "Ansible / other", tone: "info" },
  zone: { label: "Zone", tone: "" },
};


export const dnsHref = (zone: string, extra: Record<string, string> = {}): string =>
  `${DNS_PATH}?${new URLSearchParams({ zone, ...extra }).toString()}`;

function row(zone: DnsZone, r: DnsRecordSet, actions: boolean): DnsRowVM {
  const editable = actions && r.owner !== "zone" && EDITABLE.includes(r.type);
  const rel = relativeName(r.name, zone.name);
  return {
    key: `${r.type}:${r.name}`,
    type: r.type,
    name: rel,
    fqdn: r.name,
    contents: r.records.map((x) => ({ text: x.content, disabled: x.disabled })),
    ttl: r.ttl,
    owner: r.owner,
    ownerLabel: OWNER[r.owner].label,
    ownerTone: OWNER[r.owner].tone,
    editHref: editable ? `${dnsHref(zone.id, { edit: `${r.type}:${r.name}` })}#record-form` : null,
    deleteHref: editable ? dnsHref(zone.id, { review: "1", op: "delete", name: rel, type: r.type }) : null,
    note:
      r.owner === "zone"
        ? "Belongs to the zone itself"
        : !EDITABLE.includes(r.type)
          ? `${r.type} records are shown but not editable here`
          : null,
  };
}

const blankForm = (zone: string): DnsFormVM => ({ mode: "add", zone, type: "A", name: "", ttl: String(TTL_DEFAULT), content: "", error: null, cancelHref: null });

export function buildDns(input: ViewInput, query: DnsQuery = {}): DnsVM {
  const dv = input.dns;
  const csrf = input.csrf ?? "";
  const status = snapshotStatus("dns", "PowerDNS", dv?.ttlMs ?? 30_000, dv?.snapshot ?? null);
  const zones = dv?.snapshot?.data?.zones ?? [];
  const chosen = zones.find((z) => z.id === query.zone) ?? zones[0] ?? null;
  const actionsEnabled = Boolean(dv?.actions && chosen);
  const filter = (query.q ?? "").trim().slice(0, 100);
  const needle = filter.toLowerCase();
  const sorted = chosen
    ? [...chosen.rrsets].sort((a, b) => {
        const ra = relativeName(a.name, chosen.name);
        const rb = relativeName(b.name, chosen.name);
        if (ra === "@" || rb === "@") return ra === "@" && rb === "@" ? a.type.localeCompare(b.type) : ra === "@" ? -1 : 1;
        return ra.localeCompare(rb) || a.type.localeCompare(b.type);
      })
    : [];
  const rows = chosen
    ? sorted
        .map((r) => row(chosen, r, actionsEnabled))
        .filter((r) => !needle || `${r.name} ${r.fqdn} ${r.type} ${r.contents.map((c) => c.text).join(" ")}`.toLowerCase().includes(needle))
    : [];

  let form: DnsFormVM = blankForm(chosen?.id ?? "");
  if (chosen && query.edit) {
    const [type, ...rest] = query.edit.split(":");
    const fqdn = rest.join(":");
    const rr = chosen.rrsets.find((r) => r.type === type && r.name === fqdn);
    if (rr && EDITABLE.includes(rr.type) && rr.owner !== "zone") {
      form = {
        mode: "edit",
        zone: chosen.id,
        type: rr.type,
        name: relativeName(rr.name, chosen.name),
        ttl: String(rr.ttl),
        content: rr.records.map((x) => x.content).join("\n"),
        error: null,
        cancelHref: dnsHref(chosen.id),
      };
    }
  }

  let review: DnsReviewVM | null = null;
  let reviewError: string | null = null;
  if (chosen && query.review) {
    const f = query.fields ?? {};
    const raw = { zone: chosen.id, op: f.op ?? "upsert", name: f.name ?? "", type: f.type ?? "", ttl: f.ttl, content: f.content };
    const r = reviewChange(raw, zones);
    if (!r.ok) {
      reviewError = r.error;
      if (raw.op !== "delete") {
        form = { mode: "add", zone: chosen.id, type: raw.type || "A", name: raw.name, ttl: raw.ttl ?? String(TTL_DEFAULT), content: raw.content ?? "", error: r.error, cancelHref: null };
      }
    } else {
      review = reviewVM(r.value, raw, csrf, chosen, dnsHref(chosen.id));
    }
  }

  return {
    configured: dv?.configured ?? false,
    status,
    zones: zones.map((z) => ({ id: z.id, name: z.name.replace(/\.$/, ""), href: dnsHref(z.id), selected: z.id === chosen?.id })),
    zone: chosen ? { id: chosen.id, name: chosen.name, bare: chosen.name.replace(/\.$/, "") } : null,
    rows,
    filter,
    countText: chosen ? `${chosen.rrsets.length} record sets in ${chosen.name.replace(/\.$/, "")}` : "",
    panelOnly: chosen ? chosen.rrsets.filter((r) => r.owner === "panel").length : 0,
    form,
    review,
    reviewError: review ? null : reviewError,
    flash: query.flash ?? null,
    actionsEnabled,
    csrf,
    types: DNS_TYPES,
    up: upOf(input),
  };
}

function reviewVM(r: DnsReview, raw: Record<string, unknown>, csrf: string, zone: DnsZone, cancelHref: string): DnsReviewVM {
  const c = r.change;
  const label = `${c.type} ${relativeName(c.name, zone.name)}`;
  const fields: Record<string, string> = {};
  for (const k of ["zone", "op", "name", "type", "ttl", "content"]) {
    const v = raw[k];
    if (typeof v === "string") fields[k] = v;
  }
  return {
    op: c.op,
    title: c.op === "delete" ? `Delete ${label}` : r.existing ? `Change ${label}` : `Add ${label}`,
    request: r.request,
    hash: r.hash,
    needsOverwrite: r.needsOverwrite,
    unchanged: r.unchanged,
    fields,
    csrf,
    ownerNote: r.needsOverwrite
      ? "This record has no managed-by: panel comment, so Ansible or another tool owns it. Ansible writes it again on its next deploy and undoes this change."
      : null,
    cancelHref,
    canApply: !r.unchanged,
  };
}

