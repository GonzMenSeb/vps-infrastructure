import { describe, expect, test } from "bun:test";
import { HostsFrame, HostsPage } from "../src/views/hosts";
import { buildHosts } from "../src/views/model";
import { chrome, downSources, input, render, styleAttrs } from "./views-fixtures";

describe("hosts view", () => {
  test("six gauges, five charts and the usage switch", async () => {
    const html = await render(<HostsPage chrome={chrome} vm={buildHosts(input(), { host: "vps", metric: "mem" })} />);
    expect(html).toContain('class="gauges"');
    expect((html.match(/class="gauge /g) ?? []).length).toBe(6);
    expect(html).toContain("Network now");
    expect(html).toContain("Load 1 · 5 · 15 min");
    expect(html).toContain("0.84 · 0.71 · 0.66");
    expect(html).toContain("4 cores");
    expect(html).toContain("up 3d 4h");
    expect(html).toContain("Public web host · Ubuntu 24.04.3 LTS");
    expect(html).toContain("No swap configured");
    expect((html.match(/<div class="chart">/g) ?? []).length).toBe(5);
    for (const t of ["CPU busy", "Memory used", "Network", "Load (1m)", "Containers on host"]) expect(html).toContain(`<div class="t">${t}</div>`);
    expect(html).toContain("288-second steps · UTC");
    expect(html).toContain('href="/hosts/jenkins"');
    expect(html).toContain('<a href="/hosts/vps?metric=disk">Disk</a>');
    expect(html).toContain('aria-current="true">Memory</a>');
    expect(html).toContain('aria-current="true">vps</a>');
    expect(html).toContain("of 8 GB used");
    expect(styleAttrs(html)).toEqual([]);
  });

  test("tiles are links with tiers, colors and hover data", async () => {
    const html = await render(<HostsFrame vm={buildHosts(input(), { host: "vps", metric: "mem" })} />);
    expect(html).toMatch(/<a class="seg tc-\d" data-usage-target="seg"[^>]*href="\/services\/monitoring"/);
    expect(html).toContain('class="tile t');
    expect(html).toContain(' free"');
    expect(html).toContain('class="seg tc-free"');
    expect(html).toContain('data-usage-val-value="3 GB"');
  });

  test("jenkins host disk and missing series show empty states", async () => {
    const disk = await render(<HostsFrame vm={buildHosts(input(), { host: "jenkins", metric: "disk" })} />);
    expect(disk).toContain("only reach on vps");
    const jenkins = await render(<HostsFrame vm={buildHosts(input(), { host: "jenkins", metric: "cpu" })} />);
    expect(jenkins).toMatch(/data since \d\d:\d\d/);
    expect(jenkins).toContain("combined · 100% is one core");
    const down = await render(<HostsFrame vm={buildHosts(input(downSources()), { host: "jenkins", metric: "cpu" })} />);
    expect(down).toContain("Prometheus is not answering, so the last 24 hours cannot be shown.");
    expect(down).toContain("Prometheus is not answering, so usage by container cannot be shown.");
  });
});
