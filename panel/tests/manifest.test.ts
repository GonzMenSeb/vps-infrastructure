import { describe, expect, test } from "bun:test";
import { indexManifest, loadManifest, parseManifest } from "../src/manifest";

const fixture = "tests/fixtures/services.json";
const raw = () => JSON.parse(JSON.stringify(require("./fixtures/services.json")));

describe("manifest", () => {
  test("loads the fixture from disk", async () => {
    const m = await loadManifest(fixture);
    expect(m.services.map((s) => s.id)).toEqual(["traefik", "miplata", "llm_inference", "jenkins"]);
    expect(m.services[2]!.hostname).toBeNull();
  });

  test("index maps host/container to service and id to service", async () => {
    const idx = indexManifest(await loadManifest(fixture));
    expect(idx.byContainer.get("vps/miplata-redis")?.id).toBe("miplata");
    expect(idx.byContainer.get("jenkins/jenkins")?.id).toBe("jenkins");
    expect(idx.byContainer.get("vps/jenkins")).toBeUndefined();
    expect(idx.byId.get("traefik")?.core).toBe(true);
  });

  test("rejects duplicate ids", () => {
    const r = raw();
    r.services[1].id = "traefik";
    expect(() => parseManifest(r)).toThrow(/duplicate id: traefik/);
  });

  test("rejects the same container on the same host in two services", () => {
    const r = raw();
    r.services[1].containers.push("traefik");
    expect(() => parseManifest(r)).toThrow(/duplicate container: vps\/traefik/);
  });

  test("rejects db entries pointing outside the service", () => {
    const r = raw();
    r.services[1].db[0].container = "nope";
    expect(() => parseManifest(r)).toThrow(/db container not in service/);
  });

  test("rejects unknown host, auth kind, and relative dir", () => {
    for (const mutate of [
      (r: any) => (r.services[0].host = "other"),
      (r: any) => (r.services[0].auth.kind = "magic"),
      (r: any) => (r.services[0].dir = "opt/traefik"),
    ]) {
      const r = raw();
      mutate(r);
      expect(() => parseManifest(r)).toThrow(/invalid services manifest/);
    }
  });

  test("env auth without env_keys is rejected", () => {
    const r = raw();
    r.services[1].auth.env_keys = [];
    expect(() => parseManifest(r)).toThrow(/env auth needs env_keys/);
  });

  test("missing and non-JSON files give clear errors", async () => {
    await expect(loadManifest("tests/fixtures/nope.json")).rejects.toThrow(/cannot read services manifest/);
    await Bun.write("/tmp/vespiridion-bad-manifest.json", "{");
    await expect(loadManifest("/tmp/vespiridion-bad-manifest.json")).rejects.toThrow(/not valid JSON/);
  });
});
