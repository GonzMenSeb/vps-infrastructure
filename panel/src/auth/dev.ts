import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { type Config, DEV_ENVS } from "../config";
import { audit } from "../db";
import { type AppEnv, createSession } from "./session";

export const DEV_LOGIN_PATH = "/auth/dev";

export function localPath(v: string | undefined, origin: string): string {
  if (!v?.startsWith("/")) return "/";
  try {
    const u = new URL(v, origin);
    return u.origin === origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

export function devAuthRoutes(db: Database, cfg: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (!cfg.devAuthBypass || !DEV_ENVS.includes(cfg.NODE_ENV)) return app;
  app.get(DEV_LOGIN_PATH, (c) => {
    createSession(db, cfg, c, cfg.GITHUB_ALLOWED_LOGIN);
    audit(db, { actor: cfg.GITHUB_ALLOWED_LOGIN, action: "login", outcome: "dev-bypass" });
    return c.redirect(localPath(c.req.query("next"), cfg.origin), 303);

  });
  return app;
}
