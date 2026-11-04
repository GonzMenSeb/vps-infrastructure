import { afterEach, describe, expect, test } from "bun:test";
import { JUDICABOT, actionsRig, type Rig } from "./actions-rig";
import { REGISTRY_PASSWORD } from "./dev/registry-fixture";

let rig: Rig;
afterEach(async () => {
  await rig?.stop();
});

const toPrevious = { to: JUDICABOT.previous.tag, digest: JUDICABOT.previous.digest };
const writes = (r: Rig) => r.docker.calls.filter((c) => c.method === "POST").map((c) => c.path);
const latest = (r: Rig) => r.docker.tagOf(`${JUDICABOT.ref}:latest`);

describe("rollback", () => {
  test("pulls the previous tag, keeps the old one tagged, retags latest, recreates and verifies", async () => {
    rig = await actionsRig();
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified", message: expect.stringContaining("now runs 3ee016f (was c19ab44)") });
    expect(writes(rig)).toEqual([
      `/images/create?fromImage=${JUDICABOT.ref}&tag=3ee016f`,
      `/images/${JUDICABOT.current.digest}/tag?repo=${JUDICABOT.ref}&tag=c19ab44`,
      `/images/${JUDICABOT.previous.digest}/tag?repo=${JUDICABOT.ref}&tag=latest`,
    ]);
    expect(rig.compose.commands).toEqual([{ dir: "/opt/judicabot", args: ["up", "-d", "--pull", "never"] }]);
    expect(latest(rig)).toBe(JUDICABOT.previous.digest);
    expect(rig.docker.tagOf(`${JUDICABOT.ref}:c19ab44`)).toBe(JUDICABOT.current.digest);
    expect(rig.docker.container("judicabot")).toEqual({ state: "running", imageId: JUDICABOT.previous.digest });
  });

  test("authenticates the pull with the registry credentials and never records them", async () => {
    rig = await actionsRig();
    await rig.rollback.rollback("judicabot", toPrevious, "owner");
    const pull = rig.docker.calls.find((c) => c.path.startsWith("/images/create"))!;
    expect(pull.auth).toEqual({ username: "ci", serveraddress: "zot.web.example.test", accepted: true });
    expect(JSON.stringify(rig.audit())).not.toContain(REGISTRY_PASSWORD);
  });

  test("audits the request and the verified outcome", async () => {
    rig = await actionsRig();
    await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(rig.audit().map((a) => [a.action, a.target, a.outcome])).toEqual([
      ["service.rollback", "judicabot", "requested"],
      ["service.rollback", "judicabot", "verified"],
    ]);
    expect(rig.audit()[0]!.detail).toContain("3ee016f");
  });

  test("the next rollback goes one build further back, and the same one again is refused as stale", async () => {
    rig = await actionsRig();
    await rig.rollback.rollback("judicabot", toPrevious, "owner");
    const again = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(again).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("previous version is now 32f1bd4") });
    const further = await rig.rollback.rollback("judicabot", { to: JUDICABOT.older.tag, digest: JUDICABOT.older.digest }, "owner");
    expect(further).toMatchObject({ ok: true, outcome: "verified" });
    expect(rig.docker.container("judicabot").imageId).toBe(JUDICABOT.older.digest);
  });

  test("a stale page is refused before anything is written", async () => {
    rig = await actionsRig();
    const r = await rig.rollback.rollback("judicabot", { to: "6597a89", digest: JUDICABOT.previous.digest }, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "rejected", message: expect.stringContaining("registry changed") });
    expect(writes(rig)).toEqual([]);
    expect(rig.compose.commands).toEqual([]);
  });

  test("a build backfilled after the page loaded changes the previous version and is refused", async () => {
    rig = await actionsRig();
    const rows = rig.zot.rows["judicabot/judicabot"]!;
    const between = new Date(Date.now() - 2 * 3_600_000).toISOString();
    rows.push({ tag: "bbbbbbb", digest: "sha256:" + "b".repeat(64), lastUpdated: between, size: 1 });
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ outcome: "rejected", message: expect.stringContaining("previous version is now bbbbbbb") });
    expect(writes(rig)).toEqual([]);
  });
});

describe("auto-revert", () => {
  test("a previous image that never becomes healthy is replaced by the old one", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 8000 });
    rig.docker.unhealthyImages.add(JUDICABOT.previous.digest);
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r.message).toContain("judicabot is unhealthy");
    expect(r).toMatchObject({ ok: false, outcome: "reverted", message: expect.stringContaining("c19ab44 was put back and is up and healthy") });
    expect(latest(rig)).toBe(JUDICABOT.current.digest);
    expect(rig.docker.container("judicabot")).toEqual({ state: "running", imageId: JUDICABOT.current.digest });
    expect(rig.compose.commands.map((c) => c.args.join(" "))).toEqual(["up -d --pull never", "up -d --pull never"]);
    expect(rig.audit().at(-1)).toMatchObject({ outcome: "reverted" });
  });

  test("a crash looping previous image is reverted", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 8000 });
    rig.docker.crashImages.add(JUDICABOT.previous.digest);
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "reverted", message: expect.stringContaining("judicabot is restarting") });
    expect(rig.docker.container("judicabot").imageId).toBe(JUDICABOT.current.digest);
  });

  test("a failing compose up is reverted too", async () => {
    rig = await actionsRig();
    let n = 0;
    rig.compose.failures.push({ match: () => ++n === 1, result: { code: 1, stdout: "", stderr: "container name conflict", timedOut: false } });
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "reverted", message: expect.stringContaining("container name conflict") });
    expect(latest(rig)).toBe(JUDICABOT.current.digest);
  });

  test("when the old image does not come back either, it is a loud failure", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 6000 });
    rig.docker.unhealthyImages.add(JUDICABOT.previous.digest);
    rig.docker.unhealthyImages.add(JUDICABOT.current.digest);
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r.message).toContain("did not bring it up either");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("Check Judicabot now") });
  });

  test("an unreadable Docker after the swap is unverified and is not reverted blindly", async () => {
    rig = await actionsRig({ verifyTimeoutMs: 3000 });
    const original = rig.compose.run.bind(rig.compose);
    rig.compose.run = async (dir, args) => {
      const res = await original(dir, args);
      rig.docker.unreadable.value = true;
      return res;
    };
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "unverified", message: expect.stringContaining("was not reverted") });
    expect(rig.compose.commands).toHaveLength(1);
  });
});

describe("failures before anything changed", () => {
  test("a pull error reported inside the progress stream is a failure and nothing is retagged", async () => {
    rig = await actionsRig();
    rig.docker.pullFailures.set("3ee016f", "unauthorized: authentication required");
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r.message).toContain("unauthorized");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("pull of") });
    expect(writes(rig)).toHaveLength(1);
    expect(rig.compose.commands).toEqual([]);
    expect(latest(rig)).toBe(JUDICABOT.current.digest);
  });

  test("a registry that rejects the credentials fails the pull", async () => {
    rig = await actionsRig({ credentials: false });
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("unauthorized") });
    expect(rig.compose.commands).toEqual([]);
  });

  test("a service whose repository is not in the registry is rejected", async () => {
    rig = await actionsRig();
    delete rig.zot.rows["judicabot/judicabot"];
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ outcome: "rejected", message: expect.stringContaining("not in the registry") });
  });

  test("zot being down is a failure, not a rollback", async () => {
    rig = await actionsRig();
    rig.zot.failing.value = true;
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("HTTP 500") });
    expect(writes(rig)).toEqual([]);
  });
});

describe("what rollback refuses", () => {
  test("core services, the jenkins host and unknown services are forbidden or missing", async () => {
    rig = await actionsRig();
    expect(await rig.rollback.rollback("panel", toPrevious, "owner")).toMatchObject({ outcome: "rejected", code: "forbidden" });
    expect(await rig.rollback.rollback("jenkins", toPrevious, "owner")).toMatchObject({ outcome: "rejected", code: "forbidden" });
    expect(await rig.rollback.rollback("nope", toPrevious, "owner")).toMatchObject({ outcome: "rejected", code: "not_found" });
    expect(writes(rig)).toEqual([]);
  });

  test("services with several registry images or none are rejected", async () => {
    rig = await actionsRig();
    expect(await rig.rollback.rollback("miplata", toPrevious, "owner")).toMatchObject({ outcome: "rejected", message: expect.stringContaining("2 images") });
    expect(await rig.rollback.rollback("vaultwarden", toPrevious, "owner")).toMatchObject({ outcome: "rejected", message: expect.stringContaining("nothing to roll back") });
  });

  test("a service that is switched off must be switched on first", async () => {
    rig = await actionsRig();
    await rig.switching.switchService("judicabot", "off", "owner");
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ outcome: "rejected", message: expect.stringContaining("Judicabot is switched off") });
    expect(writes(rig)).toEqual([]);
  });
});

describe("dry run", () => {
  test("changes nothing: no pull, no tag, no compose", async () => {
    rig = await actionsRig({ dryRun: true });
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: true, outcome: "dry-run", message: expect.stringContaining("from c19ab44 to 3ee016f") });
    expect(writes(rig)).toEqual([]);
    expect(rig.compose.commands).toEqual([]);
    expect(rig.docker.container("judicabot").imageId).toBe(JUDICABOT.current.digest);
  });
});
