import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./cdp";

const base = process.argv[2] ?? "http://localhost:3000";
const out = resolve(process.argv[3] ?? "tests/screens");
const AUTH = `${base}/services/decabot?tab=auth`;

mkdirSync(out, { recursive: true });
const browser = await launch(process.env.CHROME);
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};

try {
  const page = await browser.page();
  const shot = async (name: string, w: number) => page.screenshot(join(out, `${name}-${w}.png`), w);
  const text = () => page.eval<string>("document.body.innerText");
  const wait = async (cond: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page.eval<boolean>(`Boolean(${cond})`)) return true;
      await Bun.sleep(250);
    }
    return false;
  };
  const confirmOk = async () => {
    check(await wait(`document.querySelector("dialog#confirm-dialog[open]")`), "confirmation dialog opens");
    const dialog = await page.eval<string>(`document.querySelector("dialog#confirm-dialog").innerText`);
    check(dialog.includes("POST /job/panel-secrets/buildWithParameters") && dialog.includes("VAR_VALUE=(hidden)") && dialog.includes("vps-deploy"), "dialog states the exact request and the vps-deploy follow-up");
    await page.eval(`document.querySelector('dialog#confirm-dialog button[value="ok"]').click()`);
  };

  for (const w of [1440, 390]) {
    await page.goto(`${base}/auth/dev?next=/services/decabot?tab=auth`, w);
    check((await page.eval<number>("document.documentElement.scrollWidth - window.innerWidth")) <= 0, `no horizontal overflow at ${w}px`);
    await shot("auth-decabot", w);
  }
  await page.goto(`${base}/auth/dev?next=/services/decabot?tab=auth`, 1440);

  // Reveal
  await page.eval(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] [data-action="secret#show"]').click()`);
  check(await wait(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] code:not([hidden])')`), "Show reveals the value");
  const revealed = await page.eval<string>(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] code').textContent`);
  check(revealed === "fake-decabot-decabot-password-example", "the revealed value is the one in the fake .env");
  check(await page.eval<boolean>(`document.querySelector('[data-refresh-hold]') !== null`), "auto-refresh is held while a value is shown");
  await shot("auth-decabot-revealed", 1440);
  await page.eval(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] [data-action="secret#hide"]').click()`);
  check(await page.eval<boolean>(`!document.getElementById("live").outerHTML.includes("fake-decabot-decabot-password-example")`), "Hide removes the value from the DOM");
  await page.eval(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] [data-action="secret#show"]').click()`);
  await wait(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] code:not([hidden])')`);
  const hidden = await wait(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] code[hidden]')`, (Number(process.env.REVEAL_SECONDS ?? 20) + 4) * 1000);
  check(hidden, `the value hides itself after ${process.env.REVEAL_SECONDS ?? 20} s`);

  // A refresh morphs the frame; the forms must still submit afterwards.
  await page.eval(`document.getElementById("live").reload()`);
  await Bun.sleep(1500);
  const csrfAfterReload = await page.eval<string>(`document.querySelector('form[action$="DECABOT_PASSWORD"] input[name=_csrf]').value`);
  console.log(`info the hidden csrf field after a refresh is ${csrfAfterReload ? "kept" : "blank, so it is refilled on submit"}`);

  // Edit with confirmation
  await page.eval(`document.querySelector('details[data-k="edit:DECABOT_PASSWORD"] summary').click()`);
  await page.eval(`document.querySelector('details[data-k="edit:DECABOT_PASSWORD"] [data-action="secret-gen#fill"]').click()`);
  const generated = await page.eval<string>(`document.querySelector("#v-DECABOT_PASSWORD").value`);
  check(/^[A-Za-z0-9]{24}$/.test(generated), "Generate fills a 24-character value");
  await shot("auth-decabot-editing", 1440);
  await page.eval(`document.querySelector('details[data-k="edit:DECABOT_PASSWORD"] button[type="submit"]').click()`);
  await confirmOk();
  check(await wait(`document.body.innerText.includes("Pending")`), "the credential shows as pending after saving");
  check(!(await text()).includes(generated), "the new value is not shown on the page after saving");
  await shot("auth-decabot-pending", 1440);
  await shot("auth-decabot-pending", 390);

  const applied = await wait(`document.body.innerText.includes("Applied by vps-deploy")`, 60_000);
  check(applied, "the change reaches 'Applied by vps-deploy' without a manual reload");
  await shot("auth-decabot-applied", 1440);
  await shot("auth-decabot-applied", 390);

  // The fake vps-deploy rewrote the .env, so revealing shows the new value.
  await page.eval(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] [data-action="secret#show"]').click()`);
  await wait(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] code:not([hidden])')`);
  check((await page.eval<string>(`document.querySelector('[data-secret-url-value$="DECABOT_PASSWORD/reveal"] code').textContent`)) === generated, "after apply, the .env holds the value that was saved");

  // Rotate shows the value once
  await page.goto(`${base}/services/judicabot?tab=auth`, 1440);
  await page.eval(`document.querySelector('form[action$="JUDICABOT_PASSWORD/rotate"] button').click()`);
  await confirmOk();
  check(await wait(`document.querySelector("[data-once-target=value]")`), "rotate lands on the show-once page");
  const once = await page.eval<string>(`document.querySelector("[data-once-target=value]").textContent`);
  check(/^[A-Za-z0-9]{24}$/.test(once), "the rotated value is 24 random characters");
  await shot("auth-rotate-once", 1440);
  await shot("auth-rotate-once", 390);

  // Traefik: edit only, never revealable
  await page.goto(`${base}/services/traefik?tab=auth`, 1440);
  check((await text()).includes("Only a hash is stored, so it cannot be shown."), "the dashboard login cannot be revealed");
  await shot("auth-traefik", 1440);
  await shot("auth-traefik", 390);

  // Locked and read-only
  await page.goto(`${base}/services/miplata?tab=auth`, 1440);
  await shot("auth-miplata-locked", 1440);
  await page.goto(`${base}/services/jenkins?tab=auth`, 1440);
  await shot("auth-jenkins-readonly", 1440);

  // Failure path
  await page.goto(`${base}/services/huella?tab=auth`, 1440);
  await page.eval(`document.querySelector('details[data-k="edit:STRAVA_CLIENT_ID"] summary').click()`);
  await page.eval(`document.querySelector("#v-STRAVA_CLIENT_ID").value = "FAILME-123"`);
  await page.eval(`document.querySelector('details[data-k="edit:STRAVA_CLIENT_ID"] button[type="submit"]').click()`);
  await confirmOk();
  check(await wait(`document.body.innerText.includes("finished as FAILURE")`, 40_000), "a failing panel-secrets build is reported as failed");
  await shot("auth-huella-failed", 1440);

  for (const l of new Set(page.logs)) console.log(`  console: ${l}`);
  check(page.logs.filter((l) => !l.includes("favicon")).length === 0, "no console errors");
} finally {
  await browser.close();
}
if (fails.length) {
  console.log(`\n${fails.length} failed`);
  process.exit(1);
}
