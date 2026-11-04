import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCKER_SOURCES,
  DockerClient,
  fetchContainers,
  fetchDiskUsage,
  parseHealth,
  registerDockerSources,
} from "../src/collectors/docker";
import { Store } from "../src/store";

const list = [
  {
    Id: "bbb", Names: ["/traefik"], Image: "traefik:v3.1", ImageID: "sha256:aaa", State: "running", Status: "Up 3 hours (healthy)",
    Labels: {
      "com.docker.compose.project": "traefik",
      "com.docker.compose.service": "traefik",
      "org.opencontainers.image.revision": "0f3c9a1",
      "traefik.enable": "true",
      "traefik.http.routers.dash.rule": "Host(`traefik.example.test`)",
    },
    Mounts: [{ Type: "bind", Source: "/x" }, { Type: "volume", Name: "acme" }],
  },
  {
    Id: "aaa", Names: ["/miplata-api"], Image: "zot/miplata:latest", ImageID: "sha256:bbb", State: "exited", Status: "Exited (1) 2 days ago",
    Labels: null, Mounts: null,
  },
];

const df = {
  LayersSize: 1,
  Images: [],
  Containers: [
    { Id: "bbb", Names: ["/traefik"], SizeRw: 4096, SizeRootFs: 100, Mounts: [{ Type: "volume", Name: "acme" }] },
    { Id: "aaa", Names: ["/miplata-api"], SizeRootFs: 200 },
  ],
  Volumes: [
    { Name: "pgdata", UsageData: { RefCount: 1, Size: 5000 } },
    { Name: "acme", UsageData: { RefCount: 1, Size: 12 } },
    { Name: "unknown", UsageData: { RefCount: -1, Size: -1 } },
  ],
  BuildCache: [],
};

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let client: DockerClient;
const paths: string[] = [];
let failDf = false;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vesp-docker-"));
  const sock = join(dir, "docker.sock");
  server = Bun.serve({
    unix: sock,
    fetch(req) {
      const u = new URL(req.url);
      paths.push(u.pathname + u.search);
      if (u.pathname === "/containers/json") return Response.json(list);
      if (u.pathname === "/system/df") return failDf ? new Response("boom", { status: 500 }) : Response.json(df);
      return new Response("nf", { status: 404 });
    },
  });
  client = new DockerClient(sock);
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("parseHealth", () => {
  test("derives health from the Status string", () => {
    expect(parseHealth("Up 3 hours (healthy)")).toBe("healthy");
    expect(parseHealth("Up 3 hours (unhealthy)")).toBe("unhealthy");
    expect(parseHealth("Up Less than a second (health: starting)")).toBe("starting");
    expect(parseHealth("Up 32 hours")).toBe("none");
    expect(parseHealth("Exited (0) 7 days ago")).toBe("none");
  });
});

describe("fetchContainers", () => {
  test("lists all containers over the unix socket with state, health, image, traefik labels, volumes", async () => {
    paths.length = 0;
    const cs = await fetchContainers(client);
    expect(paths).toEqual(["/containers/json?all=true"]);
    expect(cs.map((c) => c.name)).toEqual(["miplata-api", "traefik"]);
    const t = cs[1]!;
    expect(t).toMatchObject({
      id: "bbb", image: "traefik:v3.1", imageId: "sha256:aaa", state: "running", health: "healthy",
      composeProject: "traefik", composeService: "traefik", revision: "0f3c9a1", volumes: ["acme"],
    });
    expect(t.traefik).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.dash.rule": "Host(`traefik.example.test`)",
    });
    expect(cs[0]).toMatchObject({ state: "exited", health: "none", composeProject: null, revision: null, traefik: {}, volumes: [] });
  });
});

describe("fetchDiskUsage", () => {
  test("per-container SizeRw (missing = 0), volume sizes, and container volume mapping", async () => {
    const d = await fetchDiskUsage(client);
    expect(d.containers).toEqual([
      { name: "miplata-api", sizeRw: 0, sizeRootFs: 200, volumes: [] },
      { name: "traefik", sizeRw: 4096, sizeRootFs: 100, volumes: ["acme"] },
    ]);
    expect(d.volumes).toEqual([
      { name: "acme", sizeBytes: 12, refCount: 1 },
      { name: "pgdata", sizeBytes: 5000, refCount: 1 },
      { name: "unknown", sizeBytes: null, refCount: null },
    ]);
  });

  test("HTTP errors surface", async () => {
    failDf = true;
    await expect(fetchDiskUsage(client)).rejects.toThrow(/HTTP 500/);
    failDf = false;
  });

  test("a missing socket is an error, not a hang", async () => {
    await expect(fetchContainers(new DockerClient(join(dir, "missing.sock")))).rejects.toThrow();
  });
});

describe("registerDockerSources", () => {
  test("containers refresh every 5s, df every 5 min", async () => {
    let t = 1_000_000;
    const store = new Store(() => t);
    registerDockerSources(store, client, { timeoutMs: 1000, failureThreshold: 3, cooldownMs: 1000 });
    expect(store.names().sort()).toEqual(Object.values(DOCKER_SOURCES).sort());
    await store.refresh(DOCKER_SOURCES.containers);
    await store.refresh(DOCKER_SOURCES.df);
    t += 6_000;
    expect(store.get(DOCKER_SOURCES.containers).stale).toBe(true);
    expect(store.get(DOCKER_SOURCES.df).stale).toBe(false);
    t += 300_000;
    expect(store.get(DOCKER_SOURCES.df).stale).toBe(true);
  });
});
