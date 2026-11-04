import { REGISTRY_PASSWORD, REGISTRY_USER, digestOf, type RegistryRow } from "./registry-fixture";

export interface FakeZotTag {
  tag: string;
  digest: string;
  lastUpdated: string | null;
  sizeBytes: number;
}

export interface FakeZotRepoSeed {
  name: string;
  builds: { tag: string; ageMin: number; size: number }[];
  buildcache?: boolean;
}

export interface FakeZotOptions {
  now?: () => number;
  repos?: FakeZotRepoSeed[];
  user?: string;
  password?: string;
}

export interface FakeZot {
  url: string;
  requests: { method: string; path: string }[];
  deletes: { repo: string; ref: string }[];
  state: Map<string, FakeZotTag[]>;
  rows: () => Record<string, RegistryRow[]>;
  setDown: (down: boolean) => void;
  ignoreDeletes: (on: boolean) => void;
  breakRepo: (name: string, on?: boolean) => void;
  stop: () => Promise<void>;
}

export const DEFAULT_REPOS: FakeZotRepoSeed[] = [
  { name: "miplata/api", builds: [{ tag: "412", ageMin: 120, size: 412e6 }, { tag: "411", ageMin: 1440, size: 410e6 }, { tag: "410", ageMin: 4320, size: 408e6 }], buildcache: true },
  { name: "miplata/web", builds: [{ tag: "412", ageMin: 121, size: 86e6 }, { tag: "411", ageMin: 1441, size: 85e6 }] },
  { name: "miplata/categorizer", builds: [{ tag: "88", ageMin: 8640, size: 1.1e9 }, { tag: "87", ageMin: 12960, size: 1.09e9 }] },
  { name: "losprompteros/decabot", builds: [{ tag: "8d19b6c", ageMin: 17280, size: 640e6 }] },
  { name: "judicabot/judicabot", builds: [{ tag: "c19ab44", ageMin: 84, size: 150e6 }, { tag: "3ee016f", ageMin: 312, size: 150e6 }, { tag: "32f1bd4", ageMin: 360, size: 150e6 }], buildcache: true },
  { name: "coros/huella", builds: [{ tag: "a1b2c3d", ageMin: 1800, size: 150e6 }] },
  { name: "coros/brujula", builds: [{ tag: "a6d25e1", ageMin: 12960, size: 178e6 }, { tag: "1b9ed40", ageMin: 15840, size: 177e6 }] },
  { name: "panel/panel", builds: [{ tag: "5f2e9ab", ageMin: 30, size: 95e6 }] },
];

const notFound = (reference: string) =>
  Response.json({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown", detail: { reference } }] }, { status: 404 });

export function startFakeZot(opts: FakeZotOptions = {}): FakeZot {
  const now = opts.now ?? (() => Date.now());
  const user = opts.user ?? REGISTRY_USER;
  const password = opts.password ?? REGISTRY_PASSWORD;
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const state = new Map<string, FakeZotTag[]>();
  const t0 = now();
  for (const r of opts.repos ?? DEFAULT_REPOS) {
    const tags: FakeZotTag[] = r.builds.map((b) => ({
      tag: b.tag,
      digest: digestOf(r.name, b.tag),
      lastUpdated: new Date(t0 - b.ageMin * 60_000).toISOString(),
      sizeBytes: b.size,
    }));
    const newest = [...tags].sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""))[0];
    if (newest) tags.push({ ...newest, tag: "latest" });
    if (r.buildcache) tags.push({ tag: "buildcache", digest: digestOf(r.name, "buildcache"), lastUpdated: null, sizeBytes: (newest?.sizeBytes ?? 1e8) + 1000 });
    state.set(r.name, tags);
  }

  let down = false;
  let ignore = false;
  const broken = new Set<string>();
  const requests: FakeZot["requests"] = [];
  const deletes: FakeZot["deletes"] = [];

  const summary = (name: string, tags: FakeZotTag[]) => {
    const unique = new Map(tags.map((t) => [t.digest, t.sizeBytes]));
    const dates = tags.map((t) => t.lastUpdated).filter((d): d is string => d !== null).sort();
    return { Name: name, Size: String([...unique.values()].reduce((a, b) => a + b, 0)), LastUpdated: dates.at(-1) ?? null };
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const path = u.pathname;
      requests.push({ method: req.method, path });
      if (down) return new Response("fixture is down", { status: 503 });
      if (req.headers.get("authorization") !== expected) {
        return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="Registry Realm"' } });
      }
      if (req.method === "GET" && path === "/v2/_catalog") return Response.json({ repositories: [...state.keys()].sort() });
      if (path === "/v2/_zot/ext/search" && (req.method === "GET" || req.method === "POST")) {
        const q = req.method === "GET" ? (u.searchParams.get("query") ?? "") : (((await req.json().catch(() => ({}))) as { query?: string }).query ?? "");
        const m = /ExpandedRepoInfo\(repo:"([^"]+)"\)/.exec(q);
        if (!m) return Response.json({ errors: [{ message: "fixture does not answer this query" }], data: null });
        const tags = broken.has(m[1]!) ? undefined : state.get(m[1]!);
        if (!tags) return Response.json({ errors: [{ message: "repo metadata not found for given repo name", path: ["ExpandedRepoInfo"] }], data: null });
        return Response.json({
          data: {
            ExpandedRepoInfo: {
              Summary: summary(m[1]!, tags),
              Images: tags.map((t) => ({
                Tag: t.tag,
                Digest: t.digest,
                LastUpdated: t.lastUpdated,
                Size: String(t.sizeBytes),
                Manifests: [{ ConfigDigest: `sha256:${t.digest.slice(7).split("").reverse().join("")}` }],
              })),
            },
          },
        });
      }
      const m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(path);
      if (m) {
        const repo = decodeURIComponent(m[1]!);
        const ref = decodeURIComponent(m[2]!);
        const tags = state.get(repo);
        if (!tags) return notFound(ref);
        const hit = tags.find((t) => t.tag === ref || t.digest === ref);
        if (req.method === "HEAD") {
          if (!hit) return new Response(null, { status: 404 });
          return new Response(null, { status: 200, headers: { "docker-content-digest": hit.digest, "content-type": "application/vnd.oci.image.manifest.v1+json" } });
        }
        if (req.method === "DELETE") {
          if (!hit) return notFound(ref);
          deletes.push({ repo, ref });
          if (!ignore) {
            const isDigest = ref.startsWith("sha256:");
            state.set(repo, tags.filter((t) => (isDigest ? t.digest !== ref : t.tag !== ref)));
          }
          return new Response(null, { status: 202 });
        }
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    deletes,
    state,
    rows: () => Object.fromEntries([...state].map(([repo, tags]) => [repo, tags.map((t) => ({ tag: t.tag, digest: t.digest, lastUpdated: t.lastUpdated, size: t.sizeBytes }))])),
    setDown: (d) => {
      down = d;
    },
    ignoreDeletes: (on) => {
      ignore = on;
    },
    breakRepo: (name, on = true) => {
      if (on) broken.add(name);
      else broken.delete(name);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
