import type { AgentHost } from "../collectors/prometheus";
import { AGENT_SETTINGS_MAX, AGENT_SETTING_NAMES, isKnownSetting, validRunTimestamp } from "../lib/agent-contract";
import type { ServiceHost } from "../manifest";
import { fmtAge, fmtRate, type AttentionVM, type SourceStatus } from "./model";

export const AGENT_STALE_SEC = 600;
export const AGENT_ATTENTION_NAMES = 4;
const NA = "—";
const BLANK_ID = "(blank id)";
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function cleanLabel(s: string): string {
  return s.replace(INVISIBLE, "");
}

export { AGENT_SETTING_NAMES };

const KNOWN_ORDER = Object.keys(AGENT_SETTING_NAMES);

export interface AgentSettingVM {
  id: string;
  name: string;
  known: boolean;
  ok: boolean;
}

export interface AgentStatVM {
  label: string;
  value: string;
}

export interface AgentVM {
  host: ServiceHost;
  status: SourceStatus;
  settings: AgentSettingVM[];
  settingsDropped: number;
  inPlace: number;
  reboot: { known: boolean; pending: boolean; running: string | null; newest: string | null };
  report: { reporting: boolean; invalid: boolean; ageMs: number | null; text: string };
  stats: AgentStatVM[];
}

export function fmtFinePct(p: number): string {
  if (p >= 10) return `${Math.round(p)}%`;
  return `${Number(p.toFixed(p >= 1 ? 1 : 2))}%`;
}

const count = (v: number | null) => (v === null ? NA : String(Math.round(v)));
const or = (v: number | null, f: (n: number) => string) => (v === null ? NA : f(v));

function orderSettings(h: AgentHost): AgentSettingVM[] {
  const rank = (id: string) => {
    const i = KNOWN_ORDER.indexOf(id);
    return i < 0 ? KNOWN_ORDER.length : i;
  };
  return [...h.settings]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
    .slice(0, AGENT_SETTINGS_MAX)
    .map((s) => {
      const known = isKnownSetting(s.id);
      const shown = known ? AGENT_SETTING_NAMES[s.id]! : cleanLabel(s.id) || BLANK_ID;
      return { id: known ? s.id : shown, name: shown, known, ok: s.ok };
    });
}

function reportOf(h: AgentHost, status: SourceStatus, nowMs: number): AgentVM["report"] {
  const ts = h.runTimestampSec;
  const asOf = status.state === "stale" && status.ageMs !== null ? nowMs - status.ageMs : nowMs;
  if (h.runTimestampInvalid || (ts !== null && !validRunTimestamp(ts, asOf))) {
    return { reporting: false, invalid: true, ageMs: null, text: "Not reporting · report time not valid" };
  }
  if (ts === null) return { reporting: false, invalid: false, ageMs: null, text: "Not reporting" };
  const ageMs = Math.max(0, asOf - ts * 1000);
  const reporting = ageMs <= AGENT_STALE_SEC * 1000;
  return {
    reporting,
    invalid: false,
    ageMs,
    text: reporting ? `Last report ${fmtAge(ageMs)}` : `Not reporting · last report ${fmtAge(ageMs)}`,
  };
}

export function buildAgent(host: ServiceHost, h: AgentHost, status: SourceStatus, nowMs: number): AgentVM {
  const settings = orderSettings(h);
  return {
    host,
    status,
    settings,
    settingsDropped: h.settingsDropped + Math.max(h.settings.length - AGENT_SETTINGS_MAX, 0),
    inPlace: settings.filter((s) => s.ok).length,
    reboot: {
      known: h.rebootRequired !== null,
      pending: h.rebootRequired === true,
      running: cleanLabel(h.kernelRunning ?? "") || null,
      newest: cleanLabel(h.kernelNewest ?? "") || null,
    },
    report: reportOf(h, status, nowMs),
    stats: [
      { label: "Swap in", value: or(h.swapInBps, fmtRate) },
      { label: "Swap out", value: or(h.swapOutBps, fmtRate) },
      { label: "Memory pressure", value: or(h.memPressurePct, (v) => `${fmtFinePct(v)} of the time`) },
      { label: "TCP retransmits", value: or(h.tcpRetransPct, (v) => `${fmtFinePct(v)} of segments sent`) },
      { label: "Open files", value: count(h.filesOpen) },
      { label: "Established TCP connections", value: count(h.tcpEstablished) },
      { label: "OOM kills in 24 hours", value: count(h.oomKills24h) },
    ],
  };
}

export function agentAttention(vm: AgentVM): AttentionVM[] {
  const out: AttentionVM[] = [];
  const href = `/hosts/${encodeURIComponent(vm.host)}`;
  const drifted = vm.settings.filter((s) => !s.ok);
  if (drifted.length) {
    const shown = drifted.slice(0, AGENT_ATTENTION_NAMES).map((s) => (s.known ? s.name : `${s.name} (unknown setting)`));
    const more = drifted.length - shown.length;
    out.push({
      tone: "bad",
      tag: "Drift",
      title: `${drifted.length} ${drifted.length === 1 ? "setting is" : "settings are"} out of place on ${vm.host}`,
      detail: `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
      href,
    });
  }
  if (vm.reboot.pending) {
    const { running, newest } = vm.reboot;
    out.push({
      tone: "warn",
      tag: "Reboot",
      title: `${vm.host} needs a reboot`,
      detail: running && newest ? `Running ${running}, newest installed ${newest}.` : running ? `Running ${running}.` : "A pending reboot is reported.",
      href,
    });
  }
  if (vm.report.invalid) {
    out.push({
      tone: "warn",
      tag: "Silent",
      title: `${vm.host} reports a settings time that is not valid`,
      detail: "It counts as not reporting until the host sends a usable time.",
      href,
    });
  } else if (vm.report.ageMs !== null && !vm.report.reporting) {
    out.push({
      tone: "warn",
      tag: "Silent",
      title: `${vm.host} has stopped reporting its settings`,
      detail: `No settings report arrived for more than ${AGENT_STALE_SEC / 60} minutes. Last report ${fmtAge(vm.report.ageMs)}.`,
      href,
    });
  }
  return out;
}
