import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./cdp";

const base = process.argv[2] ?? "http://localhost:3000";
const out = resolve(process.argv[3] ?? "tests/screens");
const mockup = process.argv[4];
const WIDTHS = [1440, 390];

interface Shot {
  name: string;
  url: string;
  before?: string;
  wait?: number;
}

const PANEL: Shot[] = [
  { name: "overview", url: `${base}/` },
  { name: "hosts-vps", url: `${base}/hosts/vps` },
  { name: "hosts-jenkins", url: `${base}/hosts/jenkins` },
  { name: "services", url: `${base}/services` },
  { name: "service-judicabot", url: `${base}/services/judicabot` },
  { name: "service-builds", url: `${base}/services/judicabot?tab=builds` },
  { name: "jobs", url: `${base}/jobs` },
  { name: "jobs-console", url: `${base}/jobs?job=vps-deploy&build=39`, wait: 2500 },
  { name: "logs", url: `${base}/logs`, wait: 3000 },
  { name: "logs-traefik", url: `${base}/logs?host=vps&container=traefik`, wait: 3000 },
  { name: "registry", url: `${base}/registry` },
  { name: "registry-judicabot", url: `${base}/registry?repo=judicabot%2Fjudicabot` },
  { name: "databases", url: `${base}/databases` },
  { name: "service-db", url: `${base}/services/miplata?tab=db` },
  { name: "dns", url: `${base}/dns` },
  { name: "dns-edit", url: `${base}/dns?edit=A:scratch.web.example.test.` },
  { name: "dns-review", url: `${base}/dns?review=1&op=upsert&name=fresh&type=A&ttl=300&content=192.0.2.50` },
  { name: "dns-review-overwrite", url: `${base}/dns?review=1&op=upsert&name=miplata&type=A&ttl=300&content=192.0.2.99` },
];

const MOCKUP: Shot[] = mockup
  ? [
      { name: "mockup-overview", url: `file://${mockup}#overview` },
      { name: "mockup-hosts-vps", url: `file://${mockup}#hosts` },
      { name: "mockup-hosts-jenkins", url: `file://${mockup}#hosts`, before: `document.querySelector('[data-act="host:jenkins"]').click()` },
      { name: "mockup-services", url: `file://${mockup}#services` },
      { name: "mockup-service-judicabot", url: `file://${mockup}#service/judicabot` },
      { name: "mockup-jobs", url: `file://${mockup}#jobs`, wait: 800 },
      { name: "mockup-logs", url: `file://${mockup}#logs`, wait: 1500 },
      { name: "mockup-registry", url: `file://${mockup}#registry` },
      { name: "mockup-databases", url: `file://${mockup}#databases` },
      { name: "mockup-dns", url: `file://${mockup}#dns` },
      { name: "mockup-service-db", url: `file://${mockup}#service/miplata`, before: `document.querySelector('[data-act="tab:db"]').click()` },
    ]
  : [];

mkdirSync(out, { recursive: true });
const browser = await launch();
try {
  const page = await browser.page();
  await page.goto(`${base}/auth/dev?next=/`, 1440);
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
  for (const shot of [...PANEL, ...MOCKUP].filter((x) => !only || only.test(x.name))) {
    for (const w of WIDTHS) {
      page.logs.length = 0;
      await page.goto(shot.url, w);
      if (shot.before) {
        await page.eval(shot.before);
        await Bun.sleep(300);
      }
      if (shot.wait) await Bun.sleep(shot.wait);
      const overflow = await page.eval<number>("document.documentElement.scrollWidth - window.innerWidth");
      const file = join(out, `${shot.name}-${w}.png`);
      await page.screenshot(file, w);
      console.log(`${file}${overflow > 0 ? ` horizontal-overflow=${overflow}px` : ""}`);
      for (const l of new Set(page.logs)) console.log(`  ${l}`);
    }
  }
} finally {
  await browser.close();
}
