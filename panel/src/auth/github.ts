import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config";
import { audit, trimAudit, trimAuditOutcome } from "../db";
import { localPath } from "./dev";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_NEXT_COOKIE,
  type AppEnv,
  csrfGuard,
  destroySession,
  establishLogin,
  requireSession,
  signState,
  verifyState,
} from "./session";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const GITHUB_TIMEOUT_MS = 5000;
const ANONYMOUS = "anonymous";

export interface GithubUser {
  login: string;
  id: number;
}

export interface GithubClient {
  loginForCode(code: string): Promise<GithubUser>;
}

export function githubClient(cfg: Config, fetchImpl: typeof fetch = fetch): GithubClient {
  return {
    async loginForCode(code) {
      const tokenRes = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: cfg.GITHUB_CLIENT_ID,
          client_secret: cfg.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${cfg.origin}/auth/github/callback`,
        }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      const tokenBody = (await tokenRes.json()) as { access_token?: string };
      if (!tokenRes.ok || !tokenBody.access_token) throw new Error("token exchange failed");
      const userRes = await fetchImpl(USER_URL, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "vespiridion-panel",
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      const user = (await userRes.json()) as { login?: string; id?: number };
      if (!userRes.ok || !user.login || typeof user.id !== "number") throw new Error("user lookup failed");
      return { login: user.login, id: user.id };
    },
  };
}

export function authRoutes(db: Database, cfg: Config, gh: GithubClient): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/auth/github", (c) => {
    const state = randomBytes(16).toString("base64url");
    const next = c.req.query("next");
    if (next) {
      setCookie(c, OAUTH_NEXT_COOKIE, localPath(next, cfg.origin), {
        httpOnly: true,
        secure: cfg.secureCookies,
        sameSite: "Lax",
        path: "/auth/github",
        maxAge: 600,
      });
    }
    setCookie(c, OAUTH_STATE_COOKIE, signState(cfg, state), {
      httpOnly: true,
      secure: cfg.secureCookies,
      sameSite: "Lax",
      path: "/auth/github",
      maxAge: 600,
    });
    const q = new URLSearchParams({
      client_id: cfg.GITHUB_CLIENT_ID,
      redirect_uri: `${cfg.origin}/auth/github/callback`,
      state,
      scope: "",
      allow_signup: "false",
    });
    return c.redirect(`${AUTHORIZE_URL}?${q}`, 302);
  });

  const anonymous = (outcome: string, detail?: string) => {
    audit(db, { actor: ANONYMOUS, action: "login", outcome, detail });
    trimAudit(db, ANONYMOUS, cfg.AUDIT_ANON_MAX_ROWS);
  };

  app.get("/auth/github/callback", async (c) => {
    const signed = getCookie(c, OAUTH_STATE_COOKIE);
    const next = getCookie(c, OAUTH_NEXT_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/auth/github" });
    deleteCookie(c, OAUTH_NEXT_COOKIE, { path: "/auth/github" });
    const code = c.req.query("code");
    if (!verifyState(cfg, signed, c.req.query("state")) || !code) {
      anonymous("bad-state");
      return c.text("invalid oauth state", 400);
    }
    let user: GithubUser;
    try {
      user = await gh.loginForCode(code);
    } catch (err) {
      anonymous("github-error", String(err));
      return c.text("github login failed", 502);
    }
    const { login } = user;
    const loginMatches = login.toLowerCase() === cfg.GITHUB_ALLOWED_LOGIN.toLowerCase();
    const idMatches = cfg.GITHUB_ALLOWED_ID === undefined || user.id === cfg.GITHUB_ALLOWED_ID;
    if (!loginMatches || !idMatches) {
      audit(db, { actor: login, action: "login", outcome: "denied", detail: loginMatches ? "login matches but the account id does not" : undefined });
      trimAuditOutcome(db, "login", "denied", cfg.AUDIT_ANON_MAX_ROWS);
      return c.text("forbidden", 403);
    }
    const how = establishLogin(db, cfg, c, login);
    audit(db, { actor: login, action: "login", outcome: how === "created" ? "ok" : "reauth" });
    return c.redirect(localPath(next, cfg.origin), 303);
  });

  app.post("/logout", requireSession(db, cfg), csrfGuard(), (c) => {
    audit(db, { actor: c.get("session").login, action: "logout", outcome: "ok" });
    destroySession(db, c);
    return c.redirect("/login", 303);
  });

  return app;
}
