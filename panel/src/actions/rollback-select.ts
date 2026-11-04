import type { Manifest, Service } from "../manifest";

export interface RegistryTag {
  tag: string;
  digest: string;
  configDigests: string[];
  lastUpdated: string | null;
}

export interface ImageRef {
  registry: string;
  repo: string;
  tag: string;
  ref: string;
  full: string;
}

export interface PlanTag {
  tag: string;
  aliases: string[];
  digest: string;
  lastUpdated: string | null;
}

export type RollbackPlan =
  | { ok: true; current: PlanTag; previous: PlanTag; latestDigest: string; rolledBack: boolean }
  | { ok: false; reason: string };

export const IGNORED_TAGS: readonly string[] = ["buildcache"];
export const REPO_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
export const TAG_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function parseImageRef(ref: string): ImageRef | null {
  const slash = ref.indexOf("/");
  if (slash < 1) return null;
  const registry = ref.slice(0, slash);
  if (!/[.:]/.test(registry) && registry !== "localhost") return null;
  const rest = ref.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const repo = colon < 0 ? rest : rest.slice(0, colon);
  const tag = colon < 0 ? "latest" : rest.slice(colon + 1);
  if (!REPO_NAME.test(repo) || !TAG_NAME.test(tag)) return null;
  return { registry, repo, tag, ref: `${registry}/${repo}:${tag}`, full: `${registry}/${repo}` };
}

export type RollbackTarget =
  | { ok: true; image: ImageRef }
  | { ok: false; reason: string };

export function rollbackTarget(svc: Service, registryHost: string | null): RollbackTarget {
  if (svc.host !== "vps") return { ok: false, reason: `${svc.name} runs on the ${svc.host} host, which the panel cannot reach.` };
  if (svc.core) return { ok: false, reason: "Base services are updated through Ansible, so they have no rollback here." };
  if (!registryHost) return { ok: false, reason: "The panel does not know which registry host holds the images." };
  const inRegistry = svc.images.flatMap((i) => {
    const p = parseImageRef(i);
    return p && p.registry === registryHost ? [p] : [];
  });
  if (inRegistry.length === 0) return { ok: false, reason: `${svc.name} does not run an image from ${registryHost}, so there is nothing to roll back.` };
  if (inRegistry.length > 1) {
    return {
      ok: false,
      reason: `${svc.name} runs ${inRegistry.length} images from ${registryHost}. Rolling one back alone would leave the others on a different version, so the panel does not offer it.`,
    };
  }
  return { ok: true, image: inRegistry[0]! };
}

export function rollbackRepos(manifest: Manifest, registryHost: string | null): string[] {
  const repos = new Set<string>();
  for (const svc of manifest.services) {
    const t = rollbackTarget(svc, registryHost);
    if (t.ok) repos.add(t.image.repo);
  }
  return [...repos].sort();
}

const NANOS = 1_000_000_000n;

export function timestampKey(iso: string | null): bigint | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!m) return null;
  const secs = Date.parse(`${m[1]}${m[3]}`);
  if (Number.isNaN(secs)) return null;
  const frac = (m[2] ?? "").slice(0, 9).padEnd(9, "0");
  return BigInt(secs / 1000) * NANOS + BigInt(frac);
}

const NUMERIC = /^\d+$/;

function byTagPreference(a: string, b: string): number {
  if (NUMERIC.test(a) && NUMERIC.test(b)) return Number(b) - Number(a) || a.localeCompare(b);
  return a.length - b.length || a.localeCompare(b);
}

interface Group {
  digest: string;
  configDigests: Set<string>;
  tags: string[];
  key: bigint | null;
  lastUpdated: string | null;
}

function groupByDigest(tags: RegistryTag[]): Group[] {
  const groups = new Map<string, Group>();
  for (const t of tags) {
    const key = timestampKey(t.lastUpdated);
    const g = groups.get(t.digest) ?? { digest: t.digest, configDigests: new Set<string>(), tags: [], key: null, lastUpdated: null };
    g.tags.push(t.tag);
    for (const c of t.configDigests) g.configDigests.add(c);
    if (key !== null && (g.key === null || key > g.key)) {
      g.key = key;
      g.lastUpdated = t.lastUpdated;
    }
    groups.set(t.digest, g);
  }
  for (const g of groups.values()) g.tags.sort(byTagPreference);
  return [...groups.values()];
}

function newestFirst(a: Group, b: Group): number {
  if (a.key !== b.key && a.key !== null && b.key !== null) return a.key > b.key ? -1 : 1;
  return byTagPreference(a.tags[0]!, b.tags[0]!);
}

const planTag = (g: Group): PlanTag => ({ tag: g.tags[0]!, aliases: g.tags.slice(1), digest: g.digest, lastUpdated: g.lastUpdated });

export function planRollback(registryTags: RegistryTag[], runningImageIds: readonly string[] = []): RollbackPlan {
  const images = registryTags.filter((i) => TAG_NAME.test(i.tag));
  if (images.length === 0) return { ok: false, reason: "The registry has no tags for this image yet." };
  const latest = images.find((i) => i.tag === "latest");
  if (!latest) return { ok: false, reason: "The registry has no :latest tag for this image." };

  const named = images.filter((i) => i.tag !== "latest" && !IGNORED_TAGS.includes(i.tag));
  const dated = named.filter((i) => timestampKey(i.lastUpdated) !== null);
  const groups = groupByDigest(dated).sort(newestFirst);
  const all = groupByDigest(images.filter((i) => !IGNORED_TAGS.includes(i.tag)));

  const running = runningImageIds.length
    ? all.find((g) => runningImageIds.includes(g.digest) || [...g.configDigests].some((c) => runningImageIds.includes(c)))
    : undefined;
  const baselineDigest = running?.digest ?? latest.digest;
  const baseline = all.find((g) => g.digest === baselineDigest)!;
  const baselineNamed = groups.find((g) => g.digest === baselineDigest);
  const currentGroup: Group = baselineNamed ?? { ...baseline, tags: baseline.tags.filter((t) => t !== "latest") };
  const current: PlanTag = currentGroup.tags.length
    ? planTag(currentGroup)
    : { tag: "latest", aliases: [], digest: baselineDigest, lastUpdated: baseline.lastUpdated };

  const others = groups.filter((g) => g.digest !== baselineDigest);
  if (others.length === 0) {
    return { ok: false, reason: "Only one build is in the registry, so there is no earlier version to roll back to." };
  }
  const previous = others.find((g) => baseline.key === null || g.key === null || g.key <= baseline.key);
  if (!previous) {
    return { ok: false, reason: `No build older than ${current.tag} is in the registry, so there is nothing to roll back to.` };
  }
  return { ok: true, current, previous: planTag(previous), latestDigest: latest.digest, rolledBack: baselineDigest !== latest.digest };
}

export function keepTag(current: PlanTag): string | null {
  return current.tag === "latest" ? null : current.tag;
}

export function rollbackCommands(image: ImageRef, previousTag: string, dir: string, oldImageId: string | null, oldTag: string | null): string[] {
  return [
    `POST /images/create?fromImage=${image.full}&tag=${previousTag}`,
    ...(oldImageId && oldTag ? [`POST /images/${oldImageId}/tag?repo=${image.full}&tag=${oldTag}`] : []),
    `POST /images/${image.full}:${previousTag}/tag?repo=${image.full}&tag=latest`,
    `cd ${dir} && docker compose up -d --pull never`,
  ];
}
