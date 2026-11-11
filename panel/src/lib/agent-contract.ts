export const AGENT_SETTING_NAMES: Readonly<Record<string, string>> = {
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
};

export const isKnownSetting = (id: string): boolean => Object.hasOwn(AGENT_SETTING_NAMES, id);

export const AGENT_SETTINGS_MAX = 64;
export const AGENT_RUN_TS_MAX_SEC = 4102444800;
export const AGENT_RUN_TS_SKEW_SEC = 300;

export const validRunTimestamp = (tsSec: number, nowMs: number): boolean =>
  Number.isFinite(tsSec) && tsSec > 0 && tsSec <= AGENT_RUN_TS_MAX_SEC && tsSec * 1000 <= nowMs + AGENT_RUN_TS_SKEW_SEC * 1000;
