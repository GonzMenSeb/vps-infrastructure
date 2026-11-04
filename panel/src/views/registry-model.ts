import { LATEST_TAG, isBuildCache, latestDigest, sortTags, tagsOnDigest, type RegistryRepo, type RegistryTag } from "../collectors/zot";
import {
  DEFAULT_TIME_ZONE,
  fmtBytes,
  fmtSince,
  snapshotStatus,
  upOf,
  type ActionVM,
  type Flash,
  type SourceStatus,
  type UpVM,
  type ViewInput,
} from "./model";

export const REGISTRY_PATH = "/registry";
export const REGISTRY_DELETE_PATH = "/registry/delete";

export interface TagRowVM {
  tag: string;
  digest: string;
  digestShort: string;
  isLatest: boolean;
  sameAsLatest: boolean;
  buildCache: boolean;
  updatedText: string;
  updatedTitle: string;
  sizeText: string;
  delete: ActionVM | null;
  refusal: string | null;
}

export interface RepoRowVM {
  name: string;
  href: string;
  tagCount: number;
  sizeText: string;
  pushText: string;
  selected: boolean;
  error: string | null;
}

export interface RepoDetailVM {
  name: string;
  error: string | null;
  tagCount: number;
  sizeText: string;
  rows: TagRowVM[];
  latestShort: string | null;
}

export interface RegistryVM {
  configured: boolean;
  status: SourceStatus;
  repos: RepoRowVM[];
  totalText: string;
  selected: RepoDetailVM | null;
  selectedNote: string | null;
  gcText: string;
  actionsEnabled: boolean;
  flash: Flash | null;
  up: UpVM;
}

export const repoHref = (name: string) => `${REGISTRY_PATH}?repo=${encodeURIComponent(name)}`;

export const shortDigest = (d: string): string => {
  const hex = d.replace(/^sha256:/, "");
  return hex.length > 10 ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : hex;
};

const dateTitle = (iso: string, tz: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23", timeZone: tz }).format(new Date(t)) : iso;
};

function age(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? fmtSince(now - t) : "—";
}

export function buildRegistry(input: ViewInput, query: { repo?: string; flash?: Flash | null } = {}): RegistryVM {
  const rv = input.registry;
  const now = rv?.now ?? Date.now();
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  const csrf = input.csrf ?? "";
  const status = snapshotStatus("registry", "Zot", rv?.ttlMs ?? 60_000, rv?.snapshot ?? null);
  const data = rv?.snapshot?.data;
  const actionsEnabled = Boolean(rv?.actions && rv.host && data);
  const sorted: RegistryRepo[] = [...(data?.repos ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const wanted = query.repo ?? sorted[0]?.name;
  const chosen = sorted.find((r) => r.name === wanted) ?? null;

  const repos: RepoRowVM[] = sorted.map((r) => ({
    name: r.name,
    href: repoHref(r.name),
    tagCount: r.tags.length,
    sizeText: r.sizeBytes === null ? "—" : fmtBytes(r.sizeBytes),
    pushText: age(r.lastUpdated, now),
    selected: chosen?.name === r.name,
    error: r.error,
  }));

  const totalBytes = sorted.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  const gc = rv?.gc;

  let selected: RepoDetailVM | null = null;
  if (chosen) {
    const latest = latestDigest(chosen.tags);
    selected = {
      name: chosen.name,
      error: chosen.error,
      tagCount: chosen.tags.length,
      sizeText: chosen.sizeBytes === null ? "—" : fmtBytes(chosen.sizeBytes),
      latestShort: latest ? shortDigest(latest) : null,
      rows: sortTags(chosen.tags).map((t) => tagRow(chosen, t, latest, { now, tz, csrf, actionsEnabled, host: rv?.host ?? null })),
    };
  }
  return {
    configured: rv?.configured ?? false,
    status,
    repos,
    totalText: `${sorted.length} ${sorted.length === 1 ? "repository" : "repositories"} · ${fmtBytes(totalBytes)}`,
    selected,
    selectedNote: query.repo && !chosen && data ? `There is no repository called ${query.repo}.` : null,
    gcText: gc
      ? `Zot runs garbage collection on its own schedule: every ${gc.interval}, with a ${gc.delay} grace period. It has no manual trigger, so space from deleted tags comes back on a later run.`
      : "",
    actionsEnabled,
    flash: query.flash ?? null,
    up: upOf(input),
  };
}

function tagRow(
  repo: RegistryRepo,
  t: RegistryTag,
  latest: string | null,
  ctx: { now: number; tz: string; csrf: string; actionsEnabled: boolean; host: string | null },
): TagRowVM {
  const isLatest = t.tag === LATEST_TAG;
  const sameAsLatest = latest !== null && t.digest === latest;
  const shared = tagsOnDigest(repo.tags, t.digest).map((x) => x.tag);
  const refusal = sameAsLatest ? (isLatest ? "latest is never deleted from here" : "Same manifest as latest") : null;
  const others = shared.filter((x) => x !== t.tag);
  let del: ActionVM | null = null;
  if (ctx.actionsEnabled && !refusal) {
    del = {
      label: "Delete",
      action: `${REGISTRY_DELETE_PATH}?${new URLSearchParams({ repo: repo.name, tag: t.tag, digest: t.digest }).toString()}`,
      csrf: ctx.csrf,
      title: `Delete ${repo.name}:${t.tag}?`,
      body:
        `Zot deletes the manifest ${t.digest} and every tag on it: ${shared.join(", ")}.` +
        (others.length ? ` ${others.length === 1 ? "That other tag goes" : "Those other tags go"} too.` : "") +
        " This cannot be undone. Disk space returns when Zot's scheduled garbage collection runs.",
      request: `DELETE /v2/${repo.name}/manifests/${t.digest}${ctx.host ? `\nHost: ${ctx.host}` : ""}`,
      ok: shared.length > 1 ? `Delete ${shared.length} tags` : "Delete tag",
      danger: true,
    };
  }
  return {
    tag: t.tag,
    digest: t.digest,
    digestShort: shortDigest(t.digest),
    isLatest,
    sameAsLatest,
    buildCache: isBuildCache(t.tag),
    updatedText: age(t.lastUpdated, ctx.now),
    updatedTitle: t.lastUpdated ? dateTitle(t.lastUpdated, ctx.tz) : "Zot reports no date for this tag",
    sizeText: t.sizeBytes === null ? "—" : fmtBytes(t.sizeBytes),
    delete: del,
    refusal,
  };
}
