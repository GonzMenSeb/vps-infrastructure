import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "../../src/secrets/envfile";
import type { Manifest } from "../../src/manifest";

export const fakeSecret = (service: string, key: string) => `fake-${service}-${key.toLowerCase().replace(/_/g, "-")}-example`;

export interface FakeOpt {
  root: string;
  path: (service: string) => string;
  read: (service: string, key: string) => string | undefined;
  set: (service: string, key: string, value: string) => void;
  applyVar: (variable: string, value: string) => void;
  stop: () => void;
}

export function makeFakeOpt(manifest: Manifest): FakeOpt {
  const root = mkdtempSync(join(tmpdir(), "vesp-opt-"));
  const dirOf = (id: string) => manifest.services.find((s) => s.id === id)!.dir;
  const path = (id: string) => join(root, dirOf(id), ".env");
  for (const s of manifest.services) {
    if (s.host !== "vps" || s.auth.kind !== "env") continue;
    mkdirSync(join(root, s.dir), { recursive: true });
    const lines = [
      "# Rendered by Ansible (fixture)",
      `DOMAIN=https://${s.id}.example.test`,
      "PORT=3000",
      ...s.auth.env_keys.map((k, i) => (i === 1 ? `${k}="${fakeSecret(s.id, k)}"` : i === 2 ? `${k}=${fakeSecret(s.id, k)} # inline comment` : `${k}=${fakeSecret(s.id, k)}`)),
      "",
    ];
    writeFileSync(path(s.id), lines.join("\n"));
    chmodSync(path(s.id), 0o640);
  }
  const read = (id: string, key: string) => parseEnv(readFileSync(path(id), "utf8")).get(key);
  const set = (id: string, key: string, value: string) => {
    const text = readFileSync(path(id), "utf8");
    const next = text.split("\n").map((l) => (l.replace(/^export\s+/, "").startsWith(`${key}=`) ? `${key}=${value}` : l));
    writeFileSync(path(id), next.join("\n"));
  };
  return {
    root,
    path,
    read,
    set,
    applyVar(variable, value) {
      for (const s of manifest.services) {
        if (s.host !== "vps") continue;
        for (const [key, v] of Object.entries(s.auth.env_vars)) if (v === variable) set(s.id, key, value);
      }
    },
    stop: () => rmSync(root, { recursive: true, force: true }),
  };
}
