import { cp, mkdir } from "node:fs/promises";

const nm = "node_modules";
const files: [string, string][] = [
  [`${nm}/@hotwired/stimulus/dist/stimulus.umd.js`, "public/stimulus.js"],
  [`${nm}/@hotwired/turbo/dist/turbo.es2017-umd.js`, "public/turbo.js"],
  ...["400", "500"].map((w): [string, string] => [
    `${nm}/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`,
    `public/fonts/jetbrains-mono-${w}.woff2`,
  ]),
  ...["400", "500", "600", "700"].map((w): [string, string] => [
    `${nm}/@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-${w}-normal.woff2`,
    `public/fonts/schibsted-grotesk-${w}.woff2`,
  ]),
];

await mkdir("public/fonts", { recursive: true });
for (const [from, to] of files) await cp(from, to);
