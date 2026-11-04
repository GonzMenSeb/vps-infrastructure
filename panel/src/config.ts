import { z } from "zod";

const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optional = <T extends z.ZodType>(t: T) => z.preprocess(blankToUndefined, t.optional());

export const DEV_ENVS: readonly (string | undefined)[] = ["development", "test"];

const schema = z
  .object({
    NODE_ENV: optional(z.string()),
    PUBLIC_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(3000),
    PANEL_HOST: optional(z.string()),
    DATA_DIR: z.string().min(1).default("/data"),
    SERVICES_MANIFEST_PATH: z.string().min(1),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    GITHUB_ALLOWED_LOGIN: z.string().min(1),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),
    PROMETHEUS_URL: z.string().url().default("http://prometheus:9090"),
    LOKI_URL: optional(z.string().url()),
    ZOT_URL: optional(z.string().url()),
    ZOT_USER: optional(z.string()),
    ZOT_PASSWORD: optional(z.string()),
    ZOT_GC_DELAY: z.string().min(1).default("1h"),
    ZOT_GC_INTERVAL: z.string().min(1).default("24h"),
    PDNS_API_URL: optional(z.string().url()),
    PDNS_API_KEY: optional(z.string()),
    PDNS_DB_CONTAINER: z.string().min(1).default("pdns-db"),
    JENKINS_URL: optional(z.string().url()),
    JENKINS_USER: optional(z.string()),
    JENKINS_TOKEN: optional(z.string()),
    DOCKER_SOCKET: z.string().min(1).default("/var/run/docker.sock"),
    TIME_ZONE: z.string().min(1).default("UTC"),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
    BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(15000),
    POLL_DEMAND_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    POLL_IDLE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    POLL_TICK_MS: z.coerce.number().int().positive().default(1000),
    HEALTH_MAX_LOOP_LAG_MS: z.coerce.number().int().positive().default(500),
    HEALTH_MIN_SNAPSHOT_AGE_MS: z.coerce.number().int().positive().default(120000),
    AUDIT_ANON_MAX_ROWS: z.coerce.number().int().positive().default(10_000),
    DEV_AUTH_BYPASS: optional(z.enum(["0", "1"])),
  })
  .superRefine((v, ctx) => {
    if (v.DEV_AUTH_BYPASS === "1" && !DEV_ENVS.includes(v.NODE_ENV)) {
      ctx.addIssue({ code: "custom", path: ["DEV_AUTH_BYPASS"], message: "needs NODE_ENV=development or NODE_ENV=test" });
    }
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: v.TIME_ZONE });
    } catch {
      ctx.addIssue({ code: "custom", path: ["TIME_ZONE"], message: `unknown time zone ${v.TIME_ZONE}` });
    }
  });

export type Config = z.infer<typeof schema> & { origin: string; secureCookies: boolean; devAuthBypass: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${detail}`);
  }
  const url = new URL(parsed.data.PUBLIC_URL);
  return {
    ...parsed.data,
    origin: url.origin,
    secureCookies: url.protocol === "https:",
    devAuthBypass: parsed.data.DEV_AUTH_BYPASS === "1" && DEV_ENVS.includes(parsed.data.NODE_ENV),

  };
}
