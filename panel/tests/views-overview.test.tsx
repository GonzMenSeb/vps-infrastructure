import { describe, expect, test } from "bun:test";
import { buildOverview, type OverviewVM } from "../src/views/model";
import { OverviewFrame, OverviewPage } from "../src/views/overview";
import type { AgentHost } from "../src/collectors/prometheus";
import { AGENT_IDS, FIXTURE_NOW_MS, SECRET_HASH, agentHost, chrome, downSources, emptySources, fullSources, input, render, snap, styleAttrs } from "./views-fixtures";

describe("overview view", () => {
  test("renders the request path, host cards, treemap and attention inside the live frame", async () => {
    const html = await render(<OverviewPage chrome={chrome} vm={buildOverview(input())} />);
    expect(html).toContain('<turbo-frame id="live" refresh="morph" target="_top">');
    expect(html).not.toMatch(/<turbo-frame[^>]*\ssrc=/);
    expect(html).toContain("Traefik v3.6.13");
    expect(html).toContain('<a class="svc degraded" href="/services/monitoring"');
    expect(html).toContain('<a class="svc absent" href="/services/miplata"');
    expect(html).not.toContain('href="/services/llm_inference" title=');
    expect(html).toContain('href="/services/judicabot"');
    expect(html).toContain(">judicabot.web<");
    expect(html).toContain('class="gauges compact"');
    expect((html.match(/class="gauge /g) ?? []).length).toBe(12);
    expect(html).toContain("Biggest users of the main host");
    expect(html).toContain('data-controller="usage"');
    expect(html).toContain("<foreignObject");
    expect(html).toContain("LLM inference is failing");
    expect(html).toContain("Claude Code host");
    expect(html).not.toContain("Both hosts");
    expect(html).toContain("Jenkins is not configured, so running builds cannot be shown.");
    expect(html).toContain("3 hosts · 3/7 services up");
    expect(html).toContain('data-controller="refresh"');
    expect(html).not.toContain(SECRET_HASH);
    expect(styleAttrs(html)).toEqual([]);
  });

  test("controllers load between stimulus and app.js", async () => {
    const html = await render(<OverviewPage chrome={chrome} vm={buildOverview(input())} />);
    const order = ["/public/stimulus.js", "/public/controllers/refresh.js", "/public/controllers/usage.js", "/public/app.js"].map((s) =>
      html.indexOf(s),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("empty sources show waiting states, not zeros", async () => {
    const html = await render(<OverviewFrame vm={buildOverview(input(emptySources()))} />);
    expect(html).toContain("Waiting for the first answer from Prometheus.");
    expect(html).toContain("Waiting for the first answer from Docker.");
    expect(html).not.toContain("Nothing needs attention.");
    expect(html).not.toContain("<foreignObject");
  });

  test("a failing source shows errors and stale badges", async () => {
    const html = await render(<OverviewFrame vm={buildOverview(input(downSources()))} />);
    expect(html).toContain("Prometheus is not answering, so vps resources cannot be shown.");
    expect(html).toContain("prometheus /api/v1/query: HTTP 503");
    expect(html).toContain("Stale · 1 min old");
    expect(html).toContain("Docker data is stale");
  });

  test("renders from a hand-written view-model", async () => {
    const status = { key: "docker" as const, label: "Docker", state: "fresh" as const, ageMs: 1000, error: null };
    const vm: OverviewVM = {
      traefik: { label: "Traefik", tls: null },
      path: [],
      hosts: [],
      treemap: { host: "vps", metric: "mem", compact: true, headValue: "", headLabel: "", tiles: [], empty: "Nothing to show.", status },
      attention: [],
      up: { running: 0, total: 0, building: 0 },
      building: { status: { ...status, key: "jenkins", label: "Jenkins", state: "off", ageMs: null }, rows: [], queued: 0 },
      sources: { prom: { ...status, key: "hosts", label: "Prometheus" }, docker: status },
    };
    const html = await render(<OverviewFrame vm={vm} />);
    expect(html).toContain("TLS resolver not reported");
    expect(html).toContain("The manifest lists no public service on this host.");
    expect(html).toContain("Nothing to show.");
    expect(html).toContain("Nothing needs attention.");
  });

  describe("agent host attention", () => {
    const nowSec = FIXTURE_NOW_MS / 1000;
    const items = (...hosts: AgentHost[]) =>
      buildOverview(input({ ...fullSources(), agent: snap(hosts) })).attention.filter((a) => ["Drift", "Reboot", "Silent"].includes(a.tag));

    test("a healthy agent host adds nothing", () => {
      expect(items(agentHost())).toEqual([]);
    });

    test("drifted settings are a bad item that names them and links to the host page", () => {
      const [a, ...rest] = items(agentHost({ settings: AGENT_IDS.map((id) => ({ id, ok: id !== "zswap" })) }));
      expect(rest).toEqual([]);
      expect(a).toEqual({
        tone: "bad",
        tag: "Drift",
        title: "1 setting is out of place on w1",
        detail: "zswap on",
        href: "/hosts/w1",
      });
      const many = items(agentHost({ settings: AGENT_IDS.map((id) => ({ id, ok: false })) }))[0]!;
      expect(many.title).toBe("13 settings are out of place on w1");
      expect(many.detail).toBe("TCP congestion control, inotify watches, inotify instances, Swap file active and 9 more");
    });

    test("a pending reboot is a warning with both kernels", () => {
      const [a] = items(agentHost({ rebootRequired: true, kernelRunning: "6.8.0-100-generic", kernelNewest: "6.8.0-110-generic" }));
      expect(a).toEqual({
        tone: "warn",
        tag: "Reboot",
        title: "w1 needs a reboot",
        detail: "Running 6.8.0-100-generic, newest installed 6.8.0-110-generic.",
        href: "/hosts/w1",
      });
      expect(items(agentHost({ rebootRequired: true, kernelRunning: null, kernelNewest: null }))[0]!.detail).toBe("A pending reboot is reported.");
      expect(items(agentHost({ rebootRequired: true, kernelNewest: null }))[0]!.detail).toBe("Running 6.8.0-110-generic.");
    });

    test("a report older than ten minutes is a warning, a missing timestamp is not", () => {
      expect(items(agentHost({ runTimestampSec: nowSec - 600 }))).toEqual([]);
      const [a] = items(agentHost({ runTimestampSec: nowSec - 14 * 60 }));
      expect(a).toEqual({
        tone: "warn",
        tag: "Silent",
        title: "w1 has stopped reporting its settings",
        detail: "No settings report arrived for more than 10 minutes. Last report 14 min ago.",
        href: "/hosts/w1",
      });
      expect(items(agentHost({ runTimestampSec: null }))).toEqual([]);
    });

    test("a timestamp that is not valid raises a warning of its own and is never a quiet host", () => {
      for (const ts of [nowSec + 301, 1e300, 9_999_999_999]) {
        expect(items(agentHost({ runTimestampSec: ts }))).toEqual([
          {
            tone: "warn",
            tag: "Silent",
            title: "w1 reports a settings time that is not valid",
            detail: "It counts as not reporting until the host sends a usable time.",
            href: "/hosts/w1",
          },
        ]);
      }
      expect(items(agentHost({ runTimestampSec: null, runTimestampInvalid: true })).map((a) => a.tag)).toEqual(["Silent"]);
      expect(items(agentHost({ runTimestampSec: nowSec + 100 }))).toEqual([]);
    });

    test("all three can stack, and hosts outside the list or without agent data add nothing", () => {
      const sick = agentHost({ settings: [{ id: "zswap", ok: false }], rebootRequired: true, runTimestampSec: nowSec - 3600 });
      expect(items(sick).map((a) => a.tag)).toEqual(["Drift", "Reboot", "Silent"]);
      expect(items(agentHost({ host: "ghost", settings: [{ id: "zswap", ok: false }] }))).toEqual([]);
      expect(items()).toEqual([]);
      const none = buildOverview(input({ ...fullSources(), agent: null })).attention;
      expect(none.some((a) => ["Drift", "Reboot", "Silent"].includes(a.tag))).toBe(false);
    });

    test("a stale snapshot does not raise a silent-host item by itself", () => {
      const sources = { ...fullSources(), agent: snap([agentHost({ runTimestampSec: nowSec - 1200 - 60 })], { lastError: "down", ageMs: 20 * 60_000 }) };
      const tags = buildOverview(input(sources)).attention.map((a) => a.tag);
      expect(tags).toContain("Stale");
      expect(tags).not.toContain("Silent");
    });

    test("the agent source alone failing is a Prometheus source item", () => {
      const sources = { ...fullSources(), agent: snap<AgentHost[]>(undefined, { lastError: "query timed out" }) };
      const a = buildOverview(input(sources)).attention.find((x) => x.tag === "Source");
      expect(a).toMatchObject({ tone: "bad", title: "Prometheus is not answering", detail: "query timed out" });
    });

    test("items render as text, a hostile setting id included", async () => {
      const sick = agentHost({ settings: [{ id: "<script>alert(1)</script>", ok: false }], rebootRequired: true, kernelRunning: "<b>x</b>", kernelNewest: "6.8" });
      const html = await render(<OverviewFrame vm={buildOverview(input({ ...fullSources(), agent: snap([sick]) }))} />);
      expect(html).toContain("1 setting is out of place on w1");
      expect(html).toContain('href="/hosts/w1"');
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert(1)");
      expect(html).not.toContain("<b>x</b>");
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(styleAttrs(html)).toEqual([]);
    });

    test("no new source line on an overview whose agent data is missing", async () => {
      const html = await render(<OverviewFrame vm={buildOverview(input({ ...fullSources(), agent: null }))} />);
      expect(html).not.toContain("out of place");
      expect(html).not.toContain("needs a reboot");
    });
  });
});
