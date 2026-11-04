import { afterEach, describe, expect, test } from "bun:test";
import { JUDICABOT, actionsRig, type Rig } from "./actions-rig";

let rig: Rig;
afterEach(async () => {
  await rig?.stop();
});

const toPrevious = { to: JUDICABOT.previous.tag, digest: JUDICABOT.previous.digest };
const writes = (r: Rig) => r.docker.calls.filter((c) => c.method === "POST").map((c) => c.path);
const tampered = "sha256:" + "e".repeat(64);

function expectUntouched(r: Rig) {
  expect(writes(r)).toEqual([`/images/create?fromImage=${JUDICABOT.ref}&tag=${JUDICABOT.previous.tag}`]);
  expect(r.compose.commands).toEqual([]);
  expect(r.docker.tagOf(`${JUDICABOT.ref}:latest`)).toBe(JUDICABOT.current.digest);
  expect(r.docker.container("judicabot")).toEqual({ state: "running", imageId: JUDICABOT.current.digest });
  expect(r.locks.has("judicabot")).toBe(false);
}

describe("rollback checks what the pull actually delivered", () => {
  test("a tag that moved in the registry after the page loaded aborts before anything is retagged", async () => {
    rig = await actionsRig();
    rig.docker.pullsAs.set(JUDICABOT.previous.tag, tampered);
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringMatching(/is not the build the registry listed.*nothing was retagged/) });
    expectUntouched(rig);
  });

  test("an image with no repo digest for the registry is refused the same way", async () => {
    rig = await actionsRig();
    rig.docker.noRepoDigests.value = true;
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: false, outcome: "failed", message: expect.stringContaining("is not the build the registry listed") });
    expectUntouched(rig);
  });

  test("the refusal is audited as failed with the same message", async () => {
    rig = await actionsRig();
    rig.docker.pullsAs.set(JUDICABOT.previous.tag, tampered);
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    const rows = rig.audit();
    expect(rows.map((a) => [a.action, a.target, a.outcome])).toEqual([
      ["service.rollback", "judicabot", "requested"],
      ["service.rollback", "judicabot", "failed"],
    ]);
    expect(rows[1]!.detail).toBe(r.message.slice(0, 500));
  });

  test("a pull that delivers the advertised build still rolls back", async () => {
    rig = await actionsRig();
    const r = await rig.rollback.rollback("judicabot", toPrevious, "owner");
    expect(r).toMatchObject({ ok: true, outcome: "verified" });
    const img = await rig.runtime.deps.engine.inspectImage(`${JUDICABOT.ref}:${JUDICABOT.previous.tag}`);
    expect(img?.repoDigests).toContain(`${JUDICABOT.ref}@${JUDICABOT.previous.digest}`);
  });
});
