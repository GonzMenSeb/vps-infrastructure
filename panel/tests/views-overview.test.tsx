import { describe, expect, test } from "bun:test";
import { buildOverview, type OverviewVM } from "../src/views/model";
import { OverviewFrame, OverviewPage } from "../src/views/overview";
import { SECRET_HASH, chrome, downSources, emptySources, input, render, styleAttrs } from "./views-fixtures";

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
});
