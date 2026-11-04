import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { start, type Running } from "../src/server";
import { startFixtureUpstreams, type FixtureUpstreams } from "./dev/fixture-upstreams";
import { REGISTRY_HOST, REGISTRY_PASSWORD, REGISTRY_USER } from "./dev/registry-fixture";

let up: FixtureUpstreams;
let running: Running | null;
let dataDir: string;

beforeEach(async () => {
  up = await startFixtureUpstreams({ healthDelayMs: 0 });
  dataDir = mkdtempSync(join(tmpdir(), "vesp-start-"));
  running = null;
});
afterEach(async () => {
  await running?.stop();
  await up.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  await s.stop(true);
  return port;
}

async function boot(extra: Record<string, string>, overrides: Parameters<typeof start>[1] = {}) {
  const port = await freePort();
  running = await start(
    {
      NODE_ENV: "test",
      DEV_AUTH_BYPASS: "1",
      PUBLIC_URL: `http://localhost:${port}`,
      PORT: String(port),
      DATA_DIR: dataDir,
      SERVICES_MANIFEST_PATH: "tests/fixtures/dev-services.json",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      GITHUB_ALLOWED_LOGIN: "owner",
      SESSION_SECRET: "x".repeat(40),
      PROMETHEUS_URL: up.promUrl,
      DOCKER_SOCKET: up.dockerSocket,
      ZOT_URL: up.zot.url,
      ZOT_USER: REGISTRY_USER,
      ZOT_PASSWORD: REGISTRY_PASSWORD,
      ...extra,
    },
    overrides,
  );
  const origin = `http://localhost:${port}`;
  const login = await fetch(`${running.url}/auth/dev?next=/`, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = await (await fetch(`${running.url}/services/vaultwarden`, { headers: { cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${running!.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, ...fields }).toString(),
    });
  const flash = (res: Response) => {
    const raw = /vp_flash=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return raw ? (JSON.parse(decodeURIComponent(raw)) as { ok: boolean; text: string }) : null;
  };
  return { page, post, flash, cookie };
}

describe("start wiring", () => {
  test("under DEV_AUTH_BYPASS without an injected runner, actions are a dry run and never reach compose or docker", async () => {
    const { page, post, flash } = await boot({});
    expect(page).toContain("Dry run is on");
    const res = await post("/services/vaultwarden/switch", { to: "off" });
    expect(res.status).toBe(303);
    expect(flash(res)).toMatchObject({ ok: true, text: expect.stringContaining("Dry run: would run") });
    expect(up.compose.commands).toEqual([]);
    expect(up.docker.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("DRY_RUN_ACTIONS=1 keeps even an injected runner idle", async () => {
    const { post, flash } = await boot({ DRY_RUN_ACTIONS: "1" }, { compose: up.compose });
    expect(flash(await post("/services/vaultwarden/switch", { to: "off" }))).toMatchObject({ text: expect.stringContaining("Dry run") });
    expect(up.compose.commands).toEqual([]);
  });

  test("an injected runner executes against the fake docker and the registry host comes from the manifest", async () => {
    const { page, post, flash, cookie } = await boot({ ACTION_VERIFY_TIMEOUT_MS: "5000" }, { compose: up.compose });
    expect(page).not.toContain("Dry run is on");
    const res = await post("/services/vaultwarden/switch", { to: "off" });
    expect(flash(res)).toMatchObject({ ok: true, text: expect.stringContaining("switched off") });
    expect(up.compose.commands).toEqual([{ dir: "/opt/vaultwarden", args: ["stop"] }]);
    let html = "";
    for (let i = 0; i < 50 && !html.includes("Roll back to 3ee016f"); i++) {
      html = await (await fetch(`${running!.url}/services/judicabot`, { headers: { cookie } })).text();
      await Bun.sleep(100);
    }
    expect(html).toContain("Roll back to 3ee016f");
  });
});

describe("configuration", () => {
  const env = {
    PUBLIC_URL: "https://panel.example.test",
    SERVICES_MANIFEST_PATH: "/opt/panel/services.json",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_ALLOWED_LOGIN: "owner",
    SESSION_SECRET: "x".repeat(40),
  };

  test("actions default to real execution with the documented timeouts", () => {
    const cfg = loadConfig(env);
    expect(cfg).toMatchObject({ dryRunActions: false, ACTION_VERIFY_TIMEOUT_MS: 60_000, ACTION_PULL_TIMEOUT_MS: 300_000, COMPOSE_TIMEOUT_MS: 120_000 });
    expect(cfg.ZOT_REGISTRY_HOST).toBeUndefined();
  });

  test("DRY_RUN_ACTIONS and the registry host are parsed and validated", () => {
    expect(loadConfig({ ...env, DRY_RUN_ACTIONS: "1", ZOT_REGISTRY_HOST: REGISTRY_HOST }).dryRunActions).toBe(true);
    expect(loadConfig({ ...env, DRY_RUN_ACTIONS: "" }).dryRunActions).toBe(false);
    expect(() => loadConfig({ ...env, DRY_RUN_ACTIONS: "yes" })).toThrow(/DRY_RUN_ACTIONS/);
    expect(() => loadConfig({ ...env, ZOT_REGISTRY_HOST: "https://zot.example.test/" })).toThrow(/ZOT_REGISTRY_HOST/);
  });
});
