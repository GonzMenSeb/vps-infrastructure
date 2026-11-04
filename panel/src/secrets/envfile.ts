import { join, normalize } from "node:path";
import type { Service } from "../manifest";

export const MAX_ENV_BYTES = 1024 * 1024;

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

function unquote(raw: string): string {
  const v = raw.trimStart();
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const ch = v[i]!;
      if (ch === "\\" && i + 1 < v.length) {
        const n = v[++i]!;
        out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
      } else if (ch === '"') {
        return out;
      } else {
        out += ch;
      }
    }
    return out;
  }
  const comment = v.search(/\s#/);
  return (comment === -1 ? v : v.slice(0, comment)).trim();
}

export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const l = line.replace(/\r$/, "").trimStart();
    if (!l || l.startsWith("#")) continue;
    const m = LINE.exec(l);
    if (m) out.set(m[1]!, unquote(m[2]!));
  }
  return out;
}

export function envPath(service: Pick<Service, "dir">, root?: string): string | null {
  const trimmed = service.dir.replace(/\/+$/, "");
  const dir = normalize(trimmed);
  if (dir !== trimmed || dir.split("/").includes("..")) return null;
  return join(root ?? "/", dir, ".env");
}

export type EnvRead = { ok: true; values: Map<string, string | null> } | { ok: false; reason: "unreadable" | "too-large" | "bad-path" };

export async function readEnvKeys(path: string | null, keys: readonly string[]): Promise<EnvRead> {
  if (!path) return { ok: false, reason: "bad-path" };
  const file = Bun.file(path);
  let text: string;
  try {
    if (file.size > MAX_ENV_BYTES) return { ok: false, reason: "too-large" };
    text = await file.text();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const all = parseEnv(text);
  const values = new Map<string, string | null>();
  for (const k of keys) values.set(k, all.get(k) ?? null);
  return { ok: true, values };
}
