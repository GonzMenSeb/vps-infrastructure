import { afterEach, describe, expect, test } from "bun:test";
import { actionsRig, type Rig } from "./actions-rig";

let rig: Rig;
afterEach(async () => {
  await rig?.stop();
});

const writes = (r: Rig) => r.docker.calls.filter((c) => c.method === "POST");

describe("switch off", () => {
  test("runs compose stop in the manifest dir, verifies the container is stopped and audits both rows", async () => {
    rig = await actionsRig();
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    expect(rig.compose.commands).toEqual([{ dir: "/opt/vaultwarden", args: ["stop"] }]);
    expect(rig.docker.container("vaultwarden").state).toBe("exited");
    expect(rig.audit()).toEqual([
      { actor: "owner", action: "service.switch", target: "vaultwarden", outcome: "requested", detail: "off: cd /opt/vaultwarden && docker compose stop" },
      { actor: "owner", action: "service.switch", target: "vaultwarden", outcome: "verified", detail: expect.stringContaining("switched off") },
    ]);
    expect(rig.locks.has("vaultwarden")).toBe(false);
  });

  test("stops every container of a multi-container compose project", async () => {
    rig = await actionsRig();
    const r = await rig.switching.switchService("metabase", "off", "owner");
    expect(r.outcome).toBe("verified");
    expect(rig.docker.container("metabase").state).toBe("exited");
    expect(rig.docker.container("metabase-db").state).toBe("exited");
  });

  test("a service that is already off is rejected without running compose", async () => {
    rig = await actionsRig();
    await rig.switching.switchService("vaultwarden", "off", "owner");
    rig.compose.commands.length = 0;
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("already switched off") });
    expect(rig.compose.commands).toEqual([]);
  });

  test("reports failed when the containers are still running after compose succeeded", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 3000 });
    rig.compose.failures.push({ match: (a) => a[0] === "stop", result: { code: 0, stdout: "", stderr: "", timedOut: false } });
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("vaultwarden still running") });
    expect(rig.docker.container("vaultwarden").state).toBe("running");
  });

  test("a failing compose command is a failure with the stderr tail and nothing is verified", async () => {
    rig = await actionsRig();
    rig.compose.failures.push({ match: () => true, result: { code: 1, stdout: "", stderr: "no configuration file provided: not found", timedOut: false } });
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("exited with 1: no configuration file") });
  });

  test("a compose command that times out is reported as killed", async () => {
    rig = await actionsRig();
    rig.compose.failures.push({ match: () => true, result: { code: 137, stdout: "", stderr: "", timedOut: true } });
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("was killed") });
  });

  test("an unreadable Docker after the command is unverified rather than failed", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 2000 });
    const original = rig.compose.run.bind(rig.compose);
    rig.compose.run = async (dir, args) => {
      const res = await original(dir, args);
      rig.docker.unreadable.value = true;
      return res;
    };
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "unverified", message: expect.stringContaining("could not be checked") });
  });
});

describe("switch on", () => {
  test("starts a stopped service and waits until it is healthy", async () => {
    rig = await actionsRig();
    await rig.switching.switchService("vaultwarden", "off", "owner");
    const r = await rig.switching.switchService("vaultwarden", "on", "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    expect(rig.compose.commands.at(-1)).toEqual({ dir: "/opt/vaultwarden", args: ["up", "-d"] });
    expect(rig.docker.container("vaultwarden").state).toBe("running");
  });

  test("a container that never becomes healthy is a failure", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 8000 });
    await rig.switching.switchService("vaultwarden", "off", "owner");
    rig.docker.unhealthyImages.add(rig.docker.container("vaultwarden").imageId);
    const r = await rig.switching.switchService("vaultwarden", "on", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("vaultwarden is unhealthy") });
  });

  test("a crash looping container is a failure even without a healthcheck", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 8000 });
    await rig.switching.switchService("metabase", "off", "owner");
    rig.docker.crashImages.add(rig.docker.container("metabase").imageId);
    const r = await rig.switching.switchService("metabase", "on", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("metabase is restarting") });
  });

  test("a service that is already up and healthy is rejected", async () => {
    rig = await actionsRig();
    const r = await rig.switching.switchService("vaultwarden", "on", "owner");
    expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("already running") });
    expect(rig.compose.commands).toEqual([]);
  });
});

describe("what the panel refuses to touch", () => {
  test("core services are forbidden in both directions and compose never runs", async () => {
    rig = await actionsRig();
    for (const id of ["traefik", "zot", "dns", "panel"]) {
      for (const to of ["off", "on"] as const) {
        expect(await rig.switching.switchService(id, to, "owner")).toMatchObject({ ok: false, outcome: "rejected", code: "forbidden" });
      }
    }
    expect(rig.compose.commands).toEqual([]);
    expect(rig.docker.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(rig.audit().filter((a) => a.outcome === "requested")).toEqual([]);
  });

  test("jenkins host services are forbidden", async () => {
    rig = await actionsRig();
    expect(await rig.switching.switchService("jenkins", "off", "owner")).toMatchObject({ outcome: "rejected", code: "forbidden" });
    expect(rig.compose.commands).toEqual([]);
  });

  test("an unknown service is not found and its id is sanitized in the audit log", async () => {
    rig = await actionsRig();
    const r = await rig.switching.switchService("../etc/passwd; rm -rf /", "off", "owner");
    expect(r).toMatchObject({ outcome: "rejected", code: "not_found" });
    expect(rig.audit()[0]).toMatchObject({ target: "..?etc?passwd??rm?-rf??", outcome: "rejected" });
    expect(rig.compose.commands).toEqual([]);
  });

  test("a container from another compose directory blocks the run", async () => {
    rig = await actionsRig();
    const original = rig.docker.list.bind(rig.docker);
    rig.docker.list = () => original().map((c) => ((c as { Names: string[] }).Names[0] === "/vaultwarden" ? { ...(c as object), Labels: { "com.docker.compose.project.working_dir": "/srv/other" } } : c));
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ outcome: "rejected", message: expect.stringContaining("/srv/other") });
    expect(rig.compose.commands).toEqual([]);
  });
});

describe("locking", () => {
  test("a second action on the same service is busy while the first is still verifying", async () => {
    rig = await actionsRig();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = rig.compose.run.bind(rig.compose);
    rig.compose.run = async (dir, args) => {
      await gate;
      return original(dir, args);
    };
    const first = rig.switching.switchService("vaultwarden", "off", "owner");
    await Bun.sleep(30);
    expect(rig.switching.locked("vaultwarden")).toBe(true);
    expect(await rig.switching.switchService("vaultwarden", "off", "owner")).toMatchObject({ ok: false, outcome: "busy" });
    expect(await rig.rollback.rollback("vaultwarden", { to: "x", digest: "sha256:" + "0".repeat(64) }, "owner")).toMatchObject({ outcome: "busy" });
    release();
    expect((await first).outcome).toBe("verified");
    expect(rig.switching.locked("vaultwarden")).toBe(false);
  });

  test("different services do not block each other", async () => {
    rig = await actionsRig();
    const [a, b] = await Promise.all([rig.switching.switchService("vaultwarden", "off", "owner"), rig.switching.switchService("metabase", "off", "owner")]);
    expect([a.outcome, b.outcome]).toEqual(["verified", "verified"]);
  });
});

describe("dry run", () => {
  test("records the request and executes nothing", async () => {
    rig = await actionsRig({ dryRun: true });
    const r = await rig.switching.switchService("vaultwarden", "off", "owner");
    expect(r).toMatchObject({ ok: true, outcome: "dry-run", message: expect.stringContaining("cd /opt/vaultwarden && docker compose stop") });
    expect(rig.compose.commands).toEqual([]);
    expect(writes(rig)).toEqual([]);
    expect(rig.docker.container("vaultwarden").state).toBe("running");
    expect(rig.audit().map((a) => a.outcome)).toEqual(["requested", "dry-run"]);
  });
});
