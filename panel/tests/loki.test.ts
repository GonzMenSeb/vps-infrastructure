import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildQuery, cleanLine, filterKey, FilterError, LokiClient, LokiError, normalizeFilter, registerLokiSources, LOKI_SOURCES } from "../src/collectors/loki";
import { Store } from "../src/store";
import series from "./fixtures/loki-series.json";
import range from "./fixtures/loki-query-range.json";

let server: ReturnType<typeof Bun.serve>;
let client: LokiClient;
const seen: URL[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push(u);
      if (u.pathname === "/loki/api/v1/series") return Response.json(series);
      if (u.pathname === "/loki/api/v1/label/host/values") return Response.json({ status: "success", data: ["vps", "jenkins"] });
      if (u.pathname === "/loki/api/v1/query_range") {
        if (u.searchParams.get("query")?.includes("bad")) return new Response("parse error", { status: 400 });
        return Response.json(range);
      }
      return new Response("nope", { status: 404 });
    },
  });
  client = new LokiClient(`http://127.0.0.1:${server.port}/`, { now: () => 1_793_754_200_000 });
});

afterAll(() => server.stop(true));

describe("filters", () => {
  test("builds a selector with safe quoting", () => {
    expect(buildQuery({})).toBe('{host=~".+"}');
    expect(buildQuery({ host: "vps", container: "traefik" })).toBe('{host="vps",container="traefik"}');
    expect(buildQuery({ container: "traefik", text: "Err.or(1)" })).toBe('{host=~".+",container="traefik"} |~ `(?i)Err\\.or\\(1\\)`');
  });

  test("rejects label injection and unsafe text", () => {
    expect(() => buildQuery({ container: 'a"} or {x="' })).toThrow(FilterError);
    expect(() => buildQuery({ host: "a b" })).toThrow(FilterError);
    expect(() => buildQuery({ text: "back`tick" })).toThrow(FilterError);
    expect(() => buildQuery({ text: "x".repeat(201) })).toThrow(FilterError);
    expect(() => buildQuery({ text: "line\nbreak" })).toThrow(FilterError);
  });

  test("normalizes blanks and keys case-insensitively on text", () => {
    expect(normalizeFilter({ host: " ", container: "a", text: "" })).toEqual({ container: "a" });
    expect(filterKey({ container: "a", text: "ERR" })).toBe(filterKey({ container: "a", text: "err" }));
    expect(filterKey({ container: "a" })).not.toBe(filterKey({ container: "b" }));
  });

  test("strips ANSI and truncates", () => {
    expect(cleanLine("\u001b[90mhi\u001b[0m there").line).toBe("hi there");
    expect(cleanLine("abcdef", 3)).toEqual({ line: "abc", truncated: true });
  });
});

describe("LokiClient", () => {
  test("targets collapse series into host/container pairs", async () => {
    const t = await client.targets();
    expect(t.targets).toEqual([
      { host: "jenkins", container: "jenkins" },
      { host: "vps", container: "grafana" },
      { host: "vps", container: "traefik" },
    ]);
    expect(t.hosts).toEqual(["jenkins", "vps"]);
    expect(t.envs).toEqual(["prod"]);
  });

  test("labelValues validates the label name", async () => {
    expect(await client.labelValues("host")).toEqual(["jenkins", "vps"]);
    await expect(client.labelValues("a/b")).rejects.toThrow(FilterError);
  });

  test("backlog returns ascending, cleaned lines and ignores structured metadata", async () => {
    const lines = await client.backlog({ container: "traefik" }, { limit: 50 });
    expect(lines.map((l) => l.ts)).toEqual(["1793754093111364825", "1793754093500000000", "1793754094496102565"]);
    expect(lines[0]!.line).toBe("2026-11-04T01:01:33 [INFO] : request 192.0.2.1 for url /loki/api/v1/push");
    expect(lines[0]!.level).toBe("info");
    expect(lines[1]).toMatchObject({ line: "plain <b>html</b> line", level: null, host: "vps", container: "traefik" });
    const u = seen.at(-1)!;
    expect(u.searchParams.get("direction")).toBe("backward");
    expect(u.searchParams.get("limit")).toBe("50");
  });

  test("backlog is bounded and can resume forward", async () => {
    await client.backlog({}, { limit: 999_999 });
    expect(seen.at(-1)!.searchParams.get("limit")).toBe("1000");
    await client.backlog({}, { afterNs: "1793754094496102565" });
    const u = seen.at(-1)!;
    expect(u.searchParams.get("direction")).toBe("forward");
    expect(u.searchParams.get("start")).toBe("1793754094496102566");
    await expect(client.backlog({}, { afterNs: "abc" })).rejects.toThrow(FilterError);
  });

  test("surfaces Loki errors", async () => {
    await expect(client.backlog({ text: "bad" })).rejects.toThrow(/HTTP 400 parse error/);
    const bad = new LokiClient(`http://127.0.0.1:${server.port}/nope`);
    await expect(bad.targets()).rejects.toThrow(LokiError);
  });

  test("tail url uses ws and carries query, start, limit", () => {
    const u = new URL(client.tailUrl({ container: "traefik" }, "5", 10));
    expect(u.protocol).toBe("ws:");
    expect(u.pathname).toBe("/loki/api/v1/tail");
    expect(u.searchParams.get("query")).toBe('{host=~".+",container="traefik"}');
    expect(u.searchParams.get("start")).toBe("5");
  });

  test("registers a store source", async () => {
    const store = new Store();
    registerLokiSources(store, client, { timeoutMs: 2000, failureThreshold: 3, cooldownMs: 1000 });
    const snap = await store.refresh<{ hosts: string[] }>(LOKI_SOURCES.targets);
    expect(snap.data?.hosts).toEqual(["jenkins", "vps"]);
  });
});
