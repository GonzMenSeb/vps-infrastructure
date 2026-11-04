import type { Manifest, Service } from "../manifest";

export type CredentialSource = "env" | "vault" | "hash";

export interface Credential {
  id: string;
  label: string;
  source: CredentialSource;
  var: string;
  envKey: string | null;
  revealable: boolean;
  editable: boolean;
  readOnlyReason: string | null;
  rotatable: boolean;
  minLength: number;
  alsoUsedBy: { id: string; name: string }[];
  note: string | null;
  user: string | null;
}

export const HOST_READ_ONLY = "This service runs on the Jenkins host. vps-deploy never applies changes there, so the panel does not edit it.";
export const NOT_MAPPED = "The manifest does not say which variable renders this key, so the panel cannot edit it.";
export const NOT_ALLOWLISTED = "The variable is not in the edit allowlist.";

const MIN_HASH_PASSWORD = 12;

export function secretAllowlist(manifest: Manifest): { vault: Set<string>; hash: Set<string> } {
  const vault = new Set<string>();
  const hash = new Set<string>();
  for (const s of manifest.services) {
    if (s.host !== "vps") continue;
    for (const v of s.auth.vault_vars) if (!(v in manifest.secrets.locked)) vault.add(v);
    if (s.auth.hash) hash.add(s.auth.hash.var);
  }
  return { vault, hash };
}

function usedBy(manifest: Manifest, svc: Service, variable: string): { id: string; name: string }[] {
  return manifest.services
    .filter((o) => o.id !== svc.id && (o.auth.vault_vars.includes(variable) || o.auth.hash?.var === variable))
    .map((o) => ({ id: o.id, name: o.name }));
}

function humanLabel(key: string): string {
  return key.replace(/^vault_/, "").replace(/_/g, " ");
}

export function credentialsFor(manifest: Manifest, svc: Service): Credential[] {
  const allow = secretAllowlist(manifest);
  const onVps = svc.host === "vps";
  const out: Credential[] = [];

  const base = (id: string, variable: string, source: CredentialSource): Credential => {
    const locked = manifest.secrets.locked[variable] ?? null;
    const allowed = source === "hash" ? allow.hash.has(variable) : allow.vault.has(variable);
    const reason = !onVps ? HOST_READ_ONLY : locked ?? (allowed ? null : NOT_ALLOWLISTED);
    return {
      id,
      label: humanLabel(id),
      source,
      var: variable,
      envKey: null,
      revealable: false,
      editable: reason === null,
      readOnlyReason: reason,
      rotatable: source === "hash" || manifest.secrets.rotatable.includes(variable),
      minLength: Math.max(1, manifest.secrets.min_length[variable] ?? 1, source === "hash" ? MIN_HASH_PASSWORD : 1),
      alsoUsedBy: usedBy(manifest, svc, variable),
      note: null,
      user: null,
    };
  };

  if (svc.auth.kind === "basic-auth-hash" && svc.auth.hash) {
    const h = svc.auth.hash;
    out.push({ ...base(h.var, h.var, "hash"), label: `${h.user} (dashboard login)`, note: h.note ?? null, user: h.user });
    return out;
  }

  const mapped = new Set<string>();
  for (const key of svc.auth.env_keys) {
    const variable = svc.auth.env_vars[key];
    if (variable) mapped.add(variable);
    const c: Credential = variable
      ? { ...base(key, variable, "env"), label: key }
      : { ...base(key, key, "env"), label: key, editable: false, readOnlyReason: NOT_MAPPED, rotatable: false, var: "" };
    c.envKey = key;
    c.revealable = onVps && svc.auth.kind === "env";
    out.push(c);
  }
  for (const variable of svc.auth.vault_vars) {
    if (mapped.has(variable)) continue;
    out.push(base(variable, variable, "vault"));
  }
  return out;
}

export function findCredential(manifest: Manifest, svc: Service, id: string): Credential | null {
  return credentialsFor(manifest, svc).find((c) => c.id === id) ?? null;
}
