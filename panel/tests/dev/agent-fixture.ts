export const DEV_AGENT_HOST = "w1";
export const DEV_AGENT_IDS = [
  "congestion_control", "inotify_watches", "inotify_instances", "swap_active", "zswap", "ssh_publickey_only", "ssh_password_off",
  "ssh_keepalive", "ssh_guard_intact", "ssh_rollback_idle", "mosh_installed", "limits_nofile", "linger",
] as const;
export const DEV_AGENT_DRIFTED = "zswap";

type Row = { metric: Record<string, string>; value: [number, string] };

export function agentResponse(nowSec: number) {
  const row = (metric: string, value: number, extra: Record<string, string> = {}): Row => ({
    metric: { host: DEV_AGENT_HOST, metric, ...extra },
    value: [nowSec, String(value)],
  });
  const result: Row[] = [
    ...DEV_AGENT_IDS.map((id) => row("setting", id === DEV_AGENT_DRIFTED ? 0 : 1, { setting: id })),
    row("runTs", nowSec - 45),
    row("reboot", 1),
    row("kernel", 1, { running: "6.8.0-100-generic", newest: "6.8.0-110-generic" }),
    row("swapInBps", 12_288),
    row("swapOutBps", 40_960),
    row("memPressurePct", 0.42),
    row("tcpRetransPct", 0.18),
    row("filesOpen", 3_412),
    row("tcpEstablished", 58),
    row("oomKills24h", 0),
  ];
  return { status: "success", data: { resultType: "vector", result } };
}

export function agentSeries(startSec: number, stepSec: number): { metric: Record<string, string>; values: [number, string][] }[] {
  const len = Math.floor((24 * 3600) / stepSec) + 1;
  const wave = (f: (i: number) => number) =>
    Array.from({ length: len }, (_, i) => [startSec + i * stepSec, String(f(i))] as [number, string]);
  const own: Record<string, (i: number) => number> = {
    cpu: (i) => 12 + 8 * Math.sin(i / 20),
    mem: (i) => 38 + 6 * Math.sin(i / 35),
    rx: (i) => 6e4 * (1 + Math.sin(i / 15) ** 2),
    tx: (i) => 3e4 * (1 + Math.cos(i / 18) ** 2),
    load: (i) => 0.5 + 0.3 * Math.sin(i / 12),
    containers: () => 0,
    swapUsed: (i) => 2.5e8 + i * 1.5e6,
    memPressure: (i) => (i % 60 < 6 ? 2.4 : 0.2),
    tcpRetrans: (i) => 0.1 + 0.08 * Math.sin(i / 9) ** 2,
    filesOpen: (i) => 2800 + 12 * i + 200 * Math.sin(i / 7),
  };
  return Object.entries(own).map(([metric, f]) => ({ metric: { host: DEV_AGENT_HOST, metric }, values: wave(f) }));
}
