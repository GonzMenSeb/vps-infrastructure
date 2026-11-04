import type { Database } from "bun:sqlite";
import { audit } from "../db";
import {
  DIGEST,
  LATEST_TAG,
  REPO_NAME,
  TAG_NAME,
  ZOT_SOURCES,
  tagsOnDigest,
  type RegistryTag,
  type ZotClient,
} from "../collectors/zot";
import { ZOT_TAG_SOURCE } from "../collectors/zot-tags";
import type { Store } from "../store";
import { errMessage, KeyedLocks, type ActionResult } from "./result";

export interface RegistryActionDeps {
  client: ZotClient;
  db: Database;
  store?: Store;
  verifyAttempts?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeleteManifestInput {
  repo: string;
  tag: string;
  digest: string;
}

export const GC_NOTE = "disk space returns when Zot's scheduled garbage collection runs";

export class RegistryActions {
  private locks = new KeyedLocks();
  private verifyAttempts: number;
  private pollMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: RegistryActionDeps) {
    this.verifyAttempts = deps.verifyAttempts ?? 3;
    this.pollMs = deps.pollMs ?? 250;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  locked(repo: string): boolean {
    return this.locks.has(repo);
  }

  async deleteManifest(input: DeleteManifestInput, actor: string): Promise<ActionResult> {
    const { repo, tag, digest } = input;
    const target = `${repo}@${digest}`;
    const record = (r: ActionResult): ActionResult => {
      audit(this.deps.db, { actor, action: "registry.delete", target, outcome: r.outcome, detail: r.message });
      return r;
    };
    if (!REPO_NAME.test(repo)) return record({ ok: false, outcome: "rejected", message: `invalid repository name ${repo}` });
    if (!TAG_NAME.test(tag)) return record({ ok: false, outcome: "rejected", message: `invalid tag ${tag}` });
    if (!DIGEST.test(digest)) return record({ ok: false, outcome: "rejected", message: `invalid digest ${digest}` });
    if (this.locks.has(repo)) return record({ ok: false, outcome: "busy", message: `another action on ${repo} is in progress` });
    return this.locks.run(repo, async () => {
      audit(this.deps.db, { actor, action: "registry.delete", target, outcome: "requested", detail: `tag ${tag}` });
      try {
        return record(await this.run(input));
      } catch (err) {
        return record({ ok: false, outcome: "failed", message: errMessage(err) });
      } finally {
        const { store } = this.deps;
        if (store) {
          const known = store.names();
          await Promise.all([ZOT_SOURCES.repos, ZOT_TAG_SOURCE].filter((n) => known.includes(n)).map((n) => store.refresh(n).catch(() => {})));
        }
      }
    });
  }

  private async run({ repo, tag, digest }: DeleteManifestInput): Promise<ActionResult> {
    const { client } = this.deps;
    if (!(await client.catalog()).includes(repo)) return { ok: false, outcome: "rejected", message: `${repo} is not in the registry` };
    const before = (await client.repoInfo(repo)).tags;
    const current = before.find((t) => t.tag === tag);
    if (!current) return { ok: false, outcome: "rejected", message: `tag ${tag} no longer exists in ${repo}` };
    if (current.digest !== digest) {
      return { ok: false, outcome: "rejected", message: `${tag} now points to a different manifest than the one you reviewed; reload the page and review again` };
    }
    const latestNow = await client.manifestDigest(repo, LATEST_TAG);
    const latestListed = before.find((t) => t.tag === LATEST_TAG)?.digest ?? null;
    if (latestNow === digest || latestListed === digest) {
      return {
        ok: false,
        outcome: "rejected",
        message: tag === LATEST_TAG ? "latest is never deleted from here" : `${tag} shares its manifest with latest, and deleting a manifest removes every tag on it, latest included`,
      };
    }
    const affected = tagsOnDigest(before, digest);
    await client.deleteManifest(repo, digest);
    const gone = await this.waitGone(repo, digest);
    const latestAfter = await client.manifestDigest(repo, LATEST_TAG);
    if (latestNow !== null && latestAfter !== latestNow) {
      return { ok: false, outcome: "failed", message: `${repo}:latest changed during the delete; check the registry` };
    }
    const names = affected.map((t: RegistryTag) => t.tag).join(", ");
    if (!gone) {
      return { ok: false, outcome: "unverified", message: `Zot accepted the delete but ${digest.slice(0, 19)} is still readable (${names})` };
    }
    const remaining = (await client.repoInfo(repo)).tags;
    if (tagsOnDigest(remaining, digest).length > 0) {
      return { ok: false, outcome: "unverified", message: `the manifest is gone but the tag listing still shows ${names}` };
    }
    return {
      ok: true,
      outcome: "verified",
      message: `deleted ${affected.length === 1 ? "tag" : "tags"} ${names} from ${repo}; ${GC_NOTE}`,
    };
  }

  private async waitGone(repo: string, digest: string): Promise<boolean> {
    for (let i = 0; i < this.verifyAttempts; i++) {
      if ((await this.deps.client.manifestDigest(repo, digest)) === null) return true;
      if (i < this.verifyAttempts - 1) await this.sleep(this.pollMs);
    }
    return false;
  }
}
