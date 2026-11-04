import type { DockerContainer } from "../collectors/docker";
import type { Service } from "../manifest";
import type { ImageRef } from "./rollback-select";
import { keepTag, planRollback, rollbackCommands, rollbackTarget, type RegistryTag } from "./rollback-select";
import { checkDir, describeContainer, errMessage, healthOk, rejected, type ActionRuntime, type ServiceActionResult } from "./service";

export interface RollbackExpectation {
  to: string;
  digest: string;
}

export interface RollbackDeps {
  runtime: ActionRuntime;
  registryHost: string | null;
  tags: ((repo: string) => Promise<RegistryTag[] | null>) | null;
  credentials: { user: string; password: string } | null;
}

const UP_ARGS = ["up", "-d", "--pull", "never"] as const;

export class RollbackActions {
  constructor(private d: RollbackDeps) {}

  locked(id: string): boolean {
    return this.d.runtime.locked(id);
  }

  rollback(id: string, expect: RollbackExpectation, actor: string): Promise<ServiceActionResult> {
    return this.d.runtime.guarded("service.rollback", id, actor, `to ${expect.to} (${expect.digest.slice(0, 19)})`, (svc) => this.run(svc, expect));
  }

  private async run(svc: Service, expect: RollbackExpectation): Promise<ServiceActionResult> {
    const rt = this.d.runtime;
    const target = rollbackTarget(svc, this.d.registryHost);
    if (!target.ok) return rejected(target.reason);
    const image = target.image;

    if (!this.d.tags) return rejected("Zot is not configured, so the registry cannot be read");
    const tags = await this.d.tags(image.repo);
    if (tags === null) return rejected(`${image.repo} is not in the registry yet`);
    const byName = await rt.containersByName();
    const found = svc.containers.flatMap((n) => (byName.has(n) ? [byName.get(n)!] : []));
    const stray = checkDir(svc, found);
    if (stray) return rejected(stray);
    const withImage = found.filter((c) => c.image === image.ref);
    const targets = withImage.filter((c) => c.state === "running" || c.state === "restarting");
    if (targets.length === 0) {
      return rejected(
        withImage.length ? `${svc.name} is switched off. Switch it on before rolling it back` : `no container of ${svc.name} is running ${image.ref}, so there is nothing to roll back`,
      );
    }
    const oldId = targets[0]!.imageId;
    if (targets.some((c) => c.imageId !== oldId)) return rejected(`the containers of ${svc.name} run different builds of ${image.ref}`);

    const plan = planRollback(tags, [oldId]);
    if (!plan.ok) return rejected(plan.reason);
    if (plan.previous.tag !== expect.to || plan.previous.digest !== expect.digest) {
      return rejected(`the registry changed since this page loaded: the previous version is now ${plan.previous.tag}. Reload and try again`);
    }
    const oldTag = keepTag(plan.current);
    const cmds = rollbackCommands(image, plan.previous.tag, svc.dir, oldId, oldTag);
    if (rt.deps.dryRun) {
      return { ok: true, outcome: "dry-run", message: `Dry run: would roll ${svc.name} back from ${plan.current.tag} to ${plan.previous.tag} (${cmds.length} steps). Nothing was changed.` };
    }

    const { engine } = rt.deps;
    const auth = this.d.credentials ? { username: this.d.credentials.user, password: this.d.credentials.password, serveraddress: image.registry } : null;
    await engine.pullImage(image.full, plan.previous.tag, auth, rt.pullTimeoutMs);
    const next = await engine.inspectImage(`${image.full}:${plan.previous.tag}`);
    if (!next) return { ok: false, outcome: "failed", message: `the pull of ${plan.previous.tag} finished but the image is not on the host` };
    if (next.id === oldId) return rejected(`${svc.name} already runs the image tagged ${plan.previous.tag}`);

    if (oldTag) await engine.tagImage(oldId, image.full, oldTag);
    await engine.tagImage(`${image.full}:${plan.previous.tag}`, image.full, "latest");

    const failure = await this.bringUp(svc, image, next.id, targets);
    if (!failure) {
      return { ok: true, outcome: "verified", message: `${svc.name} now runs ${plan.previous.tag} (was ${plan.current.tag}), up and healthy. The next deploy replaces it.` };
    }
    if (failure.unverified) {
      return { ok: false, outcome: "unverified", message: `Rolled ${svc.name} back to ${plan.previous.tag} but could not check the result (${failure.note}). It was not reverted.` };
    }

    const why = `Rolling ${svc.name} back to ${plan.previous.tag} failed (${failure.note})`;
    try {
      await engine.tagImage(oldId, image.full, "latest");
    } catch (err) {
      return { ok: false, outcome: "failed", message: `${why}. Putting ${plan.current.tag} back failed too: ${errMessage(err)}. Check ${svc.name} now.` };
    }
    const back = await this.bringUp(svc, image, oldId, targets);
    if (!back) return { ok: false, outcome: "reverted", message: `${why}. ${plan.current.tag} was put back and is up and healthy.` };
    return { ok: false, outcome: "failed", message: `${why}. Putting ${plan.current.tag} back did not bring it up either (${back.note}). Check ${svc.name} now.` };
  }

  private async bringUp(svc: Service, image: ImageRef, imageId: string, targets: DockerContainer[]): Promise<{ note: string; unverified: boolean } | null> {
    const rt = this.d.runtime;
    let failure: string | null;
    try {
      failure = await rt.runCompose(svc, UP_ARGS);
    } catch (err) {
      failure = errMessage(err);
    }
    if (failure) return { note: failure, unverified: false };
    const names = targets.map((c) => c.name);
    const v = await rt.verify((byName) => {
      const bad = names.filter((n) => {
        const c = byName.get(n);
        return !c || c.imageId !== imageId || !healthOk(c);
      });
      if (bad.length === 0) return { pass: true, note: "up and healthy" };
      return {
        pass: false,
        note: bad
          .map((n) => {
            const c = byName.get(n);
            return c && c.imageId !== imageId ? `${n} still runs another image` : describeContainer(c, n);
          })
          .join("; "),
      };
    }, true);
    if (v.state === "verified") return null;
    return { note: v.state === "failed" ? `not up and healthy after ${Math.round(rt.verifyTimeoutMs / 1000)}s: ${v.note}` : v.note, unverified: v.state === "unverified" };
  }
}
