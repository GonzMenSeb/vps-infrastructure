import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentHost, HostSeries } from "../src/collectors/prometheus";
import { AGENT_SETTING_NAMES, AGENT_STALE_SEC, buildAgent, fmtFinePct } from "../src/views/agent-model";
import { HostsFrame, agentChartsHtml } from "../src/views/hosts";
import { buildHosts, buildOverview, fmtBytes, sourceStatus } from "../src/views/model";
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
    expect(vmOf({ runTimestampSec: null }).report).toEqual({ reporting: false, invalid: false, ageMs: null, text: "Not reporting" });
  });

  test("report: a timestamp more than 300 s ahead of the panel clock, out of range or flagged invalid is never reporting", () => {
    const text = "Not reporting · report time not valid";
    expect(vmOf({ runTimestampSec: nowSec + 100 }).report).toMatchObject({ reporting: true, invalid: false, ageMs: 0 });
    expect(vmOf({ runTimestampSec: nowSec + 300 }).report).toMatchObject({ reporting: true, invalid: false });
    for (const ts of [nowSec + 301, nowSec + 3600, 1e300, 9_999_999_999, 4_102_444_801]) {
      expect(vmOf({ runTimestampSec: ts }).report).toEqual({ reporting: false, invalid: true, ageMs: null, text });
    }
    expect(vmOf({ runTimestampSec: null, runTimestampInvalid: true }).report).toEqual({ reporting: false, invalid: true, ageMs: null, text });
    expect(vmOf({ runTimestampSec: Number.POSITIVE_INFINITY }).report.reporting).toBe(false);
    expect(vmOf({ runTimestampSec: -5 }).report.reporting).toBe(false);
  });

  test("the future limit is measured against the panel clock, not the snapshot age", () => {
    const sources = { ...fullSources(), agent: snap([agentHost({ runTimestampSec: nowSec + 200 })], { lastError: "down", ageMs: 20 * 60_000 }) };
    expect(vmOf({}, sources).report).toMatchObject({ reporting: true, invalid: false });
  });

  test("setting ids lose control, zero-width and bidi characters for display and stay unknown", () => {
    const vm = vmOf({
      settings: [
        { id: "ssh_password_off\u200b", ok: true },
        { id: "\u202egnittes\u202c", ok: false },
        { id: "\u0000\u200b\u202e", ok: true },
        { id: "a\u0007b\u2066c\u2069d\ufeffe\u061cf\u2028g", ok: true },
        { id: "linger", ok: true },
      ],
    });
    const byName = Object.fromEntries(vm.settings.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["(blank id)", "User services survive logout", "abcdefg", "gnittes", "ssh_password_off"].sort());
    expect(byName["ssh_password_off"]!.known).toBe(false);
    expect(byName["User services survive logout"]!.known).toBe(true);
    for (const s of vm.settings) expect(s.name).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  });

  test("kernel strings lose the same characters", () => {
    const vm = vmOf({ rebootRequired: true, kernelRunning: "6.8.0\u202e-1", kernelNewest: "\u200b\u0000" });
    expect(vm.reboot).toMatchObject({ running: "6.8.0-1", newest: null });
  });

  test("more than 64 settings are cut to 64 rows and counted as dropped", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `s_${i}`, ok: true }));
    const vm = vmOf({ settings: many, settingsDropped: 5 });
    expect(vm.settings).toHaveLength(64);
    expect(vm.settingsDropped).toBe(5 + 16);
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
        }),
      ),
    );
    expect(html).toContain("11 of 13 settings in place");
    expect((html.match(/>Drifted</g) ?? []).length).toBe(2);
    expect(html).toMatch(/<td>zswap on<\/td><td><span class="chip bad"><span class="lamp"><\/span>Drifted<\/span><\/td>/);
    expect(html).toContain("Reboot pending · running 6.8.0-100-generic · newest 6.8.0-110-generic");
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

describe("agent host section limits and absent series", () => {
  test("a flood of settings renders at most 64 rows, a one line note and a small page", async () => {
    const flood = Array.from({ length: 5000 }, (_, i) => ({ id: `flood_${i}_${"x".repeat(100)}`, ok: i % 2 === 0 }));
    const html = await w1(withAgent(agentHost({ settings: [...flood, ...AGENT_IDS.map((id) => ({ id, ok: true }))], settingsDropped: 40 })));
    const table = html.slice(html.indexOf("<th>Setting</th>"), html.indexOf("</table>", html.indexOf("<th>Setting</th>")));
    expect((table.match(/<tr>/g) ?? []).length).toBe(64);
    for (const name of Object.values(AGENT_SETTING_NAMES)) expect(html).toContain(`<td>${name}</td>`);
    expect(html).toContain("4989 more settings are reported and not shown.");
    expect(html.length).toBeLessThan(200_000);
  });

  test("no note when nothing was dropped", async () => {
    expect(await w1()).not.toContain("not shown");
  });

  test("an unknown id keeps its marker in the Overview detail, cleaned of invisible characters", () => {
    const [a] = buildOverview(input(withAgent(agentHost({ settings: [{ id: "ssh_password_off\u202e\u200b", ok: false }, { id: "zswap", ok: false }] }))))
      .attention.filter((x) => x.tag === "Drift");
    expect(a!.detail).toBe("zswap on, ssh_password_off (unknown setting)");
    expect(a!.detail).not.toMatch(/[\u200b\u202e]/);
  });

  test("a bidi override in an id is isolated and stripped in the table", async () => {
    const html = await w1(withAgent(agentHost({ settings: [{ id: "\u202eevil\u202e", ok: true }] })));
    expect(html).toContain("<bdi>evil</bdi> <span");
    expect(html).not.toMatch(/[\u202e\u200b]/);
  });

  test("an agent series that is absent for the host shows the chart empty state, not a zero line", async () => {
    const base = fullSources();
    const series = base.series!.data!.map((s) => (s.host === "w1" ? { ...s, memPressure: [], tcpRetrans: s.tcpRetrans.map((v, i) => (i > 150 ? NaN : v)) } : s));
    const html = await w1({ ...base, series: snap(series) });
    const block = (title: string) => html.split('<div class="chart">').find((b) => b.includes(`<div class="t">${title}</div>`))!;
    expect(block("Memory pressure")).toContain("No data");
    expect(block("Memory pressure")).not.toContain("<svg");
    expect(block("TCP retransmits").match(/<path d="M[^"]*" fill="none"/)![0].split("M").length).toBe(2);
    expect(block("Swap used")).toContain("<svg");
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
    expect(chip(html, "12 of 13 settings in place · last known")).toBe("warn");
    expect(chip(html, "Reboot pending · running 6.8.0-100-generic · newest 6.8.0-110-generic")).toBe("warn");
    expect(chip(html, "Not reporting · last report 11 min ago")).toBe("warn");
    expect(html).not.toMatch(/chip ok"><span class="lamp"><\/span>(Last report|No reboot)/);
  });

  test("a host with no timestamp is amber even when every setting is in place", async () => {
    const html = await w1(withAgent(agentHost({ runTimestampSec: null })));
    expect(chip(html, "Not reporting")).toBe("warn");
    expect(chip(html, "13 of 13 settings in place · last known")).toBe("");
    expect(html).not.toContain("chip ok\"><span class=\"lamp\"></span>13 of 13");
  });

  test("a report older than the stale limit, or one that is not valid, never shows a green settings chip or green rows", async () => {
    for (const ts of [nowSec - 3 * 3600, nowSec - 601, nowSec + 301, 1e300, 9_999_999_999, null]) {
      for (const ok of [true, false]) {
        const html = await w1(withAgent(agentHost({ runTimestampSec: ts, runTimestampInvalid: ts === 1e300, settings: [{ id: "zswap", ok }, { id: "linger", ok: true }] })));
        expect(html).toContain("Not reporting");
        expect(html).toContain("· last known");
        expect(html).not.toMatch(/chip ok"><span class="lamp"><\/span>(\d+ of \d+ settings|In place)/);
        expect((html.match(/>In place · last known</g) ?? []).length).toBe(ok ? 2 : 1);
        expect((html.match(/>Drifted · last known</g) ?? []).length).toBe(ok ? 0 : 1);
        expect(html).not.toMatch(/chip bad"><span class="lamp"><\/span>(Drifted|\d+ of)/);
      }
    }
  });

  test("a fresh report keeps the live tones and none of the last known wording", async () => {
    const html = await w1(withAgent(agentHost({ runTimestampSec: nowSec + 100, settings: [{ id: "zswap", ok: false }, { id: "linger", ok: true }] })));
    expect(html).not.toContain("last known");
    expect(chip(html, "1 of 2 settings in place")).toBe("bad");
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
    expect(html).toMatch(/<td><bdi>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/bdi> <span class="muted">unknown setting<\/span><\/td>/);
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
