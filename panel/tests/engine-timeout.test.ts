import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKER_REQUEST_TIMEOUT_MS, SocketEngine } from "../src/actions/engine";
import { DockerClient } from "../src/collectors/docker";
import { actionsRig, type Rig } from "./actions-rig";
import { FakeDocker } from "./dev/docker-fixture";

let rig: Rig;
afterEach(async () => {
  await rig?.stop();
});

const SHORT = 5000;

describe("docker socket timeouts", () => {
  test("the default is 10 seconds", () => {
    expect(DOCKER_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  test("containers() gives up on a socket that never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vesp-stall-"));
    const docker = new FakeDocker();
    docker.stalled.value = true;
    const server = Bun.serve({ unix: join(dir, "d.sock"), fetch: (req) => docker.handle(req) });
    try {
      const engine = new SocketEngine(new DockerClient(join(dir, "d.sock")), 100);
      const t0 = Date.now();
      await expect(engine.containers()).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(2000);
      await expect(engine.inspectImage("x/y:z")).rejects.toThrow();
      await expect(engine.tagImage("a", "b", "c")).rejects.toThrow();
    } finally {
      await server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, SHORT);

  test("a socket that stalls after compose still reaches the verify deadline and releases the service lock", async () => {
    rig = await actionsRig({ engineTimeoutMs: 50, verifyTimeoutMs: 3000 });
    const run = rig.compose.run.bind(rig.compose);
    rig.compose.run = async (dir, args) => {
      const r = await run(dir, args);
      rig.docker.stalled.value = true;
      return r;
    };
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "unverified", message: expect.stringContaining("docker did not answer") });
    expect(rig.locks.has("vaultwarden")).toBe(false);
    expect(rig.audit().map((a) => a.outcome)).toEqual(["requested", "unverified"]);
    rig.docker.stalled.value = false;
    expect(await rig.switching.switchService("vaultwarden", "off", "owner")).toMatchObject({ outcome: "rejected" });
  }, SHORT);
});
