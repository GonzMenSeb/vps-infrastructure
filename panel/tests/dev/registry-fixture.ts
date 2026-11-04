export const REGISTRY_HOST = "zot.web.example.test";
export const REGISTRY_USER = "ci";
export const REGISTRY_PASSWORD = "fixture-registry-password";

export interface RegistryRow {
  tag: string;
  digest: string;
  lastUpdated: string | null;
  size: number;
}

export const digestOf = (repo: string, build: string): string => {
  let hex = "";
  for (let i = 0; hex.length < 64; i++) hex += Bun.hash(`${repo}@${build}#${i}`).toString(16).padStart(16, "0");
  return `sha256:${hex.slice(0, 64)}`;
};

const HOUR = 3_600_000;

const iso = (ms: number): string => {
  const d = new Date(ms).toISOString();
  return d.replace(/\.(\d{3})Z$/, (_, f: string) => `.${f}${String(ms % 977).padStart(6, "0")}Z`);
};

export interface BuildSpec {
  tags: string[];
  build: string;
  hoursAgo: number;
}

export const REGISTRY_BUILDS: Record<string, BuildSpec[]> = {
  "judicabot/judicabot": [
    { tags: ["c19ab44", "latest"], build: "c19ab44", hoursAgo: 1.4 },
    { tags: ["3ee016f"], build: "3ee016f", hoursAgo: 5.2 },
    { tags: ["32f1bd4"], build: "32f1bd4", hoursAgo: 6 },
    { tags: ["6597a89"], build: "6597a89", hoursAgo: 6.1 },
  ],
  "coros/huella": [{ tags: ["a1b2c3d", "latest"], build: "a1b2c3d", hoursAgo: 30 }],
  "losprompteros/decabot": [
    { tags: ["9f8e7d6", "latest"], build: "9f8e7d6", hoursAgo: 3 },
    { tags: ["5c4b3a2"], build: "5c4b3a2", hoursAgo: 52 },
  ],
};

export function registryRows(now = Date.now()): Record<string, RegistryRow[]> {
  const out: Record<string, RegistryRow[]> = {};
  for (const [repo, builds] of Object.entries(REGISTRY_BUILDS)) {
    const rows: RegistryRow[] = [];
    for (const b of builds) {
      for (const tag of b.tags) rows.push({ tag, digest: digestOf(repo, b.build), lastUpdated: iso(now - b.hoursAgo * HOUR), size: 150_000_000 });
    }
    rows.push({ tag: "buildcache", digest: digestOf(repo, "buildcache"), lastUpdated: null, size: 150_000_000 });
    out[repo] = rows;
  }
  return out;
}
