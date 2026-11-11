#!/bin/bash
# shellcheck disable=SC2012
set -u
export LC_ALL=C PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

USER_NAME=ubuntu
SYSCTLS=
ROWS_B64=
KILL_SINCE=
CONT_RE=()
MODE=collect
FPROOT=

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME=$2; shift 2 ;;
    --sysctl) SYSCTLS=$2; shift 2 ;;
    --rows-b64) ROWS_B64=$2; shift 2 ;;
    --kill-since) KILL_SINCE=$2; shift 2 ;;
    --continuity-re) CONT_RE+=("$2"); shift 2 ;;
    --sysboot-stdin) MODE=sysboot; shift ;;
    --fp-root) FPROOT=$2; shift 2 ;;
    --fp-only) MODE=fp; shift ;;
    *) echo "usage: $0 [--user U] [--sysctl k,..] [--rows-b64 B64] [--continuity-re RE].. [--kill-since EPOCH] [--sysboot-stdin] [--fp-root DIR] [--fp-only]" >&2; exit 2 ;;
  esac
done

t() { timeout 10 "$@" 2>/dev/null; }
emit() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n\t\r' '   ')"; }
csv() { local IFS=,; read -ra _out <<<"$1"; printf '%s\n' "${_out[@]}"; }
starttime() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; }

sysboot_eval() {
  awk '
    /^# \/(etc|run|usr\/lib|lib)\/.*\.conf$/ { file = substr($0, 3); next }
    /^[[:space:]]*[#;]/ { next }
    {
      line = $0
      sub(/^[[:space:]]*-/, "", line)
      i = index(line, "=")
      if (i == 0) next
      k = substr(line, 1, i - 1)
      v = substr(line, i + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub("/", ".", k)
      val[k] = v
      src[k] = file
    }
    END { for (k in val) printf "sysboot.%s=%s\nsysbootfile.%s=%s\n", k, val[k], k, src[k] }
  '
}

unit_active() { timeout 10 systemctl is-active "$1" 2>/dev/null | head -1; }
unit_enabled() { local o; o=$(timeout 10 systemctl is-enabled "$1" 2>/dev/null | head -1); printf '%s' "${o:-not-found}"; }
pkg_state() { [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null | tr -d ' ')" = ii ] && echo installed || echo absent; }
file_meta() { if [ -e "$1" ] || [ -L "$1" ]; then stat -c '%a %U:%G' "$1"; else echo absent; fi; }
sshd_value() { timeout 10 sshd -T 2>/dev/null | awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }'; }
setting_state() {
  local prom=$1 id=$2 v ts newest=0 m f
  shift 2
  v=$(awk -v key="agent_host_setting_ok{setting=\"$id\"} " 'index($0, key) == 1 { print $2; exit }' "$prom" 2>/dev/null)
  if [ -z "$v" ]; then
    echo absent
    return
  fi
  ts=$(awk '$1 == "agent_host_settings_run_timestamp_seconds" { printf "%d", $2 }' "$prom" 2>/dev/null)
  for f in "$@"; do
    m=$(stat -c %Y "$f" 2>/dev/null) || continue
    [ "$m" -gt "$newest" ] && newest=$m
  done
  if [ "$v" != 1 ] && [ "${ts:-0}" -lt "$newest" ]; then echo inconclusive; else echo "$v"; fi
}
export -f unit_active unit_enabled pkg_state file_meta sshd_value setting_state

hashfiles() { find "$@" -type f -exec sha256sum {} + 2>/dev/null | sort -k2; }
fp_cfg() {
  hashfiles "$FPROOT/etc/ssh/sshd_config" "$FPROOT/etc/ssh/sshd_config.d" "$FPROOT/etc/sysctl.d" "$FPROOT/etc/modules-load.d" "$FPROOT/etc/security/limits.d" "$FPROOT/etc/systemd" "$FPROOT/etc/default/earlyoom" "$FPROOT/etc/needrestart" "$FPROOT/etc/apt/apt.conf.d" "$FPROOT/etc/tmpfiles.d" "$FPROOT/etc/fstab" "$FPROOT/etc/ufw" "$FPROOT/etc/fail2ban"
  find "$FPROOT/etc/systemd/system" -type l -printf '%p -> %l\n' 2>/dev/null | sort
}
fp_live() {
  while read -r k; do [ -n "$k" ] && printf '%s=%s\n' "$k" "$(t sysctl -n "$k")"; done < <(csv "$SYSCTLS")
  awk 'NR > 1 { print $1, $2, $3, $5 }' /proc/swaps
  cat /sys/module/zswap/parameters/enabled 2>/dev/null
  t tc qdisc show dev "$IFACE" | awk '{ print $1, $2, $3, $4 }'
}
fp_role() {
  hashfiles "$FPROOT/usr/local/sbin" -name 'agent-host-*'
  hashfiles "$FPROOT/usr/local/lib/agent-host" "$FPROOT/etc/apt/sources.list.d" "$FPROOT/etc/apt/keyrings"
  sha256sum "$FPROOT/etc/default/locale" "$FPROOT/etc/locale.gen" 2>/dev/null
  stat -c '%n %a %U:%G %s' "$FPROOT/swapfile" 2>/dev/null
}
fp_gauge() { sha256sum "$FPROOT/var/lib/node_exporter/textfile/agent_host_reboot.prom" 2>/dev/null | cut -d' ' -f1; }
fp_dpkg() {
  sha256sum "$FPROOT/var/lib/dpkg/status" 2>/dev/null
  dpkg-query ${FPROOT:+--admindir="$FPROOT/var/lib/dpkg"} -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' 2>/dev/null | sort
}
emit_fingerprint() {
  local all="" part h
  for part in cfg live role gauge dpkg; do
    h=$("fp_$part" | sha256sum | cut -c1-16)
    emit "fp.$part" "$h"
    all+=$h
  done
  emit fingerprint "$(printf '%s' "$all" | sha256sum | cut -c1-16)"
}

if [ "$MODE" = sysboot ]; then
  sysboot_eval
  exit 0
fi
if [ "$MODE" = fp ]; then
  IFACE=$(t ip -o route show default | awk '{print $5; exit}')
  emit_fingerprint
  exit 0
fi

emit collector.epoch "$(date +%s)"
emit nproc "$(nproc)"
IFACE=$(t ip -o route show default | awk '{print $5; exit}')
emit iface "$IFACE"

while read -r k; do
  [ -n "$k" ] && emit "sysctl.$k" "$(t sysctl -n "$k")"
done < <(csv "$SYSCTLS")
t /usr/lib/systemd/systemd-sysctl --cat-config | sysboot_eval

t sshd -T | awk '{ k = $1; $1 = ""; sub(/^ /, ""); if (k in v) v[k] = v[k] "," $0; else v[k] = $0 } END { for (k in v) print "sshd." k "=" v[k] }'
emit sshd_restrict "$(grep -rEh '^[[:space:]]*(Match|AllowUsers|DenyUsers|AllowGroups|DenyGroups)\b' /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null | wc -l)"
emit sshd_dropins "$(find /etc/ssh/sshd_config.d -maxdepth 1 -name '*.conf' -printf '%f\n' 2>/dev/null | sort | paste -sd,)"
SSHD_PID=$(t systemctl show -p MainPID --value ssh.service)
emit sshd_pid "${SSHD_PID:-0}"
NOW=$(date +%s)
ETIMES=$(ps -o etimes= -p "${SSHD_PID:-0}" 2>/dev/null | tr -d ' ')
START=$((NOW - ${ETIMES:-$NOW}))
SIGHUP=$(t journalctl -u ssh -g 'Received SIGHUP' -o short-unix --no-pager | tail -1 | cut -d. -f1)
MTIME=$(find /etc/ssh/sshd_config /etc/ssh/sshd_config.d -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
JOLD=$(t journalctl -u ssh -o short-unix --no-pager | head -1 | cut -d. -f1)
for v in SIGHUP MTIME JOLD; do [[ ${!v:-} =~ ^[0-9]+$ ]] || printf -v "$v" 0; done
LAST=$START; [ "$SIGHUP" -gt "$LAST" ] && LAST=$SIGHUP
if [ "$LAST" -ge "$MTIME" ]; then
  emit sshd_daemon_current ok
elif [ "$JOLD" -gt "$MTIME" ]; then
  emit sshd_daemon_current inconclusive
else
  emit sshd_daemon_current stale
fi
emit sshd_listen_count "$(t ss -H -ltn '( sport = :22 )' | wc -l)"

for u in ssh.socket ssh.service node_exporter alloy unattended-upgrades; do
  emit "unit.$u.active" "$(unit_active "$u")"
  emit "unit.$u.enabled" "$(unit_enabled "$u")"
done

HOME_D=$(getent passwd "$USER_NAME" | cut -d: -f6)
OK=1
for p in "$HOME_D" "$HOME_D/.ssh" "$HOME_D/.ssh/authorized_keys"; do
  if read -r mode own < <(stat -c '%a %U' "$p" 2>/dev/null); then
    [ "$own" = "$USER_NAME" ] || OK=0
    [ $((8#$mode & 8#022)) -eq 0 ] || OK=0
  else
    OK=0
  fi
done
emit ssh_perm_ok "$OK"
emit authkeys_fp "$(ssh-keygen -lf "$HOME_D/.ssh/authorized_keys" 2>/dev/null | awk '{print $2}' | sort | sha256sum | cut -c1-16)"
emit pam_fp "$(sha256sum /etc/pam.d/sshd /etc/pam.d/common-* /usr/lib/pam.d/systemd-user 2>/dev/null | sha256sum | cut -c1-16)"
t visudo -c >/dev/null; emit visudo_rc $?
emit dpkg_audit "$(t dpkg --audit | wc -l)"
MISS=0
for v in /boot/vmlinuz-*; do
  [ -e "$v" ] || continue
  [ -e "/boot/initrd.img-${v#/boot/vmlinuz-}" ] || MISS=$((MISS + 1))
done
emit initrd_missing "$MISS"
t findmnt --verify >/dev/null; emit findmnt_verify_rc $?
emit infra_listeners "$(t ss -H -ltn '( sport = :9100 or sport = :12345 )' | wc -l)"
emit infra_nonloopback "$(t ss -H -ltn '( sport = :9100 or sport = :12345 )' | awk '$4 !~ /^127\.0\.0\.1:/' | wc -l)"

emit kernel_running "$(uname -r)"
emit kernel_newest "$(ls /lib/modules | sort -V | tail -1)"
emit kernel_running_is_newest "$([ "$(uname -r)" = "$(ls /lib/modules | sort -V | tail -1)" ] && echo 1 || echo 0)"
emit reboot_required "$([ -e /var/run/reboot-required ] && echo 1 || echo 0)"

emit qdisc_root "$(t tc qdisc show dev "$IFACE" root | awk 'NR==1{print $2}')"
emit qdisc_fq_count "$(t tc qdisc show dev "$IFACE" | grep -c '^qdisc fq ')"
emit swap_total_kb "$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)"
emit swap_devices "$(awk 'NR>1' /proc/swaps | wc -l)"
for p in enabled compressor zpool max_pool_percent; do
  emit "zswap.$p" "$(cat "/sys/module/zswap/parameters/$p" 2>/dev/null)"
done
for r in cpu memory io; do
  emit "psi.$r.some_avg10" "$(awk '/^some/{sub("avg10=","",$2); print $2}' "/proc/pressure/$r" 2>/dev/null)"
  emit "psi.$r.some_total" "$(awk '/^some/{sub("total=","",$5); print $5}' "/proc/pressure/$r" 2>/dev/null)"
done
emit loadavg "$(cut -d' ' -f1-3 /proc/loadavg)"

emit_fingerprint

if [ "${#CONT_RE[@]}" -gt 0 ]; then
  i=0
  for re in "${CONT_RE[@]}"; do
    i=$((i + 1))
    while read -r pid; do
      emit "strict.$i.$pid" "$(starttime "$pid")"
    done < <(ps -eo pid=,args= | RE="$re" awk '$0 ~ ENVIRON["RE"] { print $1 }' | sort -n)
  done
  emit "strict.sshd.${SSHD_PID:-0}" "$(starttime "${SSHD_PID:-0}")"
  for u in user@0.service user@1000.service; do
    t systemctl show "$u" -p InvocationID -p NRestarts -p ActiveEnterTimestampMonotonic | sed "s/^/um.$u./"
  done
  while read -r pid; do
    emit "claude.$pid" "$(starttime "$pid")"
  done < <(ps -eo pid=,comm= | awk '$2 == "claude" { print $1 }' | sort -n)
  OWN=$$
  while [ "${OWN:-0}" -gt 1 ] && [ "$(cat "/proc/$OWN/comm" 2>/dev/null)" != sshd ]; do OWN=$(sed 's/^.*) //' "/proc/$OWN/stat" 2>/dev/null | awk '{print $2}'); done
  while read -r pid; do
    [ "$pid" = "$OWN" ] || emit "info.tmux.$pid" "$(starttime "$pid")"
  done < <(ps -eo pid=,args= | awk '$2 == "tmux:" && $3 == "server" { print $1 }' | sort -n)
  while read -r pid; do
    [ "$pid" = "$OWN" ] || emit "info.sshdsess.$pid" "$(starttime "$pid")"
  done < <(ps -eo pid=,args= | awk '$2 == "sshd:" && $3 ~ /@/ { print $1 }' | sort -n)
  emit sessions "$(t loginctl list-sessions --no-legend | awk '{print $1}' | sort | paste -sd,)"
  emit oom_kill "$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)"
  emit um1000_oom_kill "$(awk '$1 == "oom_kill" { print $2 }' /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/memory.events 2>/dev/null)"
  emit um1000_oom_group_kill "$(awk '$1 == "oom_group_kill" { print $2 }' /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/memory.events 2>/dev/null)"
fi
if [ -n "$KILL_SINCE" ]; then
  emit kernel_kill_lines "$(t journalctl -k --since "@$KILL_SINCE" -g 'Out of memory|Killed process|oom-kill:' --no-pager | grep -cE 'Out of memory|Killed process|oom-kill:')"
fi

if [ -n "$ROWS_B64" ]; then
  while IFS=$'\t' read -r id cmd; do
    [ -z "$id" ] && continue
    out=$(timeout 10 bash -c "$cmd" 2>&1 < /dev/null)
    rc=$?
    emit "row.$id" "${out:0:600}"
    emit "row.$id.rc" "$rc"
  done < <({ printf '%s' "$ROWS_B64" | base64 -d; echo; })
fi

emit collector.done 1
