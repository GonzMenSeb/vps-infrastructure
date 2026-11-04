import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./cdp";

const base = process.argv[2] ?? "http://localhost:3000";
const out = resolve(process.argv[3] ?? "tests/screens");
const WIDTHS = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);

mkdirSync(out, { recursive: true });
const browser = await launch();
try {
  const page = await browser.page();
  await page.goto(`${base}/auth/dev?next=/`, 1440);
  const shoot = async (name: string, w: number) => {
    const overflow = await page.eval<number>("document.documentElement.scrollWidth - window.innerWidth");
    const file = join(out, `${name}-${w}.png`);
    await page.screenshot(file, w);
    console.log(`${file}${overflow > 0 ? ` horizontal-overflow=${overflow}px` : ""}`);
  };
  const confirm = async () => {
    await page.eval(`document.querySelector('dialog.confirm button[value=ok]').click()`);
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(300);
      if (await page.eval<boolean>(`!!document.querySelector('.alert[role=status]')`)) return;
    }
  };

  for (const w of WIDTHS) {
    await page.goto(`${base}/services/judicabot`, w);
    await shoot("actions-judicabot", w);
    await page.eval(`document.querySelector('form[action$="/rollback"] button').click()`);
    await Bun.sleep(400);
    await shoot("actions-rollback-dialog", w);
    await confirm();
    await shoot("actions-rolled-back", w);

    await page.goto(`${base}/services/vaultwarden`, w);
    await page.eval(`document.querySelector('form[action$="/switch"] button').click()`);
    await Bun.sleep(400);
    await shoot("actions-switch-off-dialog", w);
    await confirm();
    await shoot("actions-switched-off", w);
    await page.eval(`document.querySelector('form[action$="/switch"] button').click()`);
    await Bun.sleep(400);
    await confirm();
    await Bun.sleep(1000);

    for (const id of ["traefik", "miplata", "jenkins", "huella"]) {
      await page.goto(`${base}/services/${id}`, w);
      await shoot(`actions-${id}`, w);
    }
  }
} finally {
  await browser.close();
}
