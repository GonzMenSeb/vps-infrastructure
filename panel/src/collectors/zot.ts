import { z } from "zod";
import type { Config } from "../config";
import type { SourceOptions, Store } from "../store";

export const ZOT_REQUEST_TIMEOUT_MS = 10_000;
export const REPO_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
export const TAG_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const LATEST_TAG = "latest";
export const BUILDCACHE_TAG = "buildcache";
export const CATALOG_FETCH_CONCURRENCY = 6;

export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

export class ZotError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RegistryTag {
  tag: string;
  digest: string;
  lastUpdated: string | null;
  sizeBytes: number | null;
}

export interface RegistryRepo {
  name: string;
  sizeBytes: number | null;
  lastUpdated: string | null;
  tags: RegistryTag[];
  error: string | null;
}

export interface RegistrySnapshot {
  repos: RegistryRepo[];
}

const byteCount = z.union([z.string().regex(/^\d+$/), z.number()]).transform(Number);

const envelope = z.object({
  data: z.unknown().nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

const catalogSchema = z.object({ repositories: z.array(z.string()).nullish() });

const repoInfoSchema = z.object({
  ExpandedRepoInfo: z.object({
    Summary: z.object({ Name: z.string(), Size: byteCount.nullish(), LastUpdated: z.string().nullish() }),
    Images: z
      .array(z.object({ Tag: z.string(), Digest: z.string(), LastUpdated: z.string().nullish(), Size: byteCount.nullish() }))
      .nullish(),
  }),
});

export const repoInfoQuery = (repo: string): string => {
  if (!REPO_NAME.test(repo)) throw new Error(`invalid repository name: ${repo}`);
  return `{ExpandedRepoInfo(repo:"${repo}"){Summary{Name Size LastUpdated} Images{Tag Digest LastUpdated Size}}}`;
};

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 2000);
    const msg = (JSON.parse(text) as { errors?: { message?: string }[] }).errors?.[0]?.message;
    return msg ? ` (${msg})` : "";
  } catch {
    return "";
  }
}

export class ZotClient {
  private base: string;
  private auth: string;

  constructor(
    baseUrl: string,
    user: string,
    password: string,
    private timeoutMs = ZOT_REQUEST_TIMEOUT_MS,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  }

  get host(): string {
    return new URL(this.base).host;
  }

  async request(
    method: "GET" | "HEAD" | "DELETE",
    path: string,
    opts: { headers?: Record<string, string>; signal?: AbortSignal; accept?: readonly number[] } = {},
  ): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: this.auth, ...(opts.headers ?? {}) },
      redirect: "manual",
      signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    const ok = opts.accept ? opts.accept.includes(res.status) : res.ok;
    if (!ok) {
      const detail = method === "HEAD" ? "" : await errorDetail(res);
      await res.body?.cancel().catch(() => {});
      throw new ZotError(res.status, `zot ${method} ${path.split("?")[0]}: HTTP ${res.status}${detail}`);
    }
    return res;
  }

  async catalog(signal?: AbortSignal): Promise<string[]> {
    const body = catalogSchema.parse(await (await this.request("GET", "/v2/_catalog", { signal })).json());
    return (body.repositories ?? []).filter((r) => REPO_NAME.test(r)).sort();
  }

  async graphql<T>(query: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const res = await this.request("GET", `/v2/_zot/ext/search?query=${encodeURIComponent(query)}`, { signal });
    const body = envelope.parse(await res.json());
    if (body.errors?.length) throw new ZotError(200, `zot graphql: ${body.errors[0]!.message}`);
    if (body.data === null || body.data === undefined) throw new ZotError(200, "zot graphql: no data");
    return schema.parse(body.data);
  }

  async repoInfo(repo: string, signal?: AbortSignal): Promise<Omit<RegistryRepo, "error">> {
    const info = (await this.graphql(repoInfoQuery(repo), repoInfoSchema, signal)).ExpandedRepoInfo;
    return {
      name: info.Summary.Name,
      sizeBytes: info.Summary.Size ?? null,
      lastUpdated: info.Summary.LastUpdated ?? null,
      tags: (info.Images ?? [])
        .filter((i) => i.Tag !== "")
        .map((i) => ({ tag: i.Tag, digest: i.Digest, lastUpdated: i.LastUpdated ?? null, sizeBytes: i.Size ?? null })),
    };
  }

  async manifestDigest(repo: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    if (!REPO_NAME.test(repo)) throw new Error(`invalid repository name: ${repo}`);
    if (!TAG_NAME.test(ref) && !DIGEST.test(ref)) throw new Error(`invalid manifest reference: ${ref}`);
    try {
      const res = await this.request("HEAD", `/v2/${repo}/manifests/${ref}`, { headers: { accept: MANIFEST_ACCEPT }, signal });
      return res.headers.get("docker-content-digest");
    } catch (err) {
      if (err instanceof ZotError && err.status === 404) return null;
      throw err;
    }
  }

  async deleteManifest(repo: string, digest: string, signal?: AbortSignal): Promise<void> {
    if (!REPO_NAME.test(repo)) throw new Error(`invalid repository name: ${repo}`);
    if (!DIGEST.test(digest)) throw new Error(`invalid digest: ${digest}`);
    const res = await this.request("DELETE", `/v2/${repo}/manifests/${digest}`, { signal, accept: [200, 202] });
    await res.body?.cancel().catch(() => {});
  }
}

export function zotClientFromConfig(cfg: Pick<Config, "ZOT_URL" | "ZOT_USER" | "ZOT_PASSWORD">): ZotClient | null {
  if (!cfg.ZOT_URL || !cfg.ZOT_USER || !cfg.ZOT_PASSWORD) return null;
  return new ZotClient(cfg.ZOT_URL, cfg.ZOT_USER, cfg.ZOT_PASSWORD);
}

export const latestDigest = (tags: readonly RegistryTag[]): string | null => tags.find((t) => t.tag === LATEST_TAG)?.digest ?? null;

export const tagsOnDigest = (tags: readonly RegistryTag[], digest: string): RegistryTag[] => tags.filter((t) => t.digest === digest);

export const isBuildCache = (tag: string): boolean => tag === BUILDCACHE_TAG;

export function sortTags(tags: readonly RegistryTag[]): RegistryTag[] {
  const rank = (t: RegistryTag) => (t.tag === LATEST_TAG ? 0 : t.lastUpdated === null ? 2 : 1);
  return [...tags].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "") ||
      a.tag.localeCompare(b.tag),
  );
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function fetchRegistry(client: ZotClient, signal?: AbortSignal): Promise<RegistrySnapshot> {
  const names = await client.catalog(signal);
  const repos = await mapLimit(names, CATALOG_FETCH_CONCURRENCY, async (name): Promise<RegistryRepo> => {
    try {
      return { ...(await client.repoInfo(name, signal)), error: null };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { name, sizeBytes: null, lastUpdated: null, tags: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  const failed = repos.filter((r) => r.error !== null);
  if (repos.length > 0 && failed.length === repos.length) throw new Error(failed[0]!.error!);
  return { repos };
}

export const ZOT_SOURCES = { repos: "zot:repos" } as const;

export const ZOT_TTL = { reposMs: 60_000, minTimeoutMs: 5_000 } as const;

export function registerZotSources(store: Store, client: ZotClient, base: Omit<SourceOptions, "ttlMs">): void {
  store.register(ZOT_SOURCES.repos, (signal) => fetchRegistry(client, signal), {
    ...base,
    ttlMs: ZOT_TTL.reposMs,
    timeoutMs: Math.max(base.timeoutMs, ZOT_TTL.minTimeoutMs),
  });
}
