import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { TURBO_PROGRESS_STYLE_HASH } from "../src/server";

function unindent(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((r, s, i) => r + s + (values[i] == undefined ? "" : values[i]), "");
  const lines = text.replace(/^\n/, "").split("\n");
  const indent = lines[0]!.match(/^\s+/)?.[0].length ?? 0;
  return lines.map((l) => l.slice(indent)).join("\n");
}

describe("csp", () => {
  test("the allowed style hash matches the vendored Turbo progress bar", async () => {
    const src = await Bun.file("public/turbo.js").text();
    const duration = Number(/static animationDuration = (\d+)/.exec(src)![1]);
    const body = /static get defaultCSS\(\) \{\s*return unindent`([\s\S]*?)`\s*\}/.exec(src)![1]!;
    const css = new Function("unindent", "ProgressBar", `return unindent\`${body}\``)(unindent, { animationDuration: duration }) as string;
    expect(`'sha256-${createHash("sha256").update(css).digest("base64")}'`).toBe(TURBO_PROGRESS_STYLE_HASH);
  });
});
