import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketEngine } from "../src/actions/engine";
import { RollbackActions } from "../src/actions/rollback";
import { ActionRuntime, ServiceActions, ServiceLocks } from "../src/actions/service";
import { DockerClient } from "../src/collectors/docker";
import { ZotTagsClient } from "../src/collectors/zot-tags";
import { openDb } from "../src/db";
import { loadManifest } from "../src/manifest";
import { FakeCompose, FakeDocker } from "./dev/docker-fixture";
import { REGISTRY_HOST, REGISTRY_PASSWORD, REGISTRY_USER, digestOf } from "./dev/registry-fixture";
import { startFakeRollbackZot, type FakeRollbackZot } from "./dev/zot-rollback-fixture";

export interface Rig {
  docker: FakeDocker;
  compose: FakeCompose;
  zot: FakeRollbackZot;
  db: Database;
  locks: ServiceLocks;
  runtime: ActionRuntime;
  switching: ServiceActions;
  rollback: RollbackActions;
  clock: { now: () => number; advance: (ms: number) => void };
  audit: () => { actor: string; action: string; target: string; outcome: string; detail: string | null }[];
  stop: () => Promise<void>;
}

export interface RigOptions {
  dryRun?: boolean;
  healthDelayMs?: number;
  verifyTimeoutMs?: number;
  stableMs?: number;
  credentials?: boolean;
  engineTimeoutMs?: number;
}

export async function actionsRig(o: RigOptions = {}): Promise<Rig> {
  let t = Date.now();
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const docker = new FakeDocker({ now: clock.now, healthDelayMs: o.healthDelayMs ?? 3000 });
  const dir = mkdtempSync(join(tmpdir(), "vesp-act-"));
  const socket = join(dir, "docker.sock");
  const server = Bun.serve({ unix: socket, fetch: (req) => docker.handle(req) });
  const zot = startFakeRollbackZot({ now: clock.now });
  const compose = new FakeCompose(docker);
  const db = openDb(":memory:");
  const manifest = await loadManifest("tests/fixtures/dev-services.json");
  const locks = new ServiceLocks();
  const runtime = new ActionRuntime({
    db,
    manifest,
    engine: new SocketEngine(new DockerClient(socket), o.engineTimeoutMs),
    compose,
    locks,
    dryRun: o.dryRun ?? false,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    verifyTimeoutMs: o.verifyTimeoutMs ?? 20_000,
    pollMs: 1000,
    stableMs: o.stableMs ?? 3000,
  });
  const zotClient = new ZotTagsClient(zot.url, REGISTRY_USER, REGISTRY_PASSWORD);
  return {
    docker,
    compose,
    zot,
    db,
    locks,
    runtime,
    switching: new ServiceActions(runtime),
    rollback: new RollbackActions({
      runtime,
      registryHost: REGISTRY_HOST,
      tags: (repo) => zotClient.repoTags(repo),
      credentials: o.credentials === false ? null : { user: REGISTRY_USER, password: REGISTRY_PASSWORD },
    }),
    clock,
    audit: () => db.query<{ actor: string; action: string; target: string; outcome: string; detail: string | null }, []>("SELECT actor, action, target, outcome, detail FROM audit ORDER BY id").all(),
    stop: async () => {
      await server.stop(true);
      await zot.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const JUDICABOT = {
  repo: "judicabot/judicabot",
  current: { tag: "c19ab44", digest: digestOf("judicabot/judicabot", "c19ab44") },
  previous: { tag: "3ee016f", digest: digestOf("judicabot/judicabot", "3ee016f") },
  older: { tag: "32f1bd4", digest: digestOf("judicabot/judicabot", "32f1bd4") },
  ref: `${REGISTRY_HOST}/judicabot/judicabot`,
};
