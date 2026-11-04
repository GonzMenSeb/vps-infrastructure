import { describe, expect, test } from "bun:test";
import { buildLogs, buildService, logsHref, type LogContainer, type LogsView } from "../src/views/model";
import { LogsPage } from "../src/views/logs";
import { chrome, input, render, snap, styleAttrs } from "./views-fixtures";

const lokiView = (data: LogContainer[] | undefined, o: Partial<LogsView> = {}): LogsView => ({
  configured: true,
  snapshot: snap(data),
  ttlMs: 30_000,
  ...o,
});

const page = (logs: LogsView | undefined, q = {}) => render(<LogsPage chrome={chrome} vm={buildLogs({ ...input(), logs }, q)} />);

describe("logs model", () => {
  test("falls back to the manifest and leaves out containers that ship no logs", () => {
    const vm = buildLogs({ ...input(), logs: { configured: true, snapshot: null, ttlMs: 30_000 } });
    expect(vm.listing).toBe("manifest");
    expect(vm.groups.map((g) => g.host)).toEqual(["vps", "jenkins"]);
    expect(vm.groups[0]!.containers).toContain("judicabot");
    expect(vm.groups[1]!.containers).toEqual(["jenkins"]);
    expect(vm.status).toBeNull();
  });

  test("Loki's list wins, grouped by host in a stable order, unknown hosts last", () => {
    const vm = buildLogs({
      ...input(),
      logs: lokiView([
        { host: "zeta", container: "x" },
        { host: "jenkins", container: "jenkins" },
        { host: "vps", container: "traefik" },
        { host: "vps", container: "grafana" },
      ]),
    });
    expect(vm.listing).toBe("loki");
    expect(vm.groups.map((g) => [g.host, g.containers])).toEqual([
      ["vps", ["grafana", "traefik"]],
      ["jenkins", ["jenkins"]],
      ["zeta", ["x"]],
    ]);
    expect(vm.total).toBe(4);
  });

  test("selection resolves host and container, containers are per host", () => {
    const logs = lokiView([
      { host: "vps", container: "alloy2" },
      { host: "jenkins", container: "alloy2" },
      { host: "vps", container: "traefik" },
    ]);
    const sel = (q: { host?: string; container?: string }) => buildLogs({ ...input(), logs }, q);
    expect(sel({ container: "traefik" }).selected).toBe("vps/traefik");
    expect(sel({ host: "jenkins", container: "alloy2" }).selected).toBe("jenkins/alloy2");
    expect(sel({ container: "alloy2" }).selected).toBe("vps/alloy2");
    expect(sel({ host: "jenkins", container: "traefik" })).toMatchObject({ selected: "all", selectedKnown: false });
    expect(sel({ container: "nope" })).toMatchObject({ selected: "all", selectedKnown: false });
    expect(sel({})).toMatchObject({ selected: "all", selectedKnown: true });
  });

  test("builds the link the service page uses", () => {
    expect(logsHref("vps", "a b")).toBe("/logs?host=vps&container=a%20b");
    expect(buildService(input(), "judicabot")!.logsHref).toBe("/logs?host=vps&container=judicabot");
  });
});

describe("logs view", () => {
  test("renders the controller, grouped select, pause and clear without inline styles", async () => {
    const html = await page(lokiView([
      { host: "vps", container: "traefik" },
      { host: "jenkins", container: "jenkins" },
    ]), { host: "vps", container: "traefik" });
    expect(html).toContain('data-controller="logs"');
    expect(html).toContain('data-logs-stream-value="/logs/stream"');
    expect(html).toContain('data-logs-cap-value="1000"');
    expect(html).toContain('data-logs-pause-cap-value="5000"');
    expect(html).toContain('data-logs-tz-value="UTC"');
    expect(html).toContain("All containers (2)");
    expect(html).toContain('<optgroup label="vps">');
    expect(html).toContain('<optgroup label="jenkins">');
    expect(html).toContain('<option value="vps/traefik" selected="">traefik</option>');
    expect(html).toContain('data-action="logs#toggle"');
    expect(html).toContain('data-action="logs#clear"');
    expect(html).toContain('data-logs-target="dropped" hidden');
    expect(html).toContain('role="log"');
    expect(html).not.toContain('data-controller="refresh"');
    expect(styleAttrs(html)).toEqual([]);
  });

  test("says so when the container is unknown or Loki is not configured", async () => {
    expect(await page(lokiView([{ host: "vps", container: "traefik" }]), { container: "ghost" })).toContain("not in the list of containers that ship logs");
    const off = await page({ configured: false, snapshot: null, ttlMs: 30_000 });
    expect(off).toContain("Loki is not configured");
    expect(off).not.toContain('data-controller="logs"');
    expect(await page(undefined)).toContain("Loki is not configured");
  });

  test("a stale container list is flagged", async () => {
    const html = await page(lokiView([{ host: "vps", container: "traefik" }], { snapshot: snap([{ host: "vps", container: "traefik" }], { lastError: "timeout", ageMs: 200_000 }) }));
    expect(html).toContain("Stale");
  });
});
