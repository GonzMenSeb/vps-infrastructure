import { keepTag, planRollback, rollbackCommands, rollbackTarget } from "../actions/rollback-select";
import type { ZotRepoTags } from "../collectors/zot-tags";
import type { Service } from "../manifest";
import type { Snapshot } from "../store";
import { fmtAge, type ContainerRow, type Flash, type ViewInput } from "./model";

export interface ServiceView {
  dryRun: boolean;
  registryHost: string | null;
  zotConfigured: boolean;
  zot: Snapshot<ZotRepoTags> | null;
  locked: (id: string) => boolean;
  verifyTimeoutMs: number;
  now?: number;
}

export interface ServiceFormVM {
  label: string;
  action: string;
  csrf: string;
  title: string;
  body: string;
  request: string;
  ok: string;
  danger: boolean;
  primary: boolean;
  fields: Record<string, string>;
}

export type ToggleVM = { kind: "form"; form: ServiceFormVM } | { kind: "disabled"; label: string; reason: string };

export interface RollbackTagVM {
  tag: string;
  aliases: string[];
  digestShort: string;
  ageText: string;
  ageTitle: string;
  revision: string | null;
}

export type RollbackVM =
  | { kind: "ready"; current: RollbackTagVM; previous: RollbackTagVM; form: ServiceFormVM | null; blocked: string | null; notice: string | null }
  | { kind: "unavailable"; reason: string };

export interface ServiceActionsVM {
  dryRun: boolean;
  flash: Flash | null;
  toggle: ToggleVM | null;
  rollback: RollbackVM | null;
  note: string | null;
}

const NO_CONTROLS: Omit<ServiceActionsVM, "dryRun" | "flash"> = { toggle: null, rollback: null, note: null };

const isUp = (r: ContainerRow) => r.found && (r.state === "running" || r.state === "restarting");

function toggleFor(sv: ServiceView, svc: Service, rows: ContainerRow[], csrf: string, dockerKnown: boolean): { toggle: ToggleVM; note: string | null } {
  const off = "Switch off";
  if (svc.core) return { toggle: { kind: "disabled", label: off, reason: "Needed by the panel and other services" }, note: null };
  if (!dockerKnown) return { toggle: { kind: "disabled", label: off, reason: "The Docker state is not known yet" }, note: null };
  if (sv.locked(svc.id)) return { toggle: { kind: "disabled", label: off, reason: `Another action on ${svc.name} is in progress` }, note: null };
  const action = `/services/${encodeURIComponent(svc.id)}/switch`;
  if (rows.some(isUp)) {
    return {
      note: null,
      toggle: {
        kind: "form",
        form: {
          label: off,
          action,
          csrf,
          title: `Switch off ${svc.name}?`,
          body: `${svc.hostname ? `https://${svc.hostname} will stop answering until you switch it back on. ` : ""}Its data and configuration stay in place. Ansible and every push to main (vps-deploy) start it again, so a manual switch-off does not survive the next deploy.`,
          request: `cd ${svc.dir} && docker compose stop`,
          ok: off,
          danger: true,
          primary: false,
          fields: { to: "off" },
        },
      },
    };
  }
  if (rows.some((r) => r.found)) {
    return {
      note: "Switched off. vps-deploy starts it again on the next push to main.",
      toggle: {
        kind: "form",
        form: {
          label: "Switch on",
          action,
          csrf,
          title: `Switch on ${svc.name}?`,
          body: `${svc.name} starts from the image it was last running.${svc.hostname ? " Traefik starts routing to it once the container is healthy." : ""}`,
          request: `cd ${svc.dir} && docker compose up -d`,
          ok: "Switch on",
          danger: false,
          primary: true,
          fields: { to: "on" },
        },
      },
    };
  }
  return { toggle: { kind: "disabled", label: "Switch on", reason: `No container of ${svc.name} exists yet. Its Ansible role creates it` }, note: null };
}

function rollbackFor(sv: ServiceView, svc: Service, rows: ContainerRow[], csrf: string, dockerKnown: boolean): RollbackVM {
  const target = rollbackTarget(svc, sv.registryHost);
  if (!target.ok) return { kind: "unavailable", reason: target.reason };
  const image = target.image;
  if (!sv.zotConfigured) return { kind: "unavailable", reason: "Zot is not configured, so the registry cannot be read." };
  const data = sv.zot?.data;
  if (!data || !(image.repo in data)) {
    return { kind: "unavailable", reason: sv.zot?.lastError ? `Zot did not answer: ${sv.zot.lastError}` : "Waiting for the first answer from Zot." };
  }
  const tags = data[image.repo];
  if (tags === null || tags === undefined) return { kind: "unavailable", reason: `${image.repo} is not in the registry yet.` };
  if (!dockerKnown) return { kind: "unavailable", reason: "The Docker state is not known yet." };
  const withImage = rows.filter((r) => r.found && r.image === image.ref && r.imageId);
  const targets = withImage.filter((r) => r.state === "running" || r.state === "restarting");
  if (targets.length === 0) {
    return { kind: "unavailable", reason: withImage.length ? `${svc.name} is switched off. Switch it on before rolling it back.` : `No container of ${svc.name} is running ${image.ref}.` };
  }
  const plan = planRollback(tags, targets.map((r) => r.imageId!));
  if (!plan.ok) return { kind: "unavailable", reason: plan.reason };

  const now = sv.now ?? Date.now();
  const age = (iso: string | null) => {
    const t = iso ? Date.parse(iso.replace(/(\.\d{3})\d*/, "$1")) : Number.NaN;
    return Number.isNaN(t) ? { text: "push time unknown", title: "" } : { text: `pushed ${fmtAge(Math.max(0, now - t))}`, title: iso! };
  };
  const view = (p: typeof plan.current, revision: string | null): RollbackTagVM => {
    const a = age(p.lastUpdated);
    return { tag: p.tag, aliases: p.aliases, digestShort: p.digest.slice(0, 19), ageText: a.text, ageTitle: a.title, revision };
  };
  const revision = targets.find((r) => r.revision)?.revision ?? null;
  const current = view(plan.current, revision);
  const previous = view(plan.previous, null);

  const blocked = sv.locked(svc.id) ? `Another action on ${svc.name} is in progress` : null;
  const seconds = Math.round(sv.verifyTimeoutMs / 1000);
  const job = svc.jenkins_job ?? "this service";
  const latestTag = tags.find((t) => t.digest === plan.latestDigest && t.tag !== "latest")?.tag ?? "latest";
  const form: ServiceFormVM = {
    label: `Roll back to ${plan.previous.tag}`,
    action: `/services/${encodeURIComponent(svc.id)}/rollback`,
    csrf,
    title: `Roll back ${svc.name} to ${plan.previous.tag}?`,
    body: `${svc.name} goes back from ${plan.current.tag} to ${plan.previous.tag}, ${previous.ageText}. It restarts, so expect a few seconds of downtime. If ${plan.previous.tag} is not up and healthy within ${seconds} s, the panel puts ${plan.current.tag} back. The next build of ${job} or the next deploy replaces it again.`,
    request: rollbackCommands(image, plan.previous.tag, svc.dir, targets[0]!.imageId, keepTag(plan.current)).join("\n"),
    ok: `Roll back to ${plan.previous.tag}`,
    danger: true,
    primary: false,
    fields: { to: plan.previous.tag, digest: plan.previous.digest },
  };
  return {
    kind: "ready",
    current,
    previous,
    form: blocked ? null : form,
    blocked,
    notice: plan.rolledBack ? `The registry's latest is ${latestTag}, but this service runs ${plan.current.tag}. The next deploy puts ${latestTag} back.` : null,
  };
}

export function buildServiceActions(input: ViewInput, svc: Service, rows: ContainerRow[], flash: Flash | null, dockerKnown: boolean): ServiceActionsVM | null {
  const sv = input.service;
  if (!sv) return null;
  const base = { dryRun: sv.dryRun, flash };
  if (svc.host !== "vps") return { ...base, ...NO_CONTROLS };
  const csrf = input.csrf ?? "";
  const { toggle, note } = toggleFor(sv, svc, rows, csrf, dockerKnown);
  return { ...base, toggle, note, rollback: rollbackFor(sv, svc, rows, csrf, dockerKnown) };
}
