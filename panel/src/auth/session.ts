import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config";
import {
  deleteSession,
  findSession,
  insertSession,
  markReauth,
  purgeExpiredSessions,
  touchSession,
} from "../db";

export const SESSION_COOKIE = "vp_session";
export const OAUTH_STATE_COOKIE = "vp_oauth_state";
export const OAUTH_NEXT_COOKIE = "vp_oauth_next";
export const CSRF_FIELD = "_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_TOUCH_EVERY_MS = 60_000;
export const GITHUB_LOGIN_PATH = "/auth/github";
export const DEV_LOGIN_ROUTE = "/auth/dev";

export interface AuthedSession {
  login: string;
  idHash: string;
  csrf: string;
  reauthAt: number;
}

export type AppEnv = { Variables: { session: AuthedSession } };

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const hmac = (secret: string, v: string) => createHmac("sha256", secret).update(v).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function csrfFor(cfg: Config, sessionToken: string): string {
  return hmac(cfg.SESSION_SECRET, `csrf:${sessionToken}`);
}

export function createSession(db: Database, cfg: Config, c: Context, login: string, now = Date.now()): void {
  const token = randomBytes(32).toString("base64url");
  insertSession(db, {
    id_hash: sha256(token),
    login,
    created_at: now,
    last_seen_at: now,
    reauth_at: now,
    expires_at: now + cfg.SESSION_TTL_SECONDS * 1000,
  });
  purgeExpiredSessions(db, now);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: cfg.SESSION_TTL_SECONDS,
  });
}

export function establishLogin(
  db: Database,
  cfg: Config,
  c: Context,
  login: string,
  now = Date.now(),
): "reauthenticated" | "created" {
  const token = getCookie(c, SESSION_COOKIE);
  const row = token ? findSession(db, sha256(token), now) : null;
  if (row && row.login.toLowerCase() === login.toLowerCase()) {
    markReauth(db, row.id_hash, now);
    return "reauthenticated";
  }
  createSession(db, cfg, c, login, now);
  return "created";
}

export function isFresh(reauthAt: number, cfg: Pick<Config, "SECRETS_REAUTH_SECONDS">, now = Date.now()): boolean {
  return now - reauthAt < cfg.SECRETS_REAUTH_SECONDS * 1000;
}

export function reauthHref(cfg: Pick<Config, "devAuthBypass">, next: string): string {
  return `${cfg.devAuthBypass ? DEV_LOGIN_ROUTE : GITHUB_LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

export function requireFresh(
  cfg: Pick<Config, "SECRETS_REAUTH_SECONDS" | "devAuthBypass">,
  opts: { api: boolean; next: (c: Context<AppEnv>) => string },
  clock: () => number = Date.now,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isFresh(c.get("session").reauthAt, cfg, clock())) return next();
    const url = reauthHref(cfg, opts.next(c));
    if (opts.api) return c.json({ error: "reauth-required", reauth: url }, 401);
    return c.redirect(url, 303);
  };
}

export function destroySession(db: Database, c: Context): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) deleteSession(db, sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function signState(cfg: Config, state: string): string {
  return `${state}.${hmac(cfg.SESSION_SECRET, `oauth:${state}`)}`;
}

export function verifyState(cfg: Config, signed: string | undefined, state: string | undefined): boolean {
  if (!signed || !state) return false;
  return safeEqual(signed, signState(cfg, state));
}

export function requireSession(db: Database, cfg: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const now = Date.now();
    const row = token ? findSession(db, sha256(token), now) : null;
    if (!token || !row) return c.redirect("/login", 303);
    if (now - row.last_seen_at >= SESSION_TOUCH_EVERY_MS) touchSession(db, row.id_hash, now);
    c.set("session", {
      login: row.login,
      idHash: row.id_hash,
      csrf: csrfFor(cfg, token),
      reauthAt: row.reauth_at,
    });
    await next();
  };
}

export function originGuard(cfg: Config): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const origin = c.req.header("origin");
    if (origin !== cfg.origin) return c.text("forbidden origin", 403);
    return next();
  };
}

export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    let supplied = c.req.header(CSRF_HEADER);
    if (!supplied) {
      const ct = c.req.header("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const v = body[CSRF_FIELD];
        supplied = typeof v === "string" ? v : undefined;
      }
    }
    if (!supplied || !safeEqual(supplied, c.get("session").csrf)) return c.text("invalid csrf token", 403);
    return next();
  };
}
