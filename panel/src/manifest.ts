import { z } from "zod";

const host = z.enum(["vps", "jenkins", "w1"]);

const service = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  tags: z.array(z.string()),
  playbook: z.string().min(1),
  host,
  dir: z.string().startsWith("/"),
  containers: z.array(z.string().min(1)).min(1),
  images: z.array(z.string().min(1)),
  hostname: z.string().min(1).nullable(),
  jenkins_job: z.string().min(1).nullable(),
  db: z.array(z.object({ kind: z.enum(["mariadb", "postgres", "redis"]), container: z.string().min(1) })),
  core: z.boolean(),
  auth: z.object({
    kind: z.enum(["basic-auth-hash", "env", "vault", "none"]),
    vault_vars: z.array(z.string()),
    env_keys: z.array(z.string()),
    env_vars: z.record(z.string().min(1), z.string().min(1)).default({}),
    hash: z.object({ var: z.string().min(1), user: z.string().min(1), note: z.string().optional() }).optional(),
  }),
});

const secrets = z.object({
  editable: z.array(z.string().min(1)).default([]),
  locked: z.record(z.string().min(1), z.string()).default({}),
  rotatable: z.array(z.string().min(1)).default([]),
  min_length: z.record(z.string().min(1), z.number().int().positive()).default({}),
});

const manifestSchema = z
  .object({ services: z.array(service).min(1), secrets: secrets.default({ editable: [], locked: {}, rotatable: [], min_length: {} }) })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    const containers = new Set<string>();
    m.services.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["services", i, "id"], message: `duplicate id: ${s.id}` });
      ids.add(s.id);
      for (const c of s.containers) {
        const key = `${s.host}/${c}`;
        if (containers.has(key)) {
          ctx.addIssue({ code: "custom", path: ["services", i, "containers"], message: `duplicate container: ${key}` });
        }
        containers.add(key);
      }
      for (const d of s.db) {
        if (!s.containers.includes(d.container)) {
          ctx.addIssue({ code: "custom", path: ["services", i, "db"], message: `db container not in service: ${d.container}` });
        }
      }
      if (s.auth.kind === "env" && s.auth.env_keys.length === 0) {
        ctx.addIssue({ code: "custom", path: ["services", i, "auth", "env_keys"], message: "env auth needs env_keys" });
      }
      for (const [key, v] of Object.entries(s.auth.env_vars)) {
        if (!s.auth.env_keys.includes(key)) {
          ctx.addIssue({ code: "custom", path: ["services", i, "auth", "env_vars", key], message: `env_vars key not in env_keys: ${key}` });
        }
        if (!s.auth.vault_vars.includes(v)) {
          ctx.addIssue({ code: "custom", path: ["services", i, "auth", "env_vars", key], message: `env_vars value not in vault_vars: ${v}` });
        }
      }
    });
  });

export type ServiceHost = z.infer<typeof host>;
export type Service = z.infer<typeof service>;
export type Manifest = z.infer<typeof manifestSchema>;

export function parseManifest(raw: unknown): Manifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid services manifest: ${detail}`);
  }
  return parsed.data;
}

export async function loadManifest(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (err) {
    throw new Error(`cannot read services manifest ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`services manifest ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseManifest(raw);
}

export interface ManifestIndex {
  byId: Map<string, Service>;
  byContainer: Map<string, Service>;
}

export function indexManifest(m: Manifest): ManifestIndex {
  const byId = new Map<string, Service>();
  const byContainer = new Map<string, Service>();
  for (const s of m.services) {
    byId.set(s.id, s);
    for (const c of s.containers) byContainer.set(`${s.host}/${c}`, s);
  }
  return { byId, byContainer };
}
