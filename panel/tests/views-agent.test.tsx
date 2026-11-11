import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentHost, HostSeries } from "../src/collectors/prometheus";
import { AGENT_SETTING_NAMES, AGENT_STALE_SEC, buildAgent, fmtFinePct } from "../src/views/agent-model";
import { HostsFrame, agentChartsHtml } from "../src/views/hosts";
import { buildHosts, fmtBytes, sourceStatus } from "../src/views/model";
import {
  AGENT_IDS,
  FIXTURE_NOW_MS,
  agentHost,
  downSources,
  emptySources,
  fullSources,
  input,
  render,
  snap,
  styleAttrs,
} from "./views-fixtures";

const nowSec = FIXTURE_NOW_MS / 1000;
const withAgent = (...hosts: AgentHost[]) => ({ ...fullSources(), agent: snap(hosts) });
const w1 = async (sources = fullSources(), metric = "mem") => render(<HostsFrame vm={buildHosts(input(sources), { host: "w1", metric })} />);
const vmOf = (o: Partial<AgentHost>, sources = withAgent(agentHost(o))) => buildHosts(input(sources), { host: "w1" }).agent!;

describe("agent host model", () => {
  test("known ids carry the plain display names, in the role's order", () => {
    expect(AGENT_SETTING_NAMES).toEqual({
      congestion_control: "TCP congestion control",
      inotify_watches: "inotify watches",
      inotify_instances: "inotify instances",
      swap_active: "Swap file active",
      zswap: "zswap on",
      ssh_publickey_only: "ssh: public key only",
      ssh_password_off: "ssh: passwords off",
      ssh_keepalive: "ssh: keepalive",
      ssh_guard_intact: "ssh: password guard file intact",
      ssh_rollback_idle: "ssh: no rollback timer armed",
      mosh_installed: "mosh installed",
      limits_nofile: "Open-file limit for logins",
      linger: "User services survive logout",
    });
    expect(Object.keys(AGENT_SETTING_NAMES)).toEqual([...AGENT_IDS]);
  });

  test("counts settings in place and keeps known ids first, then unknown ones by id", () => {
    const vm = vmOf({
      settings: [
        { id: "zzz_new", ok: true },
        { id: "linger", ok: false },
        { id: "aaa_new", ok: false },
        { id: "congestion_control", ok: true },
      ],
    });
    expect(vm.settings.map((s) => s.id)).toEqual(["congestion_control", "linger", "aaa_new", "zzz_new"]);
    expect(vm.settings.map((s) => s.known)).toEqual([true, true, false, false]);
    expect(vm.settings[0]!.name).toBe("TCP congestion control");
    expect(vm.settings[2]!.name).toBe("aaa_new");
    expect(vm.inPlace).toBe(2);
  });

  test("an id that names an object property is an unknown setting, not a lookup", () => {
    const vm = vmOf({ settings: [{ id: "constructor", ok: true }, { id: "__proto__", ok: true }, { id: "toString", ok: false }] });
    expect(vm.settings.every((s) => !s.known)).toBe(true);
    expect(vm.settings.map((s) => s.name).sort()).toEqual(["__proto__", "constructor", "toString"]);
  });

  test("reboot: pending carries both kernels, not pending and unknown are told apart", () => {
    expect(vmOf({ rebootRequired: true, kernelRunning: "6.8.0-9", kernelNewest: "6.8.0-10" }).reboot).toEqual({
      known: true, pending: true, running: "6.8.0-9", newest: "6.8.0-10",
    });
    expect(vmOf({ rebootRequired: false }).reboot).toMatchObject({ known: true, pending: false });
    expect(vmOf({ rebootRequired: null }).reboot).toMatchObject({ known: false, pending: false });
  });

  test("report: reporting up to ten minutes, not reporting after, and without a timestamp", () => {
    const at = (ageSec: number) => vmOf({ runTimestampSec: nowSec - ageSec }).report;
    expect(AGENT_STALE_SEC).toBe(600);
    expect(at(30)).toMatchObject({ reporting: true, text: "Last report 30 s ago" });
    expect(at(600).reporting).toBe(true);
    expect(at(601)).toMatchObject({ reporting: false, text: "Not reporting · last report 10 min ago" });
    expect(at(3 * 3600)).toMatchObject({ reporting: false, text: "Not reporting · last report 3 h ago" });
    expect(at(-120)).toMatchObject({ reporting: true, ageMs: 0 });
    expect(vmOf({ runTimestampSec: null }).report).toEqual({ reporting: false, ageMs: null, text: "Not reporting" });
  });

  test("a stale Prometheus snapshot does not make the host look silent", () => {
    const sources = { ...fullSources(), agent: snap([agentHost({ runTimestampSec: nowSec - 1200 - 100 })], { lastError: "down", ageMs: 20 * 60_000 }) };
    expect(sourceStatus("agent", sources.agent).state).toBe("stale");
    expect(vmOf({}, sources).report).toMatchObject({ reporting: true, ageMs: 100_000 });
    const old = { ...fullSources(), agent: snap([agentHost({ runTimestampSec: nowSec - 1200 - 1500 })], { lastError: "down", ageMs: 20 * 60_000 }) };
    expect(vmOf({}, old).report.reporting).toBe(false);
  });

  test("instant values are formatted, and missing ones show a dash", () => {
    const vm = vmOf({ oomKills24h: 3 });
    expect(Object.fromEntries(vm.stats.map((s) => [s.label, s.value]))).toEqual({
      "Swap in": "4.1 kB/s",
      "Swap out": "8.2 kB/s",
      "Memory pressure": "0.35% of the time",
      "TCP retransmits": "0.12% of segments sent",
      "Open files": "2048",
      "Established TCP connections": "37",
      "OOM kills in 24 hours": "3",
    });
    const none = vmOf({
      swapInBps: null, swapOutBps: null, memPressurePct: null, tcpRetransPct: null, filesOpen: null, tcpEstablished: null, oomKills24h: null,
    });
    expect(none.stats.every((s) => s.value === "—")).toBe(true);
  });

  test("fine percent keeps sub-percent values visible", () => {
    expect([0, 0.004, 0.35, 1.234, 9.96, 12.6, 100].map(fmtFinePct)).toEqual(["0%", "0%", "0.35%", "1.2%", "10%", "13%", "100%"]);
  });

  test("buildAgent can be called straight from collector data", () => {
    const status = sourceStatus("agent", snap([agentHost()]));
    expect(buildAgent("w1", agentHost(), status, FIXTURE_NOW_MS).inPlace).toBe(13);
  });
});

describe("agent host section", () => {
  test("shows the status line, the settings table, the values and four charts for w1", async () => {
    const html = await w1();
    expect(html).toContain('aria-label="Agent host"');
    expect(html).toContain("What the agent_host role set up on w1");
    expect(html).toContain("13 of 13 settings in place");
    expect(html).toContain("No reboot pending");
    expect(html).toContain("Last report 1 min ago");
    expect((html.match(/>In place</g) ?? []).length).toBe(13);
    for (const name of Object.values(AGENT_SETTING_NAMES)) expect(html).toContain(`<td>${name}</td>`);
    expect(html).not.toContain("unknown setting");
    for (const label of ["Swap in", "Swap out", "Memory pressure", "TCP retransmits", "Open files", "Established TCP connections", "OOM kills in 24 hours"]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
    expect(html).toContain("0.35% of the time");
    for (const t of ["Swap used", "Memory pressure", "TCP retransmits", "Open files"]) expect(html).toContain(`<div class="t">${t}</div>`);
    expect((html.match(/<div class="chart">/g) ?? []).length).toBe(9);
    expect(html).toContain("Prometheus · 4 s ago");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("drifted settings, a pending reboot and a silent agent are marked", async () => {
    const html = await w1(
      withAgent(
        agentHost({
          settings: AGENT_IDS.map((id) => ({ id, ok: id !== "zswap" && id !== "linger" })),
          rebootRequired: true,
          kernelRunning: "6.8.0-100-generic",
          kernelNewest: "6.8.0-110-generic",
          runTimestampSec: nowSec - 11 * 60,
        }),
      ),
    );
    expect(html).toContain("11 of 13 settings in place");
    expect((html.match(/>Drifted</g) ?? []).length).toBe(2);
    expect(html).toMatch(/<td>zswap on<\/td><td><span class="chip bad"><span class="lamp"><\/span>Drifted<\/span><\/td>/);
    expect(html).toContain("Reboot pending · running 6.8.0-100-generic · newest 6.8.0-110-generic");
    expect(html).toContain("Not reporting · last report 11 min ago");
  });

  test("no timestamp and no settings read as not reporting with an empty table", async () => {
    const html = await w1(withAgent(agentHost({ settings: [], runTimestampSec: null, rebootRequired: true, kernelRunning: null, kernelNewest: null })));
    expect(html).toContain("No settings reported");
    expect(html).toContain("w1 is not reporting any setting right now.");
    expect(html).toContain("Not reporting");
    expect(html).toContain("Reboot pending");
    expect(html).not.toContain("· running");
  });

  test("a stale source keeps the data and says how old it is", async () => {
    const html = await w1({ ...fullSources(), agent: snap([agentHost({ runTimestampSec: nowSec - 100 })], { lastError: "boom", ageMs: 5 * 60_000 }) });
    expect(html).toContain("Stale · 5 min old");
    expect(html).toContain("13 of 13 settings in place");
  });

  test("hosts without agent data keep their page exactly as it was", async () => {
    for (const host of ["vps", "jenkins"]) {
      const before = await render(<HostsFrame vm={buildHosts(input({ ...fullSources(), agent: null }), { host })} />);
      const after = await render(<HostsFrame vm={buildHosts(input(), { host })} />);
      expect(after).toBe(before);
      expect(after).not.toContain("Agent host");
      expect((after.match(/<div class="chart">/g) ?? []).length).toBe(5);
    }
  });

  test("a failing or empty agent source adds nothing to the page", async () => {
    for (const sources of [downSources(), emptySources(), { ...fullSources(), agent: snap<AgentHost[]>([]) }]) {
      const html = await w1(sources);
      expect(html).not.toContain("Agent host");
    }
  });

  test("the charts say why they are missing, using the shared empty states", async () => {
    const missing = await w1({ ...fullSources(), series: snap(fullSources().series!.data!.filter((s) => s.host !== "w1")) });
    expect(missing).toContain('aria-label="Agent host"');
    expect((missing.match(/Prometheus returned no series for w1 in the last 24 hours\./g) ?? []).length).toBe(2);
    const waiting = await w1({ ...fullSources(), series: snap<HostSeries[]>(undefined) });
    expect(waiting).toContain("Waiting for the first answer from Prometheus.");
    const down = await w1({ ...fullSources(), series: snap<HostSeries[]>(undefined, { lastError: "HTTP 503" }) });
    expect(down).toContain("Prometheus is not answering, so the agent host charts cannot be shown.");
    expect(down).toContain("13 of 13 settings in place");
  });

  test("the four charts are built with the shared helper from the new series", () => {
    const s = buildHosts(input(), { host: "w1" }).charts;
    const html = agentChartsHtml(s);
    expect(html.match(/<div class="t">([^<]+)<\/div>/g)).toEqual([
      '<div class="t">Swap used</div>',
      '<div class="t">Memory pressure</div>',
      '<div class="t">TCP retransmits</div>',
      '<div class="t">Open files</div>',
    ]);
    expect(html).toContain("var(--swap)");
    expect(html).toContain("var(--mem)");
    expect(html).not.toMatch(/\bstyle=/);
  });
});

describe("agent host section tones and plotted data", () => {
  const chip = (html: string, text: string) => html.match(new RegExp(`<span class="chip([^"]*)"><span class="lamp"></span>${text}</span>`))?.[1]?.trim();

  test("the status line is green only when nothing drifted, nothing is pending and the host is reporting", async () => {
    const healthy = await w1();
    expect(chip(healthy, "13 of 13 settings in place")).toBe("ok");
    expect(chip(healthy, "No reboot pending")).toBe("ok");
    expect(chip(healthy, "Last report 1 min ago")).toBe("ok");
    expect((healthy.match(/>In place</g) ?? []).length).toBe(13);
    expect(healthy).not.toMatch(/chip (bad|warn)/);
  });

  test("drift is red, a pending reboot and a silent agent are amber", async () => {
    const html = await w1(
      withAgent(
        agentHost({
          settings: AGENT_IDS.map((id) => ({ id, ok: id !== "zswap" })),
          rebootRequired: true,
          kernelRunning: "6.8.0-100-generic",
          kernelNewest: "6.8.0-110-generic",
          runTimestampSec: nowSec - 11 * 60,
        }),
      ),
    );
    expect(chip(html, "12 of 13 settings in place")).toBe("bad");
    expect(chip(html, "Reboot pending · running 6.8.0-100-generic · newest 6.8.0-110-generic")).toBe("warn");
    expect(chip(html, "Not reporting · last report 11 min ago")).toBe("warn");
    expect(html).not.toMatch(/chip ok"><span class="lamp"><\/span>(Last report|No reboot)/);
  });

  test("a host with no timestamp is amber even when every setting is in place", async () => {
    const html = await w1(withAgent(agentHost({ runTimestampSec: null })));
    expect(chip(html, "Not reporting")).toBe("warn");
    expect(chip(html, "13 of 13 settings in place")).toBe("ok");
  });

  test("table chips follow each setting's own state", async () => {
    const html = await w1(withAgent(agentHost({ settings: [{ id: "linger", ok: true }, { id: "zswap", ok: false }] })));
    expect(html).toMatch(/<td>User services survive logout<\/td><td><span class="chip ok"><span class="lamp"><\/span>In place<\/span><\/td>/);
    expect(html).toMatch(/<td>zswap on<\/td><td><span class="chip bad"><span class="lamp"><\/span>Drifted<\/span><\/td>/);
    expect(chip(html, "1 of 2 settings in place")).toBe("bad");
  });

  test("each chart plots its own series with its own formatter", () => {
    const flat = (v: number) => Array.from({ length: 301 }, () => v);
    const base = buildHosts(input(), { host: "w1" }).charts;
    const html = agentChartsHtml({
      ...base,
      series: { ...base.series!, dataStartSec: base.series!.startSec, cpu: flat(11), mem: flat(12), swapUsed: flat(5e8), memPressure: flat(2.5), tcpRetrans: flat(0.35), filesOpen: flat(7000) },
    });
    const row = (title: string) => {
      const block = html.split('<div class="chart">').find((b) => b.includes(`<div class="t">${title}</div>`))!;
      return [...block.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    };
    expect(row("Swap used")).toEqual(["Swap", ...Array(4).fill(fmtBytes(5e8))]);
    expect(row("Memory pressure")).toEqual(["Pressure", ...Array(4).fill("2.5%")]);
    expect(row("TCP retransmits")).toEqual(["Retransmitted", ...Array(4).fill("0.35%")]);
    expect(row("Open files")).toEqual(["Files", ...Array(4).fill("7000")]);
  });
});

describe("agent host section escaping", () => {
  const hostile = '<script>alert(1)</script>';
  const kernel = '"><img src=x onerror=alert(1)>';

  test("a hostile setting id and kernel label are shown as text, never as markup", async () => {
    const html = await w1(
      withAgent(
        agentHost({
          settings: [{ id: hostile, ok: false }, { id: "linger", ok: true }],
          rebootRequired: true,
          kernelRunning: kernel,
          kernelNewest: hostile,
        }),
      ),
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('"><img');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toMatch(/<td>&lt;script&gt;alert\(1\)&lt;\/script&gt; <span class="muted">unknown setting<\/span><\/td>/);
    expect((html.match(/unknown setting/g) ?? []).length).toBe(1);
    expect(html).toContain("1 of 2 settings in place");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("the agent view code never injects markup: raw() only wraps the chart helper's own output", () => {
    for (const f of ["src/views/agent.tsx", "src/views/agent-model.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/\braw\b|dangerouslySetInnerHTML|innerHTML/);
    }
    const hosts = readFileSync("src/views/hosts.tsx", "utf8");
    expect([...hosts.matchAll(/\braw\((\w+)\(vm\)\)/g)].map((m) => m[1]).sort()).toEqual(["agentChartsHtml", "chartsHtml"]);
    expect((hosts.match(/\braw\(/g) ?? []).length).toBe(2);
  });
});
