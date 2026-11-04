import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/manifest";
import { parseImageRef, planRollback, rollbackRepos, rollbackTarget, timestampKey, type RegistryTag } from "../src/actions/rollback-select";

const D = (n: number) => `sha256:${n.toString(16).padStart(8, "0")}`;
const t = (tag: string, digest: number, lastUpdated: string | null, configDigest?: number): RegistryTag => ({
  tag,
  digest: D(digest),
  configDigests: configDigest === undefined ? [] : [D(configDigest)],
  lastUpdated,
});

const judicabot: RegistryTag[] = [
  t("c19ab44", 1, "2026-11-03T20:08:43.323909681Z"),
  t("latest", 1, "2026-11-03T20:08:43.323909681Z"),
  t("3ee016f", 2, "2026-11-03T15:26:32.141569121Z"),
  t("32f1bd4", 3, "2026-11-03T14:49:37.075902772Z"),
  t("6597a89", 4, "2026-11-03T14:43:00.656121663Z"),
  t("buildcache", 5, null),
];

describe("planRollback with short git sha tags", () => {
  test("current is the tag sharing latest's digest and previous is the next most recent other tag", () => {
    const p = planRollback(judicabot);
    expect(p).toMatchObject({
      ok: true,
      rolledBack: false,
      current: { tag: "c19ab44", aliases: [], digest: D(1) },
      previous: { tag: "3ee016f", aliases: [], digest: D(2), lastUpdated: "2026-11-03T15:26:32.141569121Z" },
    });
  });

  test("input order does not matter", () => {
    const p = planRollback([...judicabot].reverse());
    expect(p).toMatchObject({ ok: true, current: { tag: "c19ab44" }, previous: { tag: "3ee016f" } });
  });

  test("buildcache is never the previous version, even when it is the only other tag", () => {
    const p = planRollback([t("latest", 1, "2026-11-03T20:00:00Z"), t("c19ab44", 1, "2026-11-03T20:00:00Z"), t("buildcache", 5, "2026-11-04T00:00:00Z")]);
    expect(p.ok).toBe(false);
  });

  test("tags dated nanoseconds apart are ordered by the fractional part", () => {
    const p = planRollback([
      t("latest", 1, "2026-11-03T20:00:00.000000100Z"),
      t("aaaaaaa", 2, "2026-11-03T19:00:00.100000002Z"),
      t("bbbbbbb", 3, "2026-11-03T19:00:00.100000009Z"),
    ]);
    expect(p).toMatchObject({ ok: true, previous: { tag: "bbbbbbb" } });
  });
});

describe("planRollback with build number tags", () => {
  const miplata = [
    t("latest", 10, "2026-11-03T10:00:00Z"),
    t("42", 10, "2026-11-03T10:00:00Z"),
    t("41", 9, "2026-11-02T10:00:00Z"),
    t("40", 8, "2026-11-01T10:00:00Z"),
    t("9", 7, "2026-10-01T10:00:00Z"),
  ];

  test("previous is the most recently pushed build, not the largest string", () => {
    expect(planRollback(miplata)).toMatchObject({ ok: true, current: { tag: "42" }, previous: { tag: "41" } });
  });

  test("a rebuilt older number is picked by push time rather than by number", () => {
    const p = planRollback([...miplata, t("39", 6, "2026-11-03T09:00:00Z")]);
    expect(p).toMatchObject({ ok: true, previous: { tag: "39" } });
  });

  test("equal push times between digests fall back to the higher build number", () => {
    const p = planRollback([t("latest", 10, "2026-11-03T10:00:00Z"), t("42", 10, "2026-11-03T10:00:00Z"), t("7", 3, "2026-11-02T10:00:00Z"), t("12", 4, "2026-11-02T10:00:00Z")]);
    expect(p).toMatchObject({ ok: true, previous: { tag: "12", digest: D(4) } });
  });
});

describe("planRollback ties and aliases", () => {
  test("several tags on the current digest are all current, the shortest first", () => {
    const p = planRollback([
      t("latest", 1, "2026-11-03T10:00:00Z"),
      t("c19ab44-rc1", 1, "2026-11-03T10:00:00Z"),
      t("c19ab44", 1, "2026-11-03T10:00:00Z"),
      t("3ee016f", 2, "2026-11-02T10:00:00Z"),
    ]);
    expect(p).toMatchObject({ ok: true, current: { tag: "c19ab44", aliases: ["c19ab44-rc1"] }, previous: { tag: "3ee016f" } });
  });

  test("several tags on the previous digest collapse into one previous version", () => {
    const p = planRollback([
      t("latest", 1, "2026-11-03T10:00:00Z"),
      t("c19ab44", 1, "2026-11-03T10:00:00Z"),
      t("3ee016f-hotfix", 2, "2026-11-02T10:00:00Z"),
      t("3ee016f", 2, "2026-11-02T10:00:00Z"),
      t("32f1bd4", 3, "2026-11-01T10:00:00Z"),
    ]);
    expect(p).toMatchObject({ ok: true, previous: { tag: "3ee016f", aliases: ["3ee016f-hotfix"], digest: D(2) } });
  });

  test("a tag newer than latest is not a previous version", () => {
    const p = planRollback([t("latest", 1, "2026-11-03T10:00:00Z"), t("c19ab44", 1, "2026-11-03T10:00:00Z"), t("feature", 9, "2026-11-04T10:00:00Z"), t("3ee016f", 2, "2026-11-02T10:00:00Z")]);
    expect(p).toMatchObject({ ok: true, previous: { tag: "3ee016f" } });
  });
});

describe("planRollback has nothing to offer", () => {
  test("an empty repository", () => {
    expect(planRollback([])).toMatchObject({ ok: false, reason: expect.stringContaining("no tags") });
  });

  test("no latest tag", () => {
    expect(planRollback([t("c19ab44", 1, "2026-11-03T10:00:00Z")])).toMatchObject({ ok: false, reason: expect.stringContaining(":latest") });
  });

  test("a single tag next to latest has no previous version", () => {
    const p = planRollback([t("latest", 1, "2026-11-03T10:00:00Z"), t("c19ab44", 1, "2026-11-03T10:00:00Z")]);
    expect(p).toMatchObject({ ok: false, reason: expect.stringContaining("Only one build") });
  });

  test("latest alone and latest plus buildcache only", () => {
    expect(planRollback([t("latest", 1, "2026-11-03T10:00:00Z")]).ok).toBe(false);
    expect(planRollback([t("latest", 1, "2026-11-03T10:00:00Z"), t("buildcache", 2, null)])).toMatchObject({ ok: false, reason: expect.stringContaining("Only one build") });
  });

  test("tags that are not valid docker tags are ignored", () => {
    const p = planRollback([t("latest", 1, "2026-11-03T10:00:00Z"), t("c19ab44", 1, "2026-11-03T10:00:00Z"), t("../x?y", 2, "2026-11-02T10:00:00Z")]);
    expect(p.ok).toBe(false);
  });

  test("tags without a push time cannot be ordered and are skipped", () => {
    const p = planRollback([t("latest", 1, "2026-11-03T10:00:00Z"), t("c19ab44", 1, "2026-11-03T10:00:00Z"), t("mystery", 2, null)]);
    expect(p.ok).toBe(false);
  });
});

describe("planRollback follows what is running", () => {
  test("after a rollback the running image is current and previous is the one before it", () => {
    const p = planRollback(judicabot, [D(2)]);
    expect(p).toMatchObject({
      ok: true,
      rolledBack: true,
      latestDigest: D(1),
      current: { tag: "3ee016f" },
      previous: { tag: "32f1bd4" },
    });
  });

  test("the running image is matched by manifest digest or config digest", () => {
    const withConfig = judicabot.map((i) => (i.tag === "3ee016f" ? { ...i, configDigests: [D(99)] } : i));
    expect(planRollback(withConfig, [D(99)])).toMatchObject({ ok: true, rolledBack: true, current: { tag: "3ee016f" } });
  });

  test("an unknown running image falls back to latest", () => {
    expect(planRollback(judicabot, ["sha256:feedface"])).toMatchObject({ ok: true, rolledBack: false, current: { tag: "c19ab44" } });
  });

  test("running the oldest tag leaves nothing to go back to", () => {
    expect(planRollback(judicabot, [D(4)])).toMatchObject({ ok: false, reason: expect.stringContaining("older than 6597a89") });
  });
});

describe("timestampKey", () => {
  test("parses RFC 3339 with nanoseconds and rejects junk", () => {
    expect(timestampKey("2026-11-03T20:08:43.323909681Z")! % 1_000_000_000n).toBe(323909681n);
    expect(timestampKey("2026-11-03T20:08:43Z")! % 1_000_000_000n).toBe(0n);
    expect(timestampKey("yesterday")).toBeNull();
    expect(timestampKey(null)).toBeNull();
  });
});

describe("parseImageRef and rollbackTarget", () => {
  test("splits registry, repo and tag", () => {
    expect(parseImageRef("zot.web.example.test/judicabot/judicabot:latest")).toEqual({
      registry: "zot.web.example.test",
      repo: "judicabot/judicabot",
      tag: "latest",
      ref: "zot.web.example.test/judicabot/judicabot:latest",
      full: "zot.web.example.test/judicabot/judicabot",
    });
    expect(parseImageRef("traefik:v3.6.13")).toBeNull();
    expect(parseImageRef("postgres:16-alpine")).toBeNull();
    expect(parseImageRef("zot.web.example.test/Bad Repo:latest")).toBeNull();
  });

  const svc = (o: Record<string, unknown>) => ({
    id: "x", name: "X", role: "x", tags: [], playbook: "playbook.yml", host: "vps", dir: "/opt/x", containers: ["x"], images: [],
    hostname: null, jenkins_job: null, db: [], core: false, auth: { kind: "none", vault_vars: [], env_keys: [] }, ...o,
  });
  const manifest = parseManifest({
    services: [
      svc({ id: "one", images: ["zot.web.example.test/a/one:latest"], containers: ["one"] }),
      svc({ id: "two", images: ["zot.web.example.test/a/api:latest", "zot.web.example.test/a/web:latest"], containers: ["api", "web"] }),
      svc({ id: "mixed", images: ["zot.web.example.test/a/mixed:latest", "pgvector/pgvector:pg16"], containers: ["mixed", "db"] }),
      svc({ id: "none", images: ["nginx:alpine"], containers: ["none"] }),
      svc({ id: "core", images: ["zot.web.example.test/a/core:latest"], containers: ["core"], core: true }),
      svc({ id: "far", images: ["zot.web.example.test/a/far:latest"], containers: ["far"], host: "jenkins" }),
    ],
  });
  const by = (id: string) => manifest.services.find((s) => s.id === id)!;
  const host = "zot.web.example.test";

  test("exactly one registry image on the vps host and not core", () => {
    expect(rollbackTarget(by("one"), host)).toMatchObject({ ok: true, image: { repo: "a/one", tag: "latest" } });
    expect(rollbackTarget(by("mixed"), host)).toMatchObject({ ok: true, image: { repo: "a/mixed" } });
  });

  test("refuses multiple registry images, none, core, the jenkins host and an unknown registry", () => {
    expect(rollbackTarget(by("two"), host)).toMatchObject({ ok: false, reason: expect.stringContaining("2 images") });
    expect(rollbackTarget(by("none"), host)).toMatchObject({ ok: false, reason: expect.stringContaining("nothing to roll back") });
    expect(rollbackTarget(by("core"), host)).toMatchObject({ ok: false, reason: expect.stringContaining("Ansible") });
    expect(rollbackTarget(by("far"), host)).toMatchObject({ ok: false, reason: expect.stringContaining("jenkins host") });
    expect(rollbackTarget(by("one"), null)).toMatchObject({ ok: false });
  });

  test("lists the repositories worth querying", () => {
    expect(rollbackRepos(manifest, host)).toEqual(["a/mixed", "a/one"]);
  });
});
