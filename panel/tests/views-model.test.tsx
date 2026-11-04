import { describe, expect, test } from "bun:test";
import { PROM_SOURCES } from "../src/collectors/prometheus";
import { Store } from "../src/store";
import {
  STALE_TTL_FACTOR,
  buildHosts,
  buildOverview,
  buildService,
  buildServices,
  commonSuffix,
  fmtBytes,
  imageTag,
  readSources,
  shortHostname,
  shortImage,
  sourceStatus,
} from "../src/views/model";
import { isSecretLabel } from "../src/views/model";
import { SECRET_HASH, SECRET_TOKEN, downSources, emptySources, fullSources, input, snap } from "./views-fixtures";

const states = () => Object.fromEntries(buildServices(input()).rows.map((r) => [r.id, r.state]));

describe("formatting helpers", () => {
  test("bytes, images and hostnames", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1500)).toBe("1.5 kB");
    expect(fmtBytes(612e6)).toBe("612 MB");
    expect(shortImage("zot.web.example.test/judicabot/judicabot:latest")).toBe("judicabot/judicabot:latest");
    expect(shortImage("grafana/grafana:12.4.3")).toBe("grafana/grafana:12.4.3");
    expect(shortImage("localhost/x:1")).toBe("x:1");
    expect(imageTag("traefik:v3.6.13")).toBe("v3.6.13");
    expect(imageTag("registry.example.test:5000/a/b")).toBeNull();
    expect(imageTag("a/b:1@sha256:abc")).toBe("1");
    const sfx = commonSuffix(["a.web.example.test", "b.web.example.test"]);
    expect(sfx).toBe("web.example.test");
    expect(shortHostname("a.web.example.test", sfx)).toBe("a.web");
    expect(commonSuffix(["only.example.test"])).toBeNull();
    expect(commonSuffix(["web.example.test", "a.web.example.test"])).toBe("example.test");
  });
});

describe("source status", () => {
  test("distinguishes off, loading, error, stale and fresh", () => {
    expect(sourceStatus("hosts", null).state).toBe("off");
    expect(sourceStatus("hosts", snap(undefined)).state).toBe("loading");
    expect(sourceStatus("hosts", snap(undefined, { lastError: "boom" })).state).toBe("error");
    expect(sourceStatus("hosts", snap([], { lastError: "boom" })).state).toBe("stale");
    expect(sourceStatus("hosts", snap([], { ageMs: 16_000, stale: true })).state).toBe("fresh");
    expect(sourceStatus("hosts", snap([], { ageMs: STALE_TTL_FACTOR * 15_000 + 1 })).state).toBe("stale");
  });

  test("readSources tolerates unregistered sources", async () => {
    const store = new Store();
    store.register(PROM_SOURCES.hosts, async () => [], { ttlMs: 1000, timeoutMs: 100, failureThreshold: 1, cooldownMs: 1 });
    await store.refresh(PROM_SOURCES.hosts);
    const s = readSources(store);
    expect(s.hosts?.data).toEqual([]);
    expect(s.docker).toBeNull();
    expect(s.df).toBeNull();
  });
});

describe("service state", () => {
  test("derives state from Docker on vps and from metrics on jenkins", () => {
    expect(states()).toEqual({
      traefik: "running",
      miplata: "absent",
      judicabot: "running",
      monitoring: "degraded",
      llm_inference: "failing",
      huella: "stopped",
      jenkins: "reporting",
    });
  });

  test("unknown without Docker data", () => {
    const rows = buildServices(input(emptySources())).rows;
    expect(rows.every((r) => r.state === "unknown")).toBe(true);
  });

  test("protection comes from Traefik labels across containers", () => {
    const by = Object.fromEntries(buildServices(input()).rows.map((r) => [r.id, r.protection.label]));
    expect(by.traefik).toBe("Traefik basic-auth");
    expect(by.judicabot).toBe("No Traefik gate");
    expect(by.llm_inference).toBe("No public route");
    expect(by.miplata).toBe("Unknown");
    expect(by.monitoring).toBe("Traefik plugin apitokenmiddleware");
    expect(buildService(input(), "monitoring")!.routers[0]!.middlewares).toEqual([{ ref: "obs-bearer", kind: "plugin apitokenmiddleware" }]);
    expect(by.jenkins).toBe("Not visible");
    expect(by.huella).toBe("No router found");
  });
});

describe("service detail", () => {
  test("routers, ports and redacted labels", () => {
    const vm = buildService(input(), "traefik", "config")!;
    expect(vm.tab).toBe("config");
    expect(vm.routers).toHaveLength(1);
    expect(vm.routers[0]).toMatchObject({ name: "dashboard", certresolver: "letsencrypt", port: null });
    expect(vm.routers[0]!.middlewares).toEqual([{ ref: "dashboard-auth", kind: "basicauth" }]);
    const secret = vm.labels.find((l) => l.key.endsWith("basicauth.users"))!;
    expect(secret).toEqual({ key: "traefik.http.middlewares.dashboard-auth.basicauth.users", value: "", hidden: true });
    expect(JSON.stringify(vm)).not.toContain(SECRET_HASH);
    expect(buildService(input(), "judicabot")!.routers[0]!.port).toBe("8000");
    const mon = buildService(input(), "monitoring", "config")!;
    expect(mon.labels.find((l) => l.key.endsWith("tokens[0]"))).toMatchObject({ value: "", hidden: true });
    expect(JSON.stringify(mon)).not.toContain(SECRET_TOKEN);
  });

  test("unknown ids, unknown tabs and the db tab", () => {
    expect(buildService(input(), "nope")).toBeNull();
    expect(buildService(input(), "judicabot", "db")!.tab).toBe("summary");
    expect(buildService(input(), "miplata", "db")!.tab).toBe("db");
    expect(buildService(input(), "judicabot")!.tabs.map((t) => t.id)).toEqual(["summary", "config", "auth", "builds"]);
  });

  test("disk splits shared volumes between their containers", () => {
    const vm = buildService(input(), "monitoring")!;
    const by = Object.fromEntries(vm.containers.map((c) => [c.name, c.diskBytes]));
    expect(by.prometheus).toBe(1e6 + 5e9);
    expect(by.grafana).toBe(3e6 + 1e6);
  });
});

describe("label redaction", () => {
  test("hides any label whose last segment names a credential", () => {
    for (const k of [
      "traefik.http.middlewares.a.basicauth.users",
      "traefik.http.middlewares.a.basicauth.usersfile",
      "traefik.http.middlewares.a.plugin.apitokenmiddleware.tokens[0]",
      "traefik.http.middlewares.a.headers.customrequestheaders.X-Api-Key",
      "traefik.http.middlewares.a.plugin.x.password",
      "traefik.http.middlewares.a.plugin.x.clientSecret",
    ])
      expect(isSecretLabel(k)).toBe(true);
    for (const k of ["traefik.http.routers.a.rule", "traefik.http.routers.a.middlewares", "traefik.enable", "traefik.http.services.a.loadbalancer.server.port"])
      expect(isSecretLabel(k)).toBe(false);
  });
});

describe("treemap", () => {
  test("memory adds system and free tiles that fill the host", () => {
    const t = buildHosts(input(), { host: "vps", metric: "mem" }).treemap;
    const names = t.tiles.map((x) => x.name);
    expect(names).toContain("System & other");
    expect(names).toContain("Free");
    expect(t.headValue).toBe("3 GB");
    expect(t.headLabel).toBe("of 8 GB used");
    const area = t.tiles.reduce((a, x) => a + x.w * x.h, 0);
    expect(area).toBeCloseTo(100 * 100, -1);
    expect(t.tiles.find((x) => x.name === "judicabot")!.href).toBe("/services/judicabot");
    expect(t.tiles.find((x) => x.name === "stray")!.href).toBeNull();
    expect(t.tiles.find((x) => x.name === "Free")!.free).toBe(true);
  });

  test("cpu is a share of the host when cores are known, network and unknown cores are combined, disk is vps only", () => {
    const cpu = buildHosts(input(), { host: "vps", metric: "cpu" }).treemap;
    expect(cpu.headLabel).toBe("of 4 cores busy");
    expect(cpu.headValue).toBe("23%");
    expect(cpu.tiles.find((x) => x.name === "prometheus")!.valueText).toBe("1%");
    expect(cpu.tiles.some((x) => x.free)).toBe(true);
    const jcpu = buildHosts(input(), { host: "jenkins", metric: "cpu" }).treemap;
    expect(jcpu.headLabel).toContain("combined");
    expect(jcpu.tiles.some((x) => x.free)).toBe(false);
    expect(buildHosts(input(), { host: "vps", metric: "net" }).treemap.headLabel).toBe("combined");
    expect(buildHosts(input(), { host: "jenkins", metric: "disk" }).treemap.empty).toContain("only reach on vps");
    const disk = buildHosts(input(), { host: "vps", metric: "disk" }).treemap;
    expect(disk.tiles.find((x) => x.color === "tc-0")!.name).toBe("prometheus");
    expect(disk.headLabel).toBe("of 100 GB used");
  });

  test("overview is compact and tiers stay low", () => {
    const t = buildOverview(input()).treemap;
    expect(t.compact).toBe(true);
    expect(Math.max(...t.tiles.map((x) => x.tier))).toBeLessThanOrEqual(2);
  });

  test("bad query values fall back", () => {
    const vm = buildHosts(input(), { host: "elsewhere", metric: "bogus" });
    expect(vm.host).toBe("vps");
    expect(vm.metric).toBe("mem");
  });
});

describe("overview", () => {
  test("request path, traefik version and attention", () => {
    const vm = buildOverview(input());
    expect(vm.traefik).toEqual({ label: "Traefik v3.6.13", tls: "TLS via letsencrypt" });
    expect(vm.path.map((p) => p.short)).toEqual(["traefik.web", "miplata.web", "judicabot.web", "grafana.web", "huella.web"]);
    const titles = vm.attention.map((a) => `${a.tag}: ${a.title}`);
    expect(titles).toEqual([
      "Partial: Monitoring is degraded",
      "Down: LLM inference is failing",
      "Space: vps disk is 80% full",
      "Missing: Miplata has no container",
      "Off: Huella is switched off",
    ]);
    expect(vm.up).toEqual({ running: 3, total: 7, building: 0 });
  });

  test("source failures become attention items", () => {
    const vm = buildOverview(input(downSources()));
    expect(vm.attention[0]).toMatchObject({ tone: "bad", title: "Prometheus is not answering" });
    expect(vm.attention[1]).toMatchObject({ tone: "warn", title: "Docker data is stale" });
    expect(vm.hosts[0]!.metrics).toBeNull();
  });

  test("full sources fixture is self-consistent", () => {
    expect(fullSources().docker?.data?.length).toBeGreaterThan(0);
  });
});
