import { z } from "zod";
import { REPO_NAME, type RegistryTag } from "../actions/rollback-select";
import type { SourceOptions, Store } from "../store";

const imageSchema = z.object({
  Tag: z.string(),
  Digest: z.string(),
  LastUpdated: z.string().nullable().optional(),
  Manifests: z.array(z.object({ ConfigDigest: z.string().nullable().optional() })).nullable().optional(),
});

const responseSchema = z.object({
  data: z.object({ ExpandedRepoInfo: z.object({ Images: z.array(imageSchema).nullable() }).nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).nullable().optional(),
});

export type ZotRepoTags = Record<string, RegistryTag[] | null>;

export const ZOT_TAG_SOURCE = "zot:tags";
export const ZOT_TAG_TTL = { ttlMs: 60_000, timeoutMs: 10_000 } as const;
const NOT_FOUND = /repo metadata not found/i;

export class ZotTagsClient {
  private auth: string | null;

  constructor(
    private baseUrl: string,
    user?: string,
    password?: string,
    private timeoutMs = ZOT_TAG_TTL.timeoutMs,
  ) {
    this.auth = user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` : null;
  }

  async repoTags(repo: string, signal?: AbortSignal): Promise<RegistryTag[] | null> {
    if (!REPO_NAME.test(repo)) throw new Error(`invalid repository name ${repo}`);
    const query = `{ ExpandedRepoInfo(repo:"${repo}"){ Images{ Tag Digest LastUpdated Manifests{ ConfigDigest } } } }`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v2/_zot/ext/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.auth ? { authorization: this.auth } : {}) },
      body: JSON.stringify({ query }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`zot search: HTTP ${res.status}`);
    }
    const body = responseSchema.parse(await res.json());
    const info = body.data?.ExpandedRepoInfo;
    if (info) {
      return (info.Images ?? []).map((i) => ({
        tag: i.Tag,
        digest: i.Digest,
        configDigests: (i.Manifests ?? []).flatMap((m) => (m.ConfigDigest ? [m.ConfigDigest] : [])),
        lastUpdated: i.LastUpdated ?? null,
      }));
    }
    if (body.errors?.some((e) => NOT_FOUND.test(e.message))) return null;
    throw new Error(`zot search: ${body.errors?.[0]?.message ?? "no repository info in the answer"}`);
  }
}

export function registerZotTagSource(store: Store, client: ZotTagsClient, repos: () => string[], base: Omit<SourceOptions, "ttlMs">): void {
  store.register(
    ZOT_TAG_SOURCE,
    async (signal): Promise<ZotRepoTags> => {
      const names = repos();
      const answers = await Promise.all(names.map((r) => client.repoTags(r, signal)));
      return Object.fromEntries(names.map((r, i) => [r, answers[i]!]));
    },
    { ...base, ttlMs: ZOT_TAG_TTL.ttlMs, timeoutMs: Math.max(base.timeoutMs, ZOT_TAG_TTL.timeoutMs) },
  );
}
