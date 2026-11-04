import type { Database } from "bun:sqlite";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { NOT_CONFIGURED, RECENT_EDIT_MS, type SecretActions } from "../actions/secrets";
import { type AppEnv, type AuthedSession, csrfGuard, isFresh, reauthHref, requireFresh } from "../auth/session";
import type { Config } from "../config";
import { indexManifest, type Manifest } from "../manifest";
import { findCredential } from "../secrets/credentials";
import { generatePassword } from "../secrets/values";
import type { EditView, SecretsView } from "../views/auth-model";
import { AuthResultPage } from "../views/auth-result";

export interface SecretRoutesDeps {
  cfg: Config;
  db: Database;
  manifest: Manifest;
  session: MiddlewareHandler<AppEnv>;
  apiSession: MiddlewareHandler<AppEnv>;
  secrets: SecretActions | null;
  now?: () => number;
}

export const authTabPath = (serviceId: string) => `/services/${encodeURIComponent(serviceId)}?tab=auth`;

export function secretsView(
  d: Pick<SecretRoutesDeps, "cfg" | "secrets" | "manifest">,
  serviceId: string,
  session: AuthedSession,
  now = Date.now(),
): SecretsView {
  const edits: EditView[] = d.secrets
    ? d.secrets.store.recent(serviceId, now - RECENT_EDIT_MS).map((r) => ({
        service: r.service,
        cred: r.cred,
        varName: r.var_name,
        stage: r.stage,
        message: r.message,
        editBuild: r.edit_build,
        deployBuild: r.deploy_build,
        commit: r.commit_sha,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    : [];
  return {
    enabled: d.secrets?.canEdit ?? false,
    disabledReason: d.secrets?.blockedReason ?? NOT_CONFIGURED,
    fresh: isFresh(session.reauthAt, d.cfg, now),
    reauthHref: reauthHref(d.cfg, authTabPath(serviceId)),
    revealSeconds: d.cfg.SECRETS_REVEAL_SECONDS,
    reauthMinutes: Math.round(d.cfg.SECRETS_REAUTH_SECONDS / 60),
    job: d.cfg.SECRETS_JOB,
    applyJob: d.cfg.SECRETS_APPLY_JOB,
    edits,
    now,
  };
}

export function secretsSignature(v: SecretsView): string[] {
  return [`secrets:${v.enabled}:${v.fresh}`, ...v.edits.map((e) => [e.cred, e.stage, e.editBuild ?? "", e.deployBuild ?? "", e.message ?? ""].join("|"))];
}

type Html = { toString(): string | Promise<string> };
const page = async (node: Html) => "<!doctype html>" + String(await node.toString());

export function secretRoutes(d: SecretRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const index = indexManifest(d.manifest);
  const fresh = (api: boolean) => requireFresh(d.cfg, { api, next: (c) => authTabPath(c.req.param("id") ?? "") }, d.now);
  const chromeOf = (c: Context<AppEnv>) => ({ login: c.get("session").login, csrf: c.get("session").csrf });

  const lookup = (c: Context<AppEnv>) => {
    const svc = index.byId.get(c.req.param("id") ?? "");
    const cred = svc ? findCredential(d.manifest, svc, c.req.param("key") ?? "") : null;
    return svc && cred ? { svc, cred } : null;
  };

  const result = async (c: Context<AppEnv>, status: 200 | 400 | 403 | 404 | 409 | 502 | 503, p: { title: string; message: string; serviceId: string | null; once?: { label: string; value: string } }) => {
    c.header("cache-control", "no-store");
    const svc = p.serviceId ? index.byId.get(p.serviceId) : undefined;
    return c.html(
      await page(AuthResultPage({ chrome: chromeOf(c), title: p.title, message: p.message, backHref: svc ? authTabPath(svc.id) : "/services", serviceName: svc?.name ?? null, once: p.once, ok: status === 200 })),
      status,
    );
  };

  app.post("/services/:id/auth/:key/reveal", d.apiSession, csrfGuard(), fresh(true), async (c) => {
    c.header("cache-control", "no-store");
    if (!d.secrets) return c.json({ message: "Secrets are not available." }, 503);
    const r = await d.secrets.reveal(c.get("session").login, c.req.param("id"), c.req.param("key"));
    return r.ok ? c.json({ value: r.value }) : c.json({ message: r.message }, r.status);
  });

  app.post("/services/:id/auth/:key/rotate", d.session, csrfGuard(), fresh(false), async (c) => {
    const found = lookup(c);
    if (!found) return result(c, 404, { title: "Not found", message: "There is no such credential.", serviceId: null });
    const { svc, cred } = found;
    if (!d.secrets?.canEdit) return result(c, 503, { title: "Rotation is not available", message: d.secrets?.blockedReason ?? NOT_CONFIGURED, serviceId: svc.id });
    if (!cred.rotatable) return result(c, 403, { title: "Not rotatable", message: `${cred.label} is not on the rotation list, so the panel will not replace it with a random value.`, serviceId: svc.id });
    const value = generatePassword();
    const r = await d.secrets.edit(c.get("session").login, svc.id, cred.id, value);
    if (!r.ok) return result(c, r.outcome === "busy" ? 409 : r.outcome === "rejected" ? 403 : 502, { title: `${cred.label} was not rotated`, message: r.message, serviceId: svc.id });
    return result(c, 200, {
      title: `${cred.label} is being rotated`,
      message: `This is the only time the panel shows the new ${cred.source === "hash" ? "password" : "value"}. It is on its way to ${d.cfg.SECRETS_JOB} and takes effect when ${d.cfg.SECRETS_APPLY_JOB} finishes. The Auth tab shows the progress.`,
      serviceId: svc.id,
      once: { label: cred.source === "hash" ? `${cred.user} password` : cred.label, value },
    });
  });

  app.post("/services/:id/auth/:key", d.session, csrfGuard(), fresh(false), async (c) => {
    const found = lookup(c);
    if (!found) return result(c, 404, { title: "Not found", message: "There is no such credential.", serviceId: null });
    const { svc, cred } = found;
    if (!d.secrets?.canEdit) return result(c, 503, { title: "Editing is not available", message: d.secrets?.blockedReason ?? NOT_CONFIGURED, serviceId: svc.id });
    const body = await c.req.parseBody();
    const raw = body["value"];
    const r = await d.secrets.edit(c.get("session").login, svc.id, cred.id, typeof raw === "string" ? raw : "");
    if (!r.ok) return result(c, r.outcome === "busy" ? 409 : r.outcome === "rejected" ? 400 : 502, { title: `${cred.label} was not changed`, message: r.message, serviceId: svc.id });
    return c.redirect(authTabPath(svc.id), 303);
  });

  return app;
}
