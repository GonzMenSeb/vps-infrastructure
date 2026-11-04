import { z } from "zod";
import type { Credential } from "./credentials";

export const MAX_VALUE_LENGTH = 512;
export const MAX_HASH_PASSWORD_BYTES = 72;
export const GENERATED_LENGTH = 24;

export const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SAFE_VALUE_SOURCE = "^[A-Za-z0-9._~+=:@%^*!?,/-]+$";
export const SAFE_VALUE_RULE = "letters, digits and . _ ~ + = : @ % ^ * ! ? , / -";
const SAFE_VALUE = new RegExp(SAFE_VALUE_SOURCE);
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const JINJA = /\{[{%#]/;

function unsafeMessage(value: string): string {
  const bad = [...value].find((c) => !SAFE_VALUE.test(c));
  const named = bad === undefined ? "" : bad === " " ? "A space is not allowed. " : `"${bad}" is not allowed. `;
  return `${named}The value may only contain ${SAFE_VALUE_RULE}. Other characters are rewritten or cut off when the service reads its configuration.`;
}

export function valueSchema(c: Pick<Credential, "source" | "minLength">) {
  const hashed = c.source === "hash";
  const max = hashed ? MAX_HASH_PASSWORD_BYTES : MAX_VALUE_LENGTH;
  const base = z
    .string()
    .min(c.minLength, `Use at least ${c.minLength} character${c.minLength === 1 ? "" : "s"}.`)
    .max(max, `Use at most ${max} characters.`)
    .regex(PRINTABLE_ASCII, "Use printable ASCII on a single line.")
    .refine((v) => v === v.trim(), "The value must not start or end with a space.")
    .refine((v) => !JINJA.test(v), "The value must not contain {{, {% or {#, which Ansible would treat as a template.");
  return hashed ? base : base.refine((v) => SAFE_VALUE.test(v), { error: (iss) => unsafeMessage(String(iss.input)) });
}

export type Validated = { ok: true; value: string } | { ok: false; error: string };

export function validateValue(c: Pick<Credential, "source" | "minLength">, raw: unknown): Validated {
  const r = valueSchema(c).safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid value." };
}

function pick(n: number): number {
  const limit = 256 - (256 % n);
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    if (byte[0]! < limit) return byte[0]! % n;
  }
}

export function generatePassword(length = GENERATED_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[pick(ALPHABET.length)];
  return out;
}

export async function htpasswdLine(user: string, password: string, cost = 10): Promise<string> {
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost });
  return `${user}:${hash.replace(/^\$2[ab]\$/, () => "$2y$")}`;
}
