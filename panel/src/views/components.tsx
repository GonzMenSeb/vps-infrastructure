import type { Child } from "hono/jsx";
import { railState, type Up } from "./layout";
import {
  STATE_LABEL,
  bytesParts,
  fmtAge,
  fmtBytes,
  fmtNum,
  fmtPct,
  fmtRate,
  fmtUptime,
  type HostCardVM,
  type ServiceState,
  type SourceStatus,
  type TreemapVM,
} from "./model";

export type Tone = "ok" | "warn" | "bad" | "info" | "";

export function Chip({ tone = "", lamp = true, pulse = false, title, children }: { tone?: Tone; lamp?: boolean; pulse?: boolean; title?: string; children?: Child }) {
  return (
    <span class={`chip ${tone}`.trim()} title={title}>
      {lamp ? <span class={pulse ? "lamp pulse" : "lamp"}></span> : null}
      {children}
    </span>
  );
}

const STATE_TONE: Record<ServiceState, Tone> = {
  running: "ok",
  degraded: "warn",
  failing: "bad",
  stopped: "",
  absent: "",
  reporting: "info",
  unknown: "",
};

const STATE_TITLE: Partial<Record<ServiceState, string>> = {
  absent: "None of the manifest's containers exist on this host",
  reporting: "Seen in cAdvisor metrics; the panel cannot reach this host's Docker",
  unknown: "The panel has no state for this service yet",
};

export function StateChip({ state }: { state: ServiceState }) {
  return (
    <Chip tone={STATE_TONE[state]} title={STATE_TITLE[state]}>
      {STATE_LABEL[state]}
    </Chip>
  );
}

export function SourceNote({ status, extra, text, named }: { status: SourceStatus; extra?: string; text?: string; named?: boolean }) {
  if (status.state === "stale") {
    return (
      <span class="sub">
        <Chip tone="warn" title={status.error ?? undefined}>
          {named ? `${status.label} · stale` : "Stale"} · {fmtAge(status.ageMs).replace(" ago", " old")}

        </Chip>
      </span>
    );
  }
  if (status.state !== "fresh") return <span class="sub src">{status.label}</span>;
  if (text) return <span class="sub">{text}</span>;
  return (
    <span class="sub src">
      {status.label} · {fmtAge(status.ageMs)}
      {extra ? ` · ${extra}` : ""}
    </span>
  );
}

export function SourceEmpty({ status, what }: { status: SourceStatus; what: string }) {
  const text =
    status.state === "off"
      ? `${status.label} is not configured, so ${what} cannot be shown.`
      : status.state === "error"
        ? `${status.label} is not answering, so ${what} cannot be shown.`
        : `Waiting for the first answer from ${status.label}.`;
  return (
    <div class={`body empty ${status.state}`} data-source={status.key}>
      <p>{text}</p>
      {status.state === "error" && status.error ? <p class="hint mono">{status.error}</p> : null}
    </div>
  );
}

export function Track({ pct, c }: { pct: number; c?: string }) {
  const p = Math.max(0, Math.min(Number.isFinite(pct) ? pct : 0, 100));
  return (
    <svg class={`track${c ? ` c-${c}` : ""}`} aria-hidden="true" focusable="false">
      <rect class={p >= 90 ? "bad" : undefined} width={`${Math.round(p * 10) / 10}%`} height="100%" />
    </svg>
  );
}

export function Meter({ label, text, pct, c }: { label: string; text: string; pct: number; c: string }) {
  return (
    <div class="meter">
      <div class="row">
        <span>{label}</span>
        <b>{text}</b>
      </div>
      <Track pct={pct} c={c} />
    </div>
  );
}

function Gauge({ c, label, big, unit, sub, pct, small }: { c: string; label: string; big: string; unit: string; sub: string; pct: number | null; small?: boolean }) {
  return (
    <div class={`gauge c-${c}`}>
      <div class="lab">
        <i></i>
        {label}
      </div>
      <div class={small ? "big sm" : "big"}>
        {big}
        <small>{unit}</small>
      </div>
      {pct !== null ? <Track pct={pct} /> : null}
      <div class="sub">{sub}</div>
    </div>
  );
}

const NA = "—";

function bytesGauge(c: string, label: string, used: number | null, total: number | null, zeroNote?: string) {
  if (used === null || total === null) return <Gauge c={c} label={label} big={NA} unit="" sub="Not reported" pct={null} />;
  if (total === 0 && zeroNote) return <Gauge c={c} label={label} big="0" unit="B" sub={zeroNote} pct={0} />;
  const [n, u] = bytesParts(used);
  return <Gauge c={c} label={label} big={n} unit={u} sub={`of ${fmtBytes(total)}`} pct={total ? (used / total) * 100 : 0} />;
}

export function HostCard({ vm, compact }: { vm: HostCardVM; compact: boolean }) {
  const m = vm.metrics;
  const cores = m?.cores ? `${fmtNum(m.cores)} cores` : null;
  const loads = m ? [m.load1, m.load5, m.load15] : [];
  return (
    <section class="panel" aria-label={`Host ${vm.host}`}>
      <header>
        <h2>{vm.host}</h2>
        <span class="muted">
          {vm.role}
          {m?.os ? ` · ${m.os}` : ""}
        </span>
        <SourceNote status={vm.status} text={m?.uptimeSec != null ? `up ${fmtUptime(m.uptimeSec)}` : undefined} />
      </header>
      {m ? (
        <div class={compact ? "gauges compact" : "gauges"}>
          <Gauge
            c="cpu"
            label="CPU"
            big={m.cpuPct !== null ? String(Math.round(m.cpuPct)) : NA}
            unit={m.cpuPct !== null ? "%" : ""}
            sub={cores ?? "busy, all cores"}
            pct={m.cpuPct}
          />
          {bytesGauge("mem", "Memory", m.memUsed, m.memTotal)}
          {bytesGauge("disk", "Disk", m.diskUsed, m.diskTotal)}
          {bytesGauge("swap", "Swap", m.swapUsed, m.swapTotal, "No swap configured")}
          {compact ? null : (
            <>
              <div class="gauge c-rx">
                <div class="lab">
                  <i></i>Network now
                </div>
                <div class="duo">
                  <span>↓ {m.rxBps !== null ? fmtRate(m.rxBps) : NA}</span>
                  <span>↑ {m.txBps !== null ? fmtRate(m.txBps) : NA}</span>
                </div>
              </div>
              <Gauge
                c="load"
                label="Load 1 · 5 · 15 min"
                big={loads.map((l) => (l === null ? NA : l.toFixed(2))).join(" · ")}
                unit=""
                sub={cores ?? (m.containers !== null ? `${fmtNum(m.containers)} containers` : "")}
                pct={null}
                small={true}
              />
            </>
          )}
        </div>
      ) : vm.status.state === "fresh" || vm.status.state === "stale" ? (
        <div class="body empty">
          <p>Prometheus has no node metrics for {vm.host}.</p>
        </div>
      ) : (
        <SourceEmpty status={vm.status} what={`${vm.host} resources`} />
      )}
    </section>
  );
}

export function Treemap({ vm }: { vm: TreemapVM }) {
  if (vm.empty !== null) return <div class="body empty"><p>{vm.empty}</p></div>;
  if (vm.tiles.length === 0) return <SourceEmpty status={vm.status} what="usage by container" />;
  return (
    <div class="usage" data-controller="usage" data-usage-val-value={vm.headValue} data-usage-lab-value={vm.headLabel}>
      <div class="usehead">
        <b data-usage-target="val">{vm.headValue}</b>
        <span data-usage-target="lab">{vm.headLabel}</span>
        {vm.status.state === "stale" ? <SourceNote status={vm.status} /> : null}
      </div>
      <div class={vm.compact ? "treemap compact" : "treemap"}>
        <svg width="100%" height="100%" role="group" aria-label={`Usage by container on ${vm.host}`}>
          {vm.tiles.map((t) => {
            const cls = `tile t${t.tier}${t.free ? " free" : ""}${t.tier === 0 ? " tiny" : ""}`;
            const segAttrs = {
              class: `seg ${t.color}`,
              "data-usage-target": "seg",
              "data-i": String(t.i),
              "data-n": t.name,
              "data-v": t.valueText,
              "data-p": t.pctText,
              "data-action": "mouseenter->usage#focus mouseleave->usage#blur focusin->usage#focus focusout->usage#blur",
            };
            const body = (
              <>
                <b>{t.name}</b>
                {t.tier >= 2 ? (
                  <span class="v">
                    {t.valueText} · {t.pctText}
                  </span>
                ) : null}
                {t.lines.map((l) => (
                  <em class={l.sans ? "s" : undefined}>
                    {l.dot ? <i class={`dot st-${l.dot}`}></i> : null}
                    {l.text}
                  </em>
                ))}
              </>
            );
            return (
              <foreignObject x={`${t.x}%`} y={`${t.y}%`} width={`${t.w}%`} height={`${t.h}%`}>
                <div class={cls} title={`${t.name} · ${t.valueText}`}>
                  {t.href ? (
                    <a {...segAttrs} href={t.href} aria-label={`Open ${t.serviceName}: ${t.name}, ${t.valueText}`}>
                      {body}
                    </a>
                  ) : (
                    <div {...segAttrs}>{body}</div>
                  )}
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export function LiveFrame({ up, children }: { up?: Up; children?: Child }) {
  const rail = up ? Object.fromEntries(Object.entries(railState(up)).map(([k, v]) => [`data-${k}`, v])) : null;
  return (
    <turbo-frame id="live" refresh="morph" target="_top">
      {rail ? <span hidden data-rail-state {...rail}></span> : null}
      {children}
    </turbo-frame>
  );
}

export function Placeholder({ phase, children }: { phase: number; children?: Child }) {
  return (
    <div class="body placeholder">
      <Chip tone="info" lamp={false}>
        Phase {phase}
      </Chip>
      <p>{children}</p>
    </div>
  );
}

export const fmtCpu = (p: number | null) => (p === null ? NA : fmtPct(p));
export const fmtMem = (b: number | null) => (b === null ? NA : fmtBytes(b));
