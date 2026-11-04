import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { audit } from "../db";
import { DOCKER_SOURCES, type DockerContainer } from "../collectors/docker";
import type { Manifest, Service } from "../manifest";
import type { Store } from "../store";
import { commandLine, type ComposeRunner } from "./compose";
import type { DockerEngine } from "./engine";

export type ServiceOutcome = "verified" | "unverified" | "failed" | "reverted" | "rejected" | "busy" | "dry-run";

export interface ServiceActionResult {
  ok: boolean;
  outcome: ServiceOutcome;
  message: string;
  code?: "forbidden" | "not_found";
}

export type SwitchTarget = "on" | "off";

export class ServiceLocks {
  private held = new Set<string>();

  has(id: string): boolean {
    return this.held.has(id);
  }

  tryAcquire(id: string): boolean {
    if (this.held.has(id)) return false;
    this.held.add(id);
    return true;
  }

  release(id: string): void {
    this.held.delete(id);
  }
}

export interface RuntimeDeps {
  db: Database;
  manifest: Manifest;
  engine: DockerEngine;
  compose: ComposeRunner;
  locks: ServiceLocks;
  dryRun: boolean;
  store?: Store;
  verifyTimeoutMs?: number;
  composeTimeoutMs?: number;
  pullTimeoutMs?: number;
  pollMs?: number;
  stableMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Verdict {
  pass: boolean;
  note: string;
}

export interface VerifyResult {
  state: "verified" | "failed" | "unverified";
  note: string;
}

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const rejected = (message: string, code?: ServiceActionResult["code"]): ServiceActionResult => ({
  ok: false,
  outcome: "rejected",
  message,
  ...(code ? { code } : {}),
});

const auditTarget = (id: string) => id.slice(0, 64).replace(/[^\w.-]/g, "?");

export function healthOk(c: DockerContainer): boolean {
  return c.state === "running" && (c.health === "healthy" || c.health === "none");
}

export function describeContainer(c: DockerContainer | undefined, name: string): string {
  if (!c) return `${name} does not exist`;
  if (c.state !== "running") return `${name} is ${c.state}`;
  if (c.health === "starting") return `${name} is still starting`;
  if (c.health === "unhealthy") return `${name} is unhealthy`;
  return `${name} is up`;
}

export class ActionRuntime {
  readonly verifyTimeoutMs: number;
  readonly composeTimeoutMs: number;
  readonly pullTimeoutMs: number;
  private pollMs: number;
  private stableMs: number;
  readonly now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(readonly deps: RuntimeDeps) {
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? 60_000;
    this.composeTimeoutMs = deps.composeTimeoutMs ?? 120_000;
    this.pullTimeoutMs = deps.pullTimeoutMs ?? 300_000;
    this.pollMs = deps.pollMs ?? 1000;
    this.stableMs = deps.stableMs ?? 5000;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  locked(id: string): boolean {
    return this.deps.locks.has(id);
  }

  async guarded(
    action: string,
    id: string,
    actor: string,
    detail: string,
    run: (svc: Service) => Promise<ServiceActionResult>,
  ): Promise<ServiceActionResult> {
    const { db, manifest, locks } = this.deps;
    const svc = manifest.services.find((s) => s.id === id);
    const target = svc ? svc.id : auditTarget(id);
    const record = (r: ServiceActionResult) => {
      audit(db, { actor, action, target, outcome: r.outcome, detail: r.message.slice(0, 500) });
      return r;
    };
    if (!svc) return record(rejected("there is no such service in the manifest", "not_found"));
    if (svc.host !== "vps") {
      return record(rejected(`${svc.name} runs on the ${svc.host} host, which the panel cannot reach, so it is read-only here`, "forbidden"));
    }
    if (svc.core) {
      return record(rejected(`${svc.name} is part of the base layer and is managed through Ansible, so the panel will not touch it`, "forbidden"));
    }
    if (!locks.tryAcquire(svc.id)) return record({ ok: false, outcome: "busy", message: `another action on ${svc.name} is still in progress` });
    try {
      audit(db, { actor, action, target, outcome: "requested", detail });
      return record(await run(svc));
    } catch (err) {
      return record({ ok: false, outcome: "failed", message: errMessage(err) });
    } finally {
      locks.release(svc.id);
      if (this.deps.store) void this.deps.store.refresh(DOCKER_SOURCES.containers).catch(() => {});
    }
  }

  async runCompose(svc: Service, args: readonly string[]): Promise<string | null> {
    const r = await this.deps.compose.run(svc.dir, args, this.composeTimeoutMs);
    if (r.timedOut) return `${commandLine(svc.dir, args)} did not finish within ${Math.round(this.composeTimeoutMs / 1000)}s and was killed`;
    if (r.code !== 0) {
      const out = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ").slice(0, 240);
      return `${commandLine(svc.dir, args)} exited with ${r.code}${out ? `: ${out}` : ""}`;
    }
    return null;
  }

  async containersByName(): Promise<Map<string, DockerContainer>> {
    return new Map((await this.deps.engine.containers()).map((c) => [c.name, c]));
  }

  async verify(check: (byName: Map<string, DockerContainer>) => Verdict, stable: boolean): Promise<VerifyResult> {
    const deadline = this.now() + this.verifyTimeoutMs;
    let passSince: number | null = null;
    let note = "";
    let readable = false;
    for (;;) {
      try {
        const v = check(await this.containersByName());
        readable = true;
        note = v.note;
        if (v.pass) {
          passSince ??= this.now();
          if (!stable || this.now() - passSince >= this.stableMs) return { state: "verified", note };
        } else {
          passSince = null;
        }
      } catch (err) {
        readable = false;
        note = `docker did not answer: ${errMessage(err)}`;
        passSince = null;
      }
      if (this.now() >= deadline) break;
      await this.sleep(this.pollMs);
    }
    return { state: readable ? "failed" : "unverified", note };
  }
}

export function checkDir(svc: Service, found: DockerContainer[]): string | null {
  const project = basename(svc.dir);
  const stray = found.find((c) => c.composeProject !== project || (c.composeDir != null && c.composeDir !== svc.dir));
  if (!stray) return null;
  return stray.composeProject === null
    ? `${stray.name} was not created by docker compose, so the panel will not run compose for it`
    : `${stray.name} belongs to the compose project ${stray.composeProject}${stray.composeDir ? ` in ${stray.composeDir}` : ""}, not ${project} in ${svc.dir}, so the panel will not run compose there`;
}

export class ServiceActions {
  constructor(private rt: ActionRuntime) {}

  locked(id: string): boolean {
    return this.rt.locked(id);
  }

  switchService(id: string, to: SwitchTarget, actor: string): Promise<ServiceActionResult> {
    const args = to === "off" ? ["stop"] : ["up", "-d"];
    const dir = this.rt.deps.manifest.services.find((s) => s.id === id)?.dir ?? "?";
    return this.rt.guarded("service.switch", id, actor, `${to}: ${commandLine(dir, args)}`, (svc) => this.run(svc, to, args));
  }

  private async run(svc: Service, to: SwitchTarget, args: string[]): Promise<ServiceActionResult> {
    const { rt } = this;
    const before = await rt.containersByName();
    const found = svc.containers.flatMap((n) => (before.has(n) ? [before.get(n)!] : []));
    const stray = checkDir(svc, found);
    if (stray) return rejected(stray);
    if (to === "off") {
      if (found.length === 0) return rejected(`no container of ${svc.name} exists, so there is nothing to stop`);
      if (found.every((c) => c.state !== "running" && c.state !== "restarting")) return rejected(`${svc.name} is already switched off`);
    } else if (found.length === svc.containers.length && found.every(healthOk)) {
      return rejected(`${svc.name} is already running`);
    }
    const cmd = commandLine(svc.dir, args);
    if (rt.deps.dryRun) return { ok: true, outcome: "dry-run", message: `Dry run: would run \`${cmd}\`. Nothing was changed.` };

    const failure = await rt.runCompose(svc, args);
    if (failure) return { ok: false, outcome: "failed", message: failure };

    const v = await rt.verify((byName) => {
      const states = svc.containers.map((n) => byName.get(n));
      if (to === "off") {
        const running = svc.containers.filter((n, i) => states[i] && (states[i]!.state === "running" || states[i]!.state === "restarting"));
        return running.length === 0
          ? { pass: true, note: "all containers stopped" }
          : { pass: false, note: `${running.join(", ")} still running` };
      }
      const bad = svc.containers.filter((n, i) => !states[i] || !healthOk(states[i]!));
      return bad.length === 0
        ? { pass: true, note: "all containers running" }
        : { pass: false, note: bad.map((n) => describeContainer(byName.get(n), n)).join("; ") };
    }, to === "on");

    const verb = to === "off" ? "switched off" : "switched on";
    if (v.state === "verified") return { ok: true, outcome: "verified", message: `${svc.name} ${verb}: ${v.note}.` };
    if (v.state === "unverified") return { ok: false, outcome: "unverified", message: `\`${cmd}\` succeeded but the result could not be checked: ${v.note}` };
    return { ok: false, outcome: "failed", message: `\`${cmd}\` succeeded but ${svc.name} is not ${to === "off" ? "off" : "up"} after ${Math.round(rt.verifyTimeoutMs / 1000)}s: ${v.note}` };
  }
}
