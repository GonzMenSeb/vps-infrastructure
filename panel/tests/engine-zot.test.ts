import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketEngine, encodeRegistryAuth } from "../src/actions/engine";
import { DockerClient } from "../src/collectors/docker";
import { ZOT_TAG_SOURCE, ZotTagsClient, registerZotTagSource } from "../src/collectors/zot-tags";
import { Store } from "../src/store";
import { FakeDocker } from "./dev/docker-fixture";
import { REGISTRY_HOST, REGISTRY_PASSWORD, REGISTRY_USER, digestOf } from "./dev/registry-fixture";
import { startFakeRollbackZot, type FakeRollbackZot } from "./dev/zot-rollback-fixture";

let dir: string;
let docker: FakeDocker;
let server: ReturnType<typeof Bun.serve>;
let engine: SocketEngine;
let zot: FakeRollbackZot;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vesp-eng-"));
  docker = new FakeDocker();
  server = Bun.serve({ unix: join(dir, "d.sock"), fetch: (req) => docker.handle(req) });
  engine = new SocketEngine(new DockerClient(join(dir, "d.sock")));
  zot = startFakeRollbackZot();
});
afterAll(async () => {
  await server.stop(true);
  await zot.stop();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { username: REGISTRY_USER, password: REGISTRY_PASSWORD, serveraddress: REGISTRY_HOST };

describe("encodeRegistryAuth", () => {
  test("is padded base64url of the JSON auth config, the way docker encodes it", () => {
    const enc = encodeRegistryAuth({ username: "ci", password: "p>>?~", serveraddress: "zot.example.test" });
    expect(enc).not.toMatch(/[+/]/);
    expect(enc.length % 4).toBe(0);
    const back = Buffer.from(enc.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    expect(JSON.parse(back)).toEqual({ username: "ci", password: "p>>?~", serveraddress: "zot.example.test" });
  });
});

describe("SocketEngine", () => {
  test("lists containers through the collector", async () => {
    const cs = await engine.containers();
    expect(cs.find((c) => c.name === "judicabot")).toMatchObject({ state: "running", composeDir: "/opt/judicabot", image: `${REGISTRY_HOST}/judicabot/judicabot:latest` });
  });

  test("inspects a local image by reference and returns null for an unknown one", async () => {
    const img = await engine.inspectImage(`${REGISTRY_HOST}/judicabot/judicabot:latest`);
    expect(img?.id).toBe(digestOf("judicabot/judicabot", "c19ab44"));
    expect(await engine.inspectImage(`${REGISTRY_HOST}/judicabot/judicabot:3ee016f`)).toBeNull();
  });

  test("pulls with the registry auth header and the image becomes available", async () => {
    await engine.pullImage(`${REGISTRY_HOST}/judicabot/judicabot`, "3ee016f", auth, 5000);
    const call = docker.calls.find((c) => c.path.startsWith("/images/create"))!;
    expect(call.path).toBe(`/images/create?fromImage=${REGISTRY_HOST}/judicabot/judicabot&tag=3ee016f`);
    expect(call.auth).toEqual({ username: "ci", serveraddress: REGISTRY_HOST, accepted: true });
    expect((await engine.inspectImage(`${REGISTRY_HOST}/judicabot/judicabot:3ee016f`))?.id).toBe(digestOf("judicabot/judicabot", "3ee016f"));
  });

  test("an error inside the 200 progress stream rejects the pull", async () => {
    await expect(engine.pullImage(`${REGISTRY_HOST}/judicabot/judicabot`, "nonexistent", auth, 5000)).rejects.toThrow(/pull of .* failed: manifest for/);
    await expect(engine.pullImage(`${REGISTRY_HOST}/judicabot/judicabot`, "3ee016f", { ...auth, password: "wrong" }, 5000)).rejects.toThrow(/unauthorized/);
  });

  test("tags by id and by reference, and refuses an unknown image", async () => {
    await engine.tagImage(digestOf("judicabot/judicabot", "3ee016f"), `${REGISTRY_HOST}/judicabot/judicabot`, "keep");
    expect(docker.tagOf(`${REGISTRY_HOST}/judicabot/judicabot:keep`)).toBe(digestOf("judicabot/judicabot", "3ee016f"));
    await expect(engine.tagImage("sha256:" + "0".repeat(64), `${REGISTRY_HOST}/judicabot/judicabot`, "x")).rejects.toThrow(/HTTP 404/);
  });
});

describe("ZotTagsClient", () => {
  const client = () => new ZotTagsClient(zot.url, REGISTRY_USER, REGISTRY_PASSWORD);

  test("reads tags, digests, config digests and push times, keeping a null date as null", async () => {
    const tags = (await client().repoTags("judicabot/judicabot"))!;
    expect(tags.map((t) => t.tag).sort()).toEqual(["32f1bd4", "3ee016f", "6597a89", "buildcache", "c19ab44", "latest"]);
    expect(tags.find((t) => t.tag === "buildcache")!.lastUpdated).toBeNull();
    expect(tags.find((t) => t.tag === "latest")).toMatchObject({ digest: digestOf("judicabot/judicabot", "c19ab44") });
    expect(tags.find((t) => t.tag === "latest")!.configDigests).toHaveLength(1);
  });

  test("sends the Basic credentials and asks only for verified fields", async () => {
    await client().repoTags("coros/huella");
    const last = zot.requests.at(-1)!;
    expect(last).toMatchObject({ repo: "coros/huella", authorized: true });
  });

  test("a repository missing from the registry is null, not an error", async () => {
    expect(await client().repoTags("miplata/api")).toBeNull();
  });

  test("bad credentials and server errors throw", async () => {
    await expect(new ZotTagsClient(zot.url, REGISTRY_USER, "wrong").repoTags("coros/huella")).rejects.toThrow(/HTTP 401/);
    zot.failing.value = true;
    await expect(client().repoTags("coros/huella")).rejects.toThrow(/HTTP 500/);
    zot.failing.value = false;
  });

  test("rejects a repository name that could break out of the query", async () => {
    await expect(client().repoTags('x"){ evil }')).rejects.toThrow(/invalid repository name/);
  });

  test("registers a store source that fetches every repository once", async () => {
    const store = new Store();
    registerZotTagSource(store, client(), () => ["judicabot/judicabot", "miplata/api"], { timeoutMs: 2000, failureThreshold: 3, cooldownMs: 1000 });
    const snap = await store.refresh<Record<string, unknown>>(ZOT_TAG_SOURCE);
    expect(snap.lastError).toBeNull();
    expect(Object.keys(snap.data!)).toEqual(["judicabot/judicabot", "miplata/api"]);
    expect(snap.data!["miplata/api"]).toBeNull();
  });
});
