import { raw } from "hono/html";
import { chart } from "../lib/charts";
import { Layout } from "./layout";
import { HostCard, LiveFrame, SourceEmpty, SourceNote, Treemap } from "./components";
import { USAGE_METRICS, fmtRate, hasData, type ChartsVM, type HostsVM } from "./model";
import type { Chrome } from "./overview";

const pc = (v: number) => `${Math.round(v)}%`;
const ld = (v: number) => (v >= 10 ? v.toFixed(0) : String(Number(v.toFixed(2))));
const ct = (v: number) => String(Math.round(v));

export function chartsHtml(c: ChartsVM): string {
  const s = c.series!;
  const x = c.xLabels;
  const from = s.dataStartSec !== null ? Math.max(0, Math.round((s.dataStartSec - s.startSec) / s.stepSec)) : 0;
  return [
    chart({ title: "CPU busy", series: [{ name: "CPU", c: "cpu", data: s.cpu }], fmt: pc, xLabels: x, fixedMax: 100, from }),
    chart({ title: "Memory used", series: [{ name: "Memory", c: "mem", data: s.mem }], fmt: pc, xLabels: x, fixedMax: 100, from }),
    chart({
      title: "Network",
      series: [
        { name: "received", c: "rx", data: s.rx },
        { name: "sent", c: "tx", data: s.tx },
      ],
      fmt: fmtRate,
      xLabels: x,
      legend: true,
      from,
    }),
    chart({ title: "Load (1m)", series: [{ name: "Load", c: "load", data: s.load }], fmt: ld, xLabels: x, from }),
    chart({ title: "Containers on host", series: [{ name: "Containers", c: "cnt", data: s.containers }], fmt: ct, xLabels: x, from }),
  ].join("");
}

function Charts({ vm, host }: { vm: ChartsVM; host: string }) {
  return (
    <section class="panel" aria-label="Last 24 hours">
      <header>
        <h2>Last 24 hours</h2>
        <SourceNote
          status={vm.status}
          extra={vm.stepSec ? `${vm.stepSec}-second steps · ${vm.timeZone}${vm.dataSince ? ` · data since ${vm.dataSince}` : ""}` : undefined}
        />
      </header>
      {vm.series ? (
        <div class="charts">{raw(chartsHtml(vm))}</div>
      ) : hasData(vm.status) ? (
        <div class="body empty">
          <p>Prometheus returned no series for {host} in the last 24 hours.</p>
        </div>
      ) : (
        <SourceEmpty status={vm.status} what="the last 24 hours" />
      )}
    </section>
  );
}

export const hostsHref = (host: string, metric: string) =>
  `/hosts/${encodeURIComponent(host)}${metric === "mem" ? "" : `?metric=${encodeURIComponent(metric)}`}`;

export function HostsFrame({ vm }: { vm: HostsVM }) {
  return (
    <LiveFrame up={vm.up}>
      <div class="bar">
        <div class="seg" role="group" aria-label="Host">
          {vm.hosts.map((h) => (
            <a href={hostsHref(h, vm.metric)} aria-current={h === vm.host ? "true" : undefined}>
              {h}
            </a>
          ))}
        </div>
      </div>
      <div class="stack">
        <HostCard vm={vm.card} compact={false} />
        <Charts vm={vm.charts} host={vm.host} />
        <section class="panel" aria-label="Usage by container">
          <header>
            <h2>Usage by container</h2>
            <span class="sub">
              <span class="seg" role="group" aria-label="Metric">
                {USAGE_METRICS.map((m) => (
                  <a href={hostsHref(vm.host, m.id)} aria-current={m.id === vm.metric ? "true" : undefined}>
                    {m.label}
                  </a>
                ))}
              </span>
            </span>
          </header>
          <Treemap vm={vm.treemap} />
        </section>
      </div>
    </LiveFrame>
  );
}

export function HostsPage({ chrome, vm }: { chrome: Chrome; vm: HostsVM }) {
  return (
    <Layout title="Hosts" login={chrome.login} csrf={chrome.csrf} current="hosts" up={vm.up} refresh={true}>
      <h1>Hosts</h1>
      <p class="lede">Resource use on each VPS, how it moved over the last day, and which containers are responsible.</p>
      <HostsFrame vm={vm} />
    </Layout>
  );
}
