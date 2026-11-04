import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ZOT_SOURCES,
  ZotClient,
  ZotError,
  fetchRegistry,
  isBuildCache,
  latestDigest,
  registerZotSources,
  repoInfoQuery,
  sortTags,
  tagsOnDigest,
  zotClientFromConfig,
  type RegistryTag,
} from "../src/collectors/zot";
import { Store } from "../src/store";
import { startFakeZot, type FakeZot } from "./dev/zot-fixture";

let zot: FakeZot;
let client: ZotClient;

beforeAll(() => {
  zot = startFakeZot();
  client = new ZotClient(zot.url, "ci", "dev-password", 2000);
});
afterAll(async () => {
  await zot.stop();
});

const tag = (t: string, digest: string, lastUpdated: string | null): RegistryTag => ({ tag: t, digest, lastUpdated, sizeBytes: 1 });

describe("zot collector", () => {
  test("reads every repository with tags, digests, sizes and dates", async () => {
    const snap = await fetchRegistry(client);
    expect(snap.repos.map((r) => r.name)).toEqual([
      "coros/brujula",
      "judicabot/judicabot",
      "losprompteros/decabot",
      "miplata/api",
      "miplata/categorizer",
      "miplata/web",
      "panel/panel",
    ]);
    const jb = snap.repos.find((r) => r.name === "judicabot/judicabot")!;
    expect(jb.error).toBeNull();
    expect(typeof jb.sizeBytes).toBe("number");
    expect(jb.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(jb.tags.map((t) => t.tag).sort()).toEqual(["32f1bd4", "3ee016f", "buildcache", "c19ab44", "latest"]);
    const cache = jb.tags.find((t) => t.tag === "buildcache")!;
    expect(cache.lastUpdated).toBeNull();
    expect(typeof cache.sizeBytes).toBe("number");
  });

  test("tags sharing latest's digest are found through the helpers", async () => {
    const jb = (await fetchRegistry(client)).repos.find((r) => r.name === "judicabot/judicabot")!;
    const latest = latestDigest(jb.tags)!;
    expect(tagsOnDigest(jb.tags, latest).map((t) => t.tag).sort()).toEqual(["c19ab44", "latest"]);
    expect(isBuildCache("buildcache")).toBe(true);
    expect(isBuildCache("latest")).toBe(false);
    expect(latestDigest([tag("a", "sha256:x", null)])).toBeNull();
  });

  test("sorts latest first, then newest, with undated tags last", () => {
    const sorted = sortTags([
      tag("buildcache", "d3", null),
      tag("old", "d1", "2026-01-01T00:00:00Z"),
      tag("latest", "d2", "2026-02-01T00:00:00Z"),
      tag("new", "d2", "2026-02-01T00:00:00Z"),
    ]);
    expect(sorted.map((t) => t.tag)).toEqual(["latest", "new", "old", "buildcache"]);
  });

  test("one unreadable repository does not hide the others", async () => {
    zot.breakRepo("miplata/web");
    try {
      const snap = await fetchRegistry(client);
      const bad = snap.repos.find((r) => r.name === "miplata/web")!;
      expect(bad.error).toContain("repo metadata not found");
      expect(bad.tags).toEqual([]);
      expect(snap.repos.filter((r) => r.error === null).length).toBe(snap.repos.length - 1);
    } finally {
      zot.breakRepo("miplata/web", false);
    }
  });

  test("fails when every repository is unreadable, so the breaker and stale note engage", async () => {
    for (const r of zot.state.keys()) zot.breakRepo(r);
    try {
      await expect(fetchRegistry(client)).rejects.toThrow("repo metadata not found");
    } finally {
      for (const r of zot.state.keys()) zot.breakRepo(r, false);
    }
  });

  test("wrong credentials surface as a ZotError carrying the status", async () => {
    const bad = new ZotClient(zot.url, "ci", "wrong", 2000);
    const err = await bad.catalog().catch((e) => e);
    expect(err).toBeInstanceOf(ZotError);
    expect((err as ZotError).status).toBe(401);
  });

  test("graphql errors with HTTP 200 are failures", async () => {
    await expect(client.repoInfo("does/not-exist")).rejects.toThrow("repo metadata not found");
  });

  test("HEAD returns the digest, an absent reference is null", async () => {
    const jb = (await client.repoInfo("judicabot/judicabot")).tags;
    expect(await client.manifestDigest("judicabot/judicabot", "latest")).toBe(latestDigest(jb));
    expect(await client.manifestDigest("judicabot/judicabot", "nope")).toBeNull();
    await expect(client.manifestDigest("Bad Repo", "latest")).rejects.toThrow("invalid repository name");
    await expect(client.manifestDigest("judicabot/judicabot", "a b")).rejects.toThrow("invalid manifest reference");
  });

  test("repository names are validated before they reach a query or a path", () => {
    expect(() => repoInfoQuery('a"b')).toThrow("invalid repository name");
    expect(() => repoInfoQuery("a/b")).not.toThrow();
  });

  test("a source reports stale data after Zot goes away", async () => {
    const store = new Store();
    registerZotSources(store, client, { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 15_000 });
    await store.refresh(ZOT_SOURCES.repos);
    expect(store.peek(ZOT_SOURCES.repos).data).toBeDefined();
    zot.setDown(true);
    try {
      await store.refresh(ZOT_SOURCES.repos);
      const snap = store.peek(ZOT_SOURCES.repos);
      expect(snap.data).toBeDefined();
      expect(snap.lastError).toContain("503");
    } finally {
      zot.setDown(false);
    }
  });

  test("the client is built only when URL, user and password are all set", () => {
    expect(zotClientFromConfig({ ZOT_URL: undefined, ZOT_USER: "ci", ZOT_PASSWORD: "p" })).toBeNull();
    expect(zotClientFromConfig({ ZOT_URL: "http://zot:5000", ZOT_USER: "ci", ZOT_PASSWORD: undefined })).toBeNull();
    expect(zotClientFromConfig({ ZOT_URL: "http://zot:5000", ZOT_USER: "ci", ZOT_PASSWORD: "p" })?.host).toBe("zot:5000");
  });
});
