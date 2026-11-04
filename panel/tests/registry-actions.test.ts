import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RegistryActions } from "../src/actions/registry";
import { ZOT_SOURCES, ZotClient, ZotError, latestDigest, registerZotSources, type RegistryTag } from "../src/collectors/zot";
import { ZOT_TAG_SOURCE, ZotTagsClient, registerZotTagSource } from "../src/collectors/zot-tags";
import { openDb } from "../src/db";
import { Store } from "../src/store";
import { REGISTRY_PASSWORD } from "./dev/registry-fixture";
import { startFakeZot, type FakeZot, type FakeZotTag } from "./dev/zot-fixture";

let zot: FakeZot;
let client: ZotClient;

beforeEach(() => {
  zot = startFakeZot();
  client = new ZotClient(zot.url, "ci", REGISTRY_PASSWORD, 2000);
});
afterEach(async () => {
  await zot.stop();
});

const rig = (c: ZotClient = client, store?: Store) => {
  const db = openDb(":memory:");
  const actions = new RegistryActions({ client: c, db, store, pollMs: 1, sleep: async () => {} });
  const rows = () =>
    db.query<{ action: string; target: string; outcome: string; detail: string | null }, []>("SELECT action, target, outcome, detail FROM audit ORDER BY id").all();
  return { actions, rows, db };
};

const tags = (repo: string): FakeZotTag[] => zot.state.get(repo)!;
const find = (repo: string, t: string) => tags(repo).find((x) => x.tag === t)!;

describe("registry delete action", () => {
  test("deletes an old manifest, verifies it is gone and latest is untouched, and audits both steps", async () => {
    const { actions, rows } = rig();
    const target = find("miplata/api", "410");
    const latestBefore = latestDigest(tags("miplata/api"));
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: target.digest }, "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    expect(r.message).toContain("tag 410");
    expect(r.message).toContain("garbage collection");
    expect(zot.deletes).toEqual([{ repo: "miplata/api", ref: target.digest }]);
    expect(tags("miplata/api").some((t) => t.tag === "410")).toBe(false);
    expect(latestDigest(tags("miplata/api"))).toBe(latestBefore);
    expect(rows().map((x) => [x.action, x.outcome, x.target])).toEqual([
      ["registry.delete", "requested", `miplata/api@${target.digest}`],
      ["registry.delete", "verified", `miplata/api@${target.digest}`],
    ]);
  });

  test("a digest shared by several tags removes them all and says so", async () => {
    const { actions } = rig();
    const orig = find("miplata/api", "411");
    tags("miplata/api").push({ ...orig, tag: "stable" });
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "411", digest: orig.digest }, "owner");
    expect(r.outcome).toBe("verified");
    expect(r.message).toContain("tags 411, stable");
    expect(tags("miplata/api").some((t) => t.digest === orig.digest)).toBe(false);
  });

  test("refuses latest and every tag on the manifest latest points to, without sending DELETE", async () => {
    const { actions, rows } = rig();
    const latest = find("judicabot/judicabot", "latest");
    const sha = find("judicabot/judicabot", "c19ab44");
    expect(sha.digest).toBe(latest.digest);
    const a = await actions.deleteManifest({ repo: "judicabot/judicabot", tag: "latest", digest: latest.digest }, "owner");
    expect(a).toMatchObject({ ok: false, outcome: "rejected" });
    expect(a.message).toContain("latest is never deleted");
    const b = await actions.deleteManifest({ repo: "judicabot/judicabot", tag: "c19ab44", digest: sha.digest }, "owner");
    expect(b).toMatchObject({ ok: false, outcome: "rejected" });
    expect(b.message).toContain("shares its manifest with latest");
    expect(zot.deletes).toEqual([]);
    expect(rows().filter((x) => x.outcome === "rejected").length).toBe(2);
  });

  test("the latest check uses a fresh HEAD, not the tag listing", async () => {
    const target = find("miplata/api", "410").digest;
    const stub = {
      catalog: async () => ["miplata/api"],
      repoInfo: async () => ({ name: "miplata/api", sizeBytes: 1, lastUpdated: null, tags: [{ tag: "410", digest: target, lastUpdated: null, sizeBytes: 1 }] }),
      manifestDigest: async (_r: string, ref: string) => (ref === "latest" ? target : null),
      deleteManifest: async () => {
        throw new Error("must not be reached");
      },
    } as unknown as ZotClient;
    const { actions } = rig(stub);
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: target }, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "rejected" });
    expect(r.message).toContain("shares its manifest with latest");
  });

  test("a tag that moved since the dialog was shown is rejected", async () => {
    const { actions } = rig();
    const old = find("miplata/api", "410");
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: find("miplata/api", "411").digest }, "owner");
    expect(r.outcome).toBe("rejected");
    expect(r.message).toContain("different manifest");
    expect(find("miplata/api", "410")).toEqual(old);
    expect(zot.deletes).toEqual([]);
  });

  test("unknown repositories, vanished tags and malformed input are rejected", async () => {
    const { actions } = rig();
    const digest = `sha256:${"a".repeat(64)}`;
    expect((await actions.deleteManifest({ repo: "nope/nope", tag: "x", digest }, "o")).message).toContain("not in the registry");
    expect((await actions.deleteManifest({ repo: "miplata/api", tag: "ghost", digest }, "o")).message).toContain("no longer exists");
    expect((await actions.deleteManifest({ repo: "Bad Repo", tag: "x", digest }, "o")).message).toContain("invalid repository");
    expect((await actions.deleteManifest({ repo: "miplata/api", tag: "a b", digest }, "o")).message).toContain("invalid tag");
    expect((await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: "sha256:zz" }, "o")).message).toContain("invalid digest");
    expect(zot.deletes).toEqual([]);
  });

  test("Zot accepting the delete but still serving the manifest is reported as unverified", async () => {
    zot.ignoreDeletes(true);
    const { actions } = rig();
    const d = find("miplata/api", "410").digest;
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: d }, "o");
    expect(r).toMatchObject({ ok: false, outcome: "unverified" });
    expect(r.message).toContain("still readable");
  });

  test("a failing DELETE becomes a failed outcome carrying Zot's reason", async () => {
    const d = find("miplata/api", "410").digest;
    const real = client;
    const stub = Object.create(real) as ZotClient;
    stub.deleteManifest = async () => {
      throw new ZotError(405, "zot DELETE /v2/miplata/api/manifests/x: HTTP 405 (method not allowed)");
    };
    const { actions, rows } = rig(stub);
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: d }, "o");
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.message).toContain("405");
    expect(rows().at(-1)!.outcome).toBe("failed");
  });

  test("a second action on the same repository while one runs is busy", async () => {
    const d = find("miplata/api", "410").digest;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = Object.create(client) as ZotClient;
    slow.deleteManifest = async (repo, digest) => {
      await gate;
      return client.deleteManifest(repo, digest);
    };
    const { actions } = rig(slow);
    const first = actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: d }, "o");
    await Bun.sleep(30);
    expect(actions.locked("miplata/api")).toBe(true);
    const second = await actions.deleteManifest({ repo: "miplata/api", tag: "411", digest: find("miplata/api", "411").digest }, "o");
    expect(second.outcome).toBe("busy");
    release();
    expect((await first).outcome).toBe("verified");
    expect(actions.locked("miplata/api")).toBe(false);
  });

  test("a changed latest after the delete is flagged as a failure", async () => {
    const d = find("miplata/api", "410").digest;
    const flip = Object.create(client) as ZotClient;
    flip.deleteManifest = async (repo, digest) => {
      await client.deleteManifest(repo, digest);
      const l = tags("miplata/api").find((t) => t.tag === "latest")!;
      l.digest = `sha256:${"b".repeat(64)}`;
    };
    const { actions } = rig(flip);
    const r = await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: d }, "o");
    expect(r).toMatchObject({ ok: false, outcome: "failed" });
    expect(r.message).toContain("latest changed");
  });

  test("the registry snapshot is refreshed after an action", async () => {
    const store = new Store();
    registerZotSources(store, client, { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 1000 });
    await store.refresh(ZOT_SOURCES.repos);
    const { actions } = rig(client, store);
    const d = find("miplata/api", "410").digest;
    await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: d }, "o");
    await Bun.sleep(50);
    const repo = store.peek<{ repos: { name: string; tags: RegistryTag[] }[] }>(ZOT_SOURCES.repos).data!.repos.find((r) => r.name === "miplata/api")!;
    expect(repo.tags.some((t) => t.tag === "410")).toBe(false);
  });

  test("the rollback tag snapshot is refreshed too, so a deleted build is not offered", async () => {
    const store = new Store();
    const base = { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 1000 };
    registerZotSources(store, client, base);
    registerZotTagSource(store, new ZotTagsClient(zot.url, "ci", REGISTRY_PASSWORD), () => ["miplata/api"], base);
    await store.refresh(ZOT_TAG_SOURCE);
    const { actions } = rig(client, store);
    const d = find("miplata/api", "410").digest;
    await actions.deleteManifest({ repo: "miplata/api", tag: "410", digest: d }, "o");
    const seen = store.peek<Record<string, { tag: string }[] | null>>(ZOT_TAG_SOURCE).data!["miplata/api"]!;
    expect(seen.some((t) => t.tag === "410")).toBe(false);
  });
});
