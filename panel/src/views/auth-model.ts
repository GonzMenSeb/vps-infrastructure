import type { EditStage } from "../actions/secrets";
import type { Service } from "../manifest";
import { credentialsFor, type Credential } from "../secrets/credentials";
import { fmtSince, jobsHref, type ViewInput } from "./model";

export interface EditView {
  service: string;
  cred: string;
  varName: string;
  stage: EditStage;
  message: string | null;
  editBuild: number | null;
  deployBuild: number | null;
  commit: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SecretsView {
  enabled: boolean;
  disabledReason: string | null;
  fresh: boolean;
  reauthHref: string;
  revealSeconds: number;
  reauthMinutes: number;
  job: string;
  applyJob: string;
  edits: EditView[];
  now: number;
}

export type PendingState = "pending" | "applied" | "unchanged" | "failed" | "unverified";

export interface PendingVM {
  state: PendingState;
  text: string;
  message: string | null;
  editHref: string | null;
  deployHref: string | null;
  ageText: string;
}

export interface Dialog {
  title: string;
  body: string;
  request: string;
  ok: string;
}

export interface AuthRowVM {
  id: string;
  label: string;
  sub: string | null;
  source: Credential["source"];
  revealable: boolean;
  editable: boolean;
  readOnlyReason: string | null;
  rotatable: boolean;
  minLength: number;
  maxLength: number;
  alsoUsedBy: string[];
  note: string | null;
  revealUrl: string;
  editUrl: string;
  rotateUrl: string;
  pending: PendingVM | null;
  edit: Dialog;
  rotate: Dialog;
}

export interface AuthTabVM {
  kindText: string;
  gateText: string;
  rows: AuthRowVM[];
  secrets: SecretsView | null;
  noSecrets: boolean;
}

const KIND_TEXT: Record<Service["auth"]["kind"], string> = {
  "basic-auth-hash": "Traefik basic-auth. Only a hash is stored, so the password can be changed but never shown.",
  env: "Secrets rendered into the service's .env",
  vault: "Secrets kept in vault.yml",
  none: "No secrets",
};

const STAGE_TEXT: Record<EditStage, { state: PendingState; text: string }> = {
  starting: { state: "pending", text: "Sending to Jenkins" },
  queued: { state: "pending", text: "Waiting for a Jenkins executor" },
  editing: { state: "pending", text: "Writing the value and pushing to main" },
  deploying: { state: "pending", text: "Pushed. Waiting for vps-deploy to apply it" },
  applied: { state: "applied", text: "Applied by vps-deploy" },
  unchanged: { state: "unchanged", text: "No change" },
  failed: { state: "failed", text: "Failed" },
  unverified: { state: "unverified", text: "Outcome unknown" },
};

const enc = encodeURIComponent;
export const MAX_PLAIN = 512;
export const MAX_HASH_PASSWORD = 72;

function pendingFor(v: SecretsView, svc: Service, c: Credential): PendingVM | null {
  const e = v.edits.find((x) => x.service === svc.id && x.varName === c.var);
  if (!e) return null;
  const t = STAGE_TEXT[e.stage];
  return {
    state: t.state,
    text: t.text,
    message: e.message,
    editHref: e.editBuild ? jobsHref(v.job, e.editBuild) : null,
    deployHref: e.deployBuild ? jobsHref(v.applyJob, e.deployBuild) : null,
    ageText: fmtSince(Math.max(0, v.now - e.updatedAt)),
  };
}

function request(v: SecretsView | null, c: Credential, rotate: boolean): string {
  const job = v?.job ?? "panel-secrets";
  const file = c.source === "hash" ? "group_vars/all.yml" : "vault.yml";
  const value = c.source === "hash" ? `${c.user}:<bcrypt hash of the ${rotate ? "generated" : "new"} password>` : "(hidden)";
  return [
    `POST /job/${job}/buildWithParameters`,
    `VAR_NAME=${c.var}`,
    `VAR_VALUE=${value}`,
    "",
    `Then: commit ${file} and push to main`,
    `Then: ${v?.applyJob ?? "vps-deploy"} builds that commit`,
  ].join("\n");
}

function dialog(v: SecretsView | null, svc: Service, c: Credential, rotate: boolean): Dialog {
  const also = c.alsoUsedBy.map((s) => s.name);
  const lines = [
    `Nothing changes yet. The panel starts ${v?.job ?? "panel-secrets"}, which writes ${rotate ? "a new random value" : "the new value"} to ${c.source === "hash" ? "group_vars/all.yml" : "vault.yml"} and pushes it to main. That push triggers ${v?.applyJob ?? "vps-deploy"}, which applies it, and ${svc.name} restarts if its configuration changed.`,
  ];
  if (also.length) lines.push(`${c.var} also feeds ${also.join(", ")}, which restart too.`);
  if (c.note) lines.push(c.note);
  lines.push("A service that keeps its own copy of the secret (a database user, a registered OAuth app, a third-party account) keeps the old one until it is changed there too.");
  if (rotate) lines.push("The new value is shown once, on the next page. The panel does not keep it.");
  return {
    title: `${rotate ? "Rotate" : "Change"} ${c.label} for ${svc.name}?`,
    body: lines.join("\n\n"),
    request: request(v, c, rotate),
    ok: rotate ? "Rotate and apply" : "Save and apply",
  };
}

export function buildAuthTab(input: ViewInput, svc: Service, gateText: string): AuthTabVM {
  const v = input.secrets ?? null;
  const rows = credentialsFor(input.manifest, svc).map<AuthRowVM>((c) => ({
    id: c.id,
    label: c.label,
    sub: c.source === "env" ? (c.var ? c.var : "no vault variable mapped") : c.source === "hash" ? c.var : null,
    source: c.source,
    revealable: c.revealable,
    editable: c.editable,
    readOnlyReason: c.readOnlyReason,
    rotatable: c.rotatable,
    minLength: c.minLength,
    maxLength: c.source === "hash" ? MAX_HASH_PASSWORD : MAX_PLAIN,
    alsoUsedBy: c.alsoUsedBy.map((s) => s.name),
    note: c.note,
    revealUrl: `/services/${enc(svc.id)}/auth/${enc(c.id)}/reveal`,
    editUrl: `/services/${enc(svc.id)}/auth/${enc(c.id)}`,
    rotateUrl: `/services/${enc(svc.id)}/auth/${enc(c.id)}/rotate`,
    pending: v ? pendingFor(v, svc, c) : null,
    edit: dialog(v, svc, c, false),
    rotate: dialog(v, svc, c, true),
  }));
  return {
    kindText: KIND_TEXT[svc.auth.kind],
    gateText,
    rows,
    secrets: v,
    noSecrets: rows.length === 0,
  };
}
