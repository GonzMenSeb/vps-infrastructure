export {};

const base = process.argv[2] ?? "http://localhost:3000";
const N = Number(process.argv[3] ?? 200);
const PAGES = ["/", "/hosts/vps", "/hosts/jenkins", "/services", "/services/judicabot", "/services/monitoring?tab=config"];

const login = await fetch(`${base}/auth/dev?next=/`, { redirect: "manual" });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
if (!cookie.startsWith("vp_session=")) throw new Error(`dev sign-in failed: HTTP ${login.status}`);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

async function run(path: string, headers: Record<string, string>) {
  const times: number[] = [];
  const codes = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const res = await fetch(base + path, { headers: { cookie, ...headers } });
    await res.arrayBuffer();
    times.push(performance.now() - t);
    codes.set(res.status, (codes.get(res.status) ?? 0) + 1);
  }
  return { p50: pct(times, 50), p95: pct(times, 95), codes: [...codes].map(([c, n]) => `${c}x${n}`).join(" ") };
}

const f = (v: number) => v.toFixed(2).padStart(6);
console.log(`${N} sequential requests per row, times in ms`);
console.log("page".padEnd(34), "variant".padEnd(10), "p50".padStart(6), "p95".padStart(6), " status");
for (const path of PAGES) {
  for (let i = 0; i < 10; i++) await (await fetch(base + path, { headers: { cookie } })).arrayBuffer();
  const page = await fetch(base + path, { headers: { cookie } });
  await page.arrayBuffer();
  const frame = await fetch(base + path, { headers: { cookie, "turbo-frame": "live" } });
  await frame.arrayBuffer();
  const rows: [string, Record<string, string>][] = [
    ["page", {}],
    ["frame", { "turbo-frame": "live" }],
    ["page 304", { "if-none-match": page.headers.get("etag")! }],
    ["frame 304", { "turbo-frame": "live", "if-none-match": frame.headers.get("etag")! }],
  ];
  for (const [name, headers] of rows) {
    const r = await run(path, headers);
    console.log(path.padEnd(34), name.padEnd(10), f(r.p50), f(r.p95), ` ${r.codes}`);
  }
}
