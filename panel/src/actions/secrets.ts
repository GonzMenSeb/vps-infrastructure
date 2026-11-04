import type { Database } from "bun:sqlite";
import { z } from "zod";
import { audit } from "../db";
import { JenkinsError, type JenkinsClient } from "../collectors/jenkins";
import { indexManifest, type Manifest } from "../manifest";
import { findCredential } from "../secrets/credentials";
import { envPath, readEnvKeys } from "../secrets/envfile";
import { htpasswdLine, validateValue } from "../secrets/values";

export type EditStage = "starting" | "queued" | "editing" | "deploying" | "applied" | "unchanged" | "failed" | "unverified";

const ACTIVE_STAGES: readonly EditStage[] = ["starting", "queued", "editing", "deploying"];
export const RECENT_EDIT_MS = 30 * 60_000;
const STARTING_GRACE_MS = 60_000;

export interface EditRow {
  id: number;
  created_at: number;
  updated_at: number;
  service: string;
  cred: string;
  var_name: string;
  actor: string;
  stage: EditStage;
  queue_id: number | null;
  edit_build: number | null;
  commit_sha: string | null;
  edit_done_at: number | null;
  deploy_build: number | null;
  message: string | null;
}

export const isActive = (r: Pick<EditRow, "stage">) => ACTIVE_STAGES.includes(r.stage);

export class EditStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secret_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        service TEXT NOT NULL,
        cred TEXT NOT NULL,
        var_name TEXT NOT NULL,
        actor TEXT NOT NULL,
        stage TEXT NOT NULL,
        queue_id INTEGER,
        edit_build INTEGER,
        commit_sha TEXT,
        edit_done_at INTEGER,
        deploy_build INTEGER,
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS secret_edits_service ON secret_edits (service, id);
    `);
  }

  insert(r: Pick<EditRow, "service" | "cred" | "var_name" | "actor">, now: number): number {
    return Number(
      this.db
        .query("INSERT INTO secret_edits (created_at, updated_at, service, cred, var_name, actor, stage) VALUES (?, ?, ?, ?, ?, ?, 'starting')")
        .run(now, now, r.service, r.cred, r.var_name, r.actor).lastInsertRowid,
    );
  }

  update(id: number, patch: Partial<Pick<EditRow, "stage" | "queue_id" | "edit_build" | "commit_sha" | "edit_done_at" | "deploy_build" | "message">>, now: number): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    this.db.query(`UPDATE secret_edits SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), now, id);
  }

  get(id: number): EditRow | null {
    return this.db.query<EditRow, [number]>("SELECT * FROM secret_edits WHERE id = ?").get(id) ?? null;
  }

  active(): EditRow[] {
    return this.db.query<EditRow, []>(`SELECT * FROM secret_edits WHERE stage IN (${ACTIVE_STAGES.map((s) => `'${s}'`).join(",")}) ORDER BY id`).all();
  }

  conflict(service: string, variable: string): EditRow | null {
    return this.active().find((r) => r.service === service || r.var_name === variable) ?? null;
  }

  recent(service: string, since: number): EditRow[] {
    return this.db
      .query<EditRow, [string, number]>("SELECT * FROM secret_edits WHERE service = ? AND (updated_at >= ? OR stage IN ('starting','queued','editing','deploying')) ORDER BY id DESC")
      .all(service, since);
  }
}

export type EditOutcome = "queued" | "rejected" | "busy" | "failed";

export interface EditResult {
  ok: boolean;
  outcome: EditOutcome;
  message: string;
  id?: number;
}

export type RevealResult = { ok: true; value: string } | { ok: false; status: 403 | 404 | 500; message: string };

export const NOT_CONFIGURED = "Editing needs the Jenkins connection (JENKINS_URL, JENKINS_USER and JENKINS_TOKEN).";

export interface SecretDeps {
  client: JenkinsClient | null;
  editBlocked?: string | null;
  db: Database;
  manifest: Manifest;
  job: string;
  applyJob: string;
  trackTimeoutMs: number;
  envRoot?: string;
  hashCost?: number;
  now?: () => number;
}

const jobSchema = z.object({
  buildable: z.boolean().optional(),
  property: z.array(z.object({ parameterDefinitions: z.array(z.object({ name: z.string() })).optional() })).optional(),
});
const queueSchema = z.object({ cancelled: z.boolean().optional(), executable: z.object({ number: z.number() }).nullish() });
const buildSchema = z.object({
  building: z.boolean().optional(),
  result: z.string().nullish(),
  description: z.string().nullish(),
  timestamp: z.number().optional(),
  duration: z.number().optional(),
});
const applySchema = z.object({
  builds: z.array(
    z.object({
      number: z.number(),
      timestamp: z.number().optional(),
      building: z.boolean().optional(),
      result: z.string().nullish(),
      actions: z.array(z.object({ lastBuiltRevision: z.object({ SHA1: z.string().optional() }).nullish() })).optional(),
    }),
  ),
});

const PREFLIGHT_TREE = encodeURIComponent("buildable,property[parameterDefinitions[name]]");
const APPLY_TREE = encodeURIComponent("builds[number,timestamp,building,result,actions[lastBuiltRevision[SHA1]]]{0,25}");
const COMMIT_DESCRIPTION = /^commit ([0-9a-f]{40})$/;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SecretActions {
  readonly store: EditStore;
  readonly canEdit: boolean;
  readonly blockedReason: string | null;
  private now: () => number;
  private index: ReturnType<typeof indexManifest>;

  constructor(private deps: SecretDeps) {
    this.store = new EditStore(deps.db);
    this.blockedReason = deps.client ? (deps.editBlocked ?? null) : NOT_CONFIGURED;
    this.canEdit = this.blockedReason === null;
    this.now = deps.now ?? (() => Date.now());
    this.index = indexManifest(deps.manifest);
    for (const r of this.store.active()) {
      if (r.stage === "starting") this.finish(r, "unverified", "The panel restarted before the request reached Jenkins, so it is not known whether it ran.");
    }
  }

  async reveal(actor: string, serviceId: string, credId: string): Promise<RevealResult> {
    const target = `${serviceId}/${credId}`;
    const svc = this.index.byId.get(serviceId);
    const cred = svc ? findCredential(this.deps.manifest, svc, credId) : null;
    if (!svc || !cred || !cred.revealable || !cred.envKey) {
      audit(this.deps.db, { actor, action: "secret.reveal", target, outcome: "denied" });
      return { ok: false, status: 404, message: "That credential cannot be revealed." };
    }
    const read = await readEnvKeys(envPath(svc, this.deps.envRoot), [cred.envKey]);
    if (!read.ok) {
      audit(this.deps.db, { actor, action: "secret.reveal", target, outcome: "error", detail: read.reason });
      return { ok: false, status: 500, message: `The panel could not read ${svc.dir}/.env (${read.reason}).` };
    }
    const value = read.values.get(cred.envKey) ?? null;
    if (value === null) {
      audit(this.deps.db, { actor, action: "secret.reveal", target, outcome: "missing" });
      return { ok: false, status: 404, message: `${cred.envKey} is not in ${svc.dir}/.env.` };
    }
    audit(this.deps.db, { actor, action: "secret.reveal", target, outcome: "ok" });
    return { ok: true, value };
  }

  async edit(actor: string, serviceId: string, credId: string, raw: unknown): Promise<EditResult> {
    const { db } = this.deps;
    const target = `${serviceId}/${credId}`;
    const reject = (outcome: EditOutcome, message: string): EditResult => {
      audit(db, { actor, action: "secret.edit", target, outcome, detail: message });
      return { ok: false, outcome, message };
    };
    const svc = this.index.byId.get(serviceId);
    const cred = svc ? findCredential(this.deps.manifest, svc, credId) : null;
    if (!svc || !cred) return reject("rejected", "Unknown service or credential.");
    if (!this.canEdit) return reject("rejected", this.blockedReason ?? NOT_CONFIGURED);
    if (!cred.editable) return reject("rejected", cred.readOnlyReason ?? "This credential is read-only.");
    const valid = validateValue(cred, raw);
    if (!valid.ok) return reject("rejected", valid.error);
    const busy = this.store.conflict(svc.id, cred.var);
    if (busy) {
      return reject("busy", busy.service === svc.id ? `Another change to ${svc.name} is still pending.` : `${cred.var} is already being changed from ${busy.service}.`);
    }
    const id = this.store.insert({ service: svc.id, cred: cred.id, var_name: cred.var, actor }, this.now());
    audit(db, { actor, action: "secret.edit", target, outcome: "requested", detail: `var=${cred.var}` });
    try {
      const sent = cred.source === "hash" ? await htpasswdLine(cred.user!, valid.value, this.deps.hashCost) : valid.value;
      const queueId = await this.trigger(cred.var, sent);
      this.store.update(id, { stage: "queued", queue_id: queueId, message: null }, this.now());
      audit(db, { actor, action: "secret.edit", target, outcome: "queued", detail: `var=${cred.var} queue=${queueId}` });
      return { ok: true, outcome: "queued", message: `Sent to ${this.deps.job}.`, id };
    } catch (err) {
      const message = err instanceof PreflightError ? err.message : `Jenkins did not accept the request: ${errMessage(err)}`;
      this.store.update(id, { stage: "failed", message }, this.now());
      audit(db, { actor, action: "secret.edit", target, outcome: "failed", detail: message });
      return { ok: false, outcome: "failed", message, id };
    }
  }

  private async trigger(variable: string, value: string): Promise<number> {
    const { job } = this.deps;
    const client = this.deps.client!;
    const j = encodeURIComponent(job);
    let state: z.infer<typeof jobSchema>;
    try {
      state = jobSchema.parse(await client.getJson(`/job/${j}/api/json?tree=${PREFLIGHT_TREE}`));
    } catch (err) {
      if (err instanceof JenkinsError && err.status === 404) throw new PreflightError(`Jenkins has no job called ${job} yet. Apply the Jenkins playbook and reload its configuration.`);
      throw err;
    }
    if (state.buildable === false) throw new PreflightError(`${job} is disabled in Jenkins.`);
    const params = new Set((state.property ?? []).flatMap((p) => (p.parameterDefinitions ?? []).map((d) => d.name)));
    if (!params.has("VAR_NAME") || !params.has("VAR_VALUE")) throw new PreflightError(`${job} does not declare VAR_NAME and VAR_VALUE.`);
    const res = await client.request("POST", `/job/${j}/buildWithParameters`, undefined, new URLSearchParams({ VAR_NAME: variable, VAR_VALUE: value }));
    await res.body?.cancel();
    const queueId = Number(/\/queue\/item\/(\d+)\/?$/.exec(res.headers.get("location") ?? "")?.[1]);
    if (!Number.isInteger(queueId)) throw new PreflightError("Jenkins accepted the request but returned no queue item to follow.");
    return queueId;
  }

  async tick(): Promise<void> {
    if (!this.deps.client) return;
    for (const row of this.store.active()) {
      try {
        await this.advance(row);
      } catch {
        // Jenkins unreachable: keep the stage and try again on the next tick until the timeout.
      }
    }
  }

  private finish(row: EditRow, stage: EditStage, message: string | null, patch: Partial<EditRow> = {}): void {
    this.store.update(row.id, { ...patch, stage, message }, this.now());
    const editBuild = patch.edit_build ?? row.edit_build;
    const deployBuild = patch.deploy_build ?? row.deploy_build;
    audit(this.deps.db, {
      actor: row.actor,
      action: "secret.edit",
      target: `${row.service}/${row.cred}`,
      outcome: stage,
      detail: [`var=${row.var_name}`, editBuild ? `${this.deps.job} #${editBuild}` : "", deployBuild ? `${this.deps.applyJob} #${deployBuild}` : "", message ?? ""]
        .filter(Boolean)
        .join("; "),
    });
  }

  private async advance(row: EditRow): Promise<void> {
    const { job, applyJob } = this.deps;
    const client = this.deps.client!;
    const now = this.now();
    if (row.stage === "starting") {
      if (now - row.created_at > STARTING_GRACE_MS) this.finish(row, "unverified", "The request never reported back to the panel.");
      return;
    }
    if (now - row.created_at > this.deps.trackTimeoutMs) {
      this.finish(row, "unverified", `Stopped following after ${Math.round(this.deps.trackTimeoutMs / 60_000)} minutes. Check ${row.stage === "deploying" ? applyJob : job} in Jenkins.`);
      return;
    }
    const j = encodeURIComponent(job);
    if (row.stage === "queued") {
      let q: z.infer<typeof queueSchema>;
      try {
        q = queueSchema.parse(await client.getJson(`/queue/item/${row.queue_id}/api/json?tree=cancelled,executable[number]`));
      } catch (err) {
        if (err instanceof JenkinsError && err.status === 404) this.finish(row, "unverified", "The queue item disappeared before a build number was reported.");
        else throw err;
        return;
      }
      if (q.cancelled) this.finish(row, "failed", `The ${job} run was cancelled while waiting in the queue.`);
      else if (q.executable) this.store.update(row.id, { stage: "editing", edit_build: q.executable.number }, now);
      return;
    }
    if (row.stage === "editing") {
      const b = buildSchema.parse(await client.getJson(`/job/${j}/${row.edit_build}/api/json?tree=building,result,description,timestamp,duration`));
      if (b.building) return;
      if (b.result !== "SUCCESS") {
        this.finish(row, "failed", `${job} #${row.edit_build} finished as ${b.result ?? "unknown"}. Nothing was committed; open its console for the reason.`);
        return;
      }
      const desc = (b.description ?? "").trim();
      const commit = COMMIT_DESCRIPTION.exec(desc)?.[1];
      if (commit) this.store.update(row.id, { stage: "deploying", commit_sha: commit, edit_done_at: (b.timestamp ?? now) + (b.duration ?? 0) }, now);
      else if (desc === "unchanged") this.finish(row, "unchanged", "The stored value already equals the new one, so nothing was committed.");
      else this.finish(row, "unverified", `${job} #${row.edit_build} succeeded but did not report a commit.`);
      return;
    }
    if (row.stage === "deploying") {
      const apply = applySchema.parse(await client.getJson(`/job/${encodeURIComponent(applyJob)}/api/json?tree=${APPLY_TREE}`));
      const exact = apply.builds.find((b) => (b.actions ?? []).some((a) => a.lastBuiltRevision?.SHA1 === row.commit_sha));
      const later = exact
        ? undefined
        : apply.builds
            .filter((b) => row.edit_done_at !== null && b.timestamp !== undefined && b.timestamp >= row.edit_done_at)
            .sort((a, b) => a.number - b.number)[0];
      const build = exact ?? later;
      if (!build) return;
      const note = later ? `${applyJob} #${later.number} started after the commit was pushed, so it includes it.` : null;
      if (build.building) {
        if (row.deploy_build !== build.number) this.store.update(row.id, { deploy_build: build.number }, now);
        return;
      }
      if (build.result === "SUCCESS") this.finish(row, "applied", note, { deploy_build: build.number });
      else this.finish(row, "failed", `The change is committed (${row.commit_sha?.slice(0, 7)}) but ${applyJob} #${build.number} finished as ${build.result ?? "unknown"}, so it is not applied yet.`, { deploy_build: build.number });
    }
  }
}

class PreflightError extends Error {}
