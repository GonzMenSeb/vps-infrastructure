import { REGISTRY_PASSWORD, REGISTRY_USER, registryRows, type RegistryRow } from "./registry-fixture";

export interface FakeZot {
  url: string;
  rows: Record<string, RegistryRow[]>;
  requests: { path: string; repo: string | null; authorized: boolean }[];
  failing: { value: boolean };
  stop: () => Promise<void>;
}

const NOT_FOUND = {
  errors: [{ message: "repo metadata not found for given repo name", path: ["ExpandedRepoInfo"] }],
  data: { ExpandedRepoInfo: null },
};

export function startFakeZot(opts: { now?: () => number } = {}): FakeZot {
  const now = opts.now ?? (() => Date.now());
  const rows = registryRows(now());
  const requests: FakeZot["requests"] = [];
  const failing = { value: false };
  const expected = `Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_PASSWORD}`).toString("base64")}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const authorized = req.headers.get("authorization") === expected;
      if (req.method !== "POST" || path !== "/v2/_zot/ext/search") {
        requests.push({ path, repo: null, authorized });
        return new Response("not found", { status: 404 });
      }
      const query = ((await req.json()) as { query?: string }).query ?? "";
      const repo = /ExpandedRepoInfo\(repo:"([^"]+)"\)/.exec(query)?.[1] ?? null;
      requests.push({ path, repo, authorized });
      if (!authorized) return Response.json({ errors: [{ message: "unauthorized" }] }, { status: 401 });
      if (failing.value) return new Response("boom", { status: 500 });
      if (!repo) return Response.json({ errors: [{ message: "fixture only answers ExpandedRepoInfo" }], data: null }, { status: 422 });
      const images = rows[repo];
      if (!images) return Response.json(NOT_FOUND);
      return Response.json({
        data: {
          ExpandedRepoInfo: {
            Images: images.map((r) => ({
              Tag: r.tag,
              Digest: r.digest,
              LastUpdated: r.lastUpdated,
              Size: String(r.size),
              Manifests: [{ ConfigDigest: `sha256:${r.digest.slice(7).split("").reverse().join("")}` }],
            })),
          },
        },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, rows, requests, failing, stop: async () => void (await server.stop(true)) };
}
