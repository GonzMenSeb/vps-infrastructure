import { Hono, type Context, type MiddlewareHandler } from "hono";
import { type AppEnv, csrfGuard } from "../auth/session";
import type { RollbackActions } from "../actions/rollback";
import { TAG_NAME } from "../actions/rollback-select";
import type { ServiceActionResult, ServiceActions, ServiceLocks } from "../actions/service";

export interface ServiceDeps {
  actions: ServiceActions;
  rollback: RollbackActions;
  locks: ServiceLocks;
  dryRun: boolean;
  registryHost: string | null;
  zotConfigured: boolean;
  verifyTimeoutMs: number;
}

export interface ServiceActionRouteDeps {
  session: MiddlewareHandler<AppEnv>;
  service: ServiceDeps;
  flash: (c: Context<AppEnv>, r: { ok: boolean; message: string }) => void;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function serviceActionRoutes(d: ServiceActionRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const finish = (c: Context<AppEnv>, id: string, r: ServiceActionResult): Response => {
    if (r.code === "not_found") return c.text(r.message, 404);
    if (r.code === "forbidden") return c.text(r.message, 403);
    d.flash(c, r);
    return c.redirect(`/services/${encodeURIComponent(id)}`, 303);
  };

  app.post("/services/:id/switch", d.session, csrfGuard(), async (c) => {
    const id = c.req.param("id");
    const to = (await c.req.parseBody()).to;
    if (to !== "on" && to !== "off") return c.text("invalid switch target", 400);
    return finish(c, id, await d.service.actions.switchService(id, to, c.get("session").login));
  });

  app.post("/services/:id/rollback", d.session, csrfGuard(), async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const to = typeof body.to === "string" ? body.to : "";
    const digest = typeof body.digest === "string" ? body.digest : "";
    if (!TAG_NAME.test(to) || !DIGEST.test(digest)) return c.text("invalid rollback target", 400);
    return finish(c, id, await d.service.rollback.rollback(id, { to, digest }, c.get("session").login));
  });

  return app;
}
