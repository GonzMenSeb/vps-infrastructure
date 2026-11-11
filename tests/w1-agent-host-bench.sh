#!/bin/bash
# shellcheck disable=SC2016,SC2029,SC2046,SC2129
set -uo pipefail
export LC_ALL=C

HERE=$(cd "$(dirname "$0")" && pwd)
STATS=(python3 -I "$HERE/files/w1-agent-host-bench-stats.py")
COLLECT=$HERE/files/w1-agent-host-collect.sh
OUT=${W1_OUT:-bench-out}
N=${N:-15}
MAX_LOGINS=${W1_MAX_LOGINS:-150}
MAX_SECONDS=${W1_MAX_SECONDS:-900}
SYSCTLS=${W1_SYSCTLS:-net.ipv4.tcp_congestion_control,net.core.default_qdisc,net.ipv4.tcp_slow_start_after_idle,net.ipv4.tcp_mtu_probing,vm.swappiness,vm.page-cluster,fs.inotify.max_user_instances,fs.inotify.max_user_watches}
CONT_RE=('/herdr-core (serve|hold)( |$)' '/herdr server( |$)' '/moshi-hook serve( |$)' '/node_exporter( |$)' '/alloy run( |$)')
LOGINS=0
LAST_US=0
CONSEC=0
LOGIN_REF=0
RUN_START=0
M4_REMOTE='timeout 900 bash -c '"'"'while read -r n; do if [ "$n" = S ]; then set -- $SSH_CONNECTION; ss -tinH state established "( sport = :$4 and dport = :$2 )" | awk "NR==2"; echo @@; else head -c "$n" /dev/zero | tr "\0" x; echo; fi; done'"'"''

die() { echo "bench: $*" >&2; exit 3; }
need_target() { [ -n "${W1_TARGET:-}" ] || die "W1_TARGET is unset (user@host)"; case $W1_TARGET in *@*) ;; *) die "W1_TARGET must be user@host" ;; esac; }
host_part() { printf '%s' "${W1_TARGET#*@}"; }
user_part() { printf '%s' "${W1_TARGET%@*}"; }
now_us() { local t=$EPOCHREALTIME; t=${t/[.,]/}; printf '%s' "$((10#$t))"; }
sec() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.4f", (b - a) / 1000000 }'; }
ms() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", (b - a) / 1000 }'; }

ssh_opts() {
  SSH_OPTS=(-o BatchMode=yes -o ControlMaster=no -o ControlPath=none -o Compression=no -o ConnectTimeout=10 -o NumberOfPasswordPrompts=0 -o LogLevel=ERROR -4)
  [ -n "${W1_IDENTITY:-}" ] && SSH_OPTS+=(-o IdentitiesOnly=yes -i "$W1_IDENTITY")
}

pace() {
  local n gap
  n=$(now_us)
  gap=$((n - LAST_US))
  [ "$gap" -lt 1000000 ] && sleep "$(awk -v g="$gap" 'BEGIN { printf "%.3f", (1000000 - g) / 1000000 }')"
  LAST_US=$(now_us)
}

account() {
  LOGINS=$((LOGINS + 1))
  [ "$LOGINS" -le "$MAX_LOGINS" ] || die "login budget of $MAX_LOGINS exceeded"
  [ "$RUN_START" -gt 0 ] && [ $(($(now_us) - RUN_START)) -gt $((MAX_SECONDS * 1000000)) ] && die "W1_MAX_SECONDS of $MAX_SECONDS exceeded, aborting the run"
  pace
}

rssh() {
  local err rc
  account
  err=$(mktemp)
  ssh "${SSH_OPTS[@]}" "$W1_TARGET" "$@" 2>"$err"
  rc=$?
  if [ "$rc" -eq 255 ]; then
    CONSEC=$((CONSEC + 1))
    grep -qE 'Permission denied|Too many authentication failures' "$err" && { rm -f "$err"; die "authentication failed, stopping to avoid a fail2ban ban"; }
    [ "$CONSEC" -ge 3 ] && { rm -f "$err"; die "3 consecutive ssh failures"; }
  else
    CONSEC=0
  fi
  rm -f "$err"
  return "$rc"
}

rcmd() { rssh "timeout 90 nice -n 19 bash -c $(printf '%q' "$1")"; }

cmd_snapshot() {
  local label=${1:?label} args=() re
  need_target; ssh_opts
  mkdir -p "$OUT"; chmod 700 "$OUT"
  args=(--user "$(user_part)" --sysctl "$SYSCTLS")
  for re in "${CONT_RE[@]}"; do args+=(--continuity-re "$re"); done
  [ -n "${W1_KILL_SINCE:-}" ] && args+=(--kill-since "$W1_KILL_SINCE")
  rssh "sudo -n bash -s -- $(printf '%q ' "${args[@]}")" < "$COLLECT" | "${STATS[@]}" kv-json "$label" > "$OUT/$label.json" || die "snapshot failed"
  grep -q '"collector.done": "1"' "$OUT/$label.json" || { rm -f "$OUT/$label.json"; die "snapshot incomplete: the collector did not reach collector.done"; }
  echo "snapshot written: $OUT/$label.json"
}

cmd_snap_compare() {
  "${STATS[@]}" snap-compare "$OUT/${1:?before}.json" "$OUT/${2:?after}.json" ${3:+"$3"}
}

guard_mem() {
  local m
  m=$(rcmd 'awk "/^some/{sub(\"avg10=\",\"\",\$2); print \$2}" /proc/pressure/memory') || die "cannot read memory pressure"
  awk -v m="$m" 'BEGIN { exit !(m + 0 > 5) }' && die "memory pressure avg10 is $m (above 5), not running"
  return 0
}

ctx_remote() {
  rcmd "$(cat <<'REMOTE'
for k in net.ipv4.tcp_congestion_control net.core.default_qdisc net.ipv4.tcp_slow_start_after_idle net.ipv4.tcp_mtu_probing; do echo "sysctl.$k=$(sysctl -n $k)"; done
echo "kernel=$(uname -r)"
echo "loadavg=$(cut -d" " -f1-3 /proc/loadavg)"
awk '/^some/{a=$2; t=$5; sub("avg10=","",a); sub("total=","",t); print "psi_cpu_avg10=" a; print "psi_cpu_total=" t}' /proc/pressure/cpu
echo "nofile_soft=$(ulimit -Sn)"
echo "nofile_hard=$(ulimit -Hn)"
set -- $SSH_CONNECTION
echo "tcp_metrics_peer=$(ip tcp_metrics show "$1" 2>/dev/null | head -1 | awk '{ for (i = 2; i < NF; i++) if ($i ~ /^(ssthresh|cwnd|rtt|rttvar)$/) printf "%s=%s ", $i, $(i + 1) }')"
REMOTE
)"
}

m1_ping() {
  local json
  json=$(ping -c 100 -i 0.2 "${W1_PING_HOST:-$(host_part)}" 2>/dev/null | "${STATS[@]}" parse-ping)
  echo "m1_rtt_ms: $(printf '%s' "$json" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(str(x) for x in d.get("samples", [])))')" >> "$MET"
  echo "m1_loss_pct=$(printf '%s' "$json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("loss_pct", ""))')" >> "$CTX"
}

m6_login() {
  local i t0 t1 tot=() tcp=() inter=()
  for ((i = 0; i < N; i++)); do
    t0=$(now_us); timeout 5 bash -c "exec 3<>/dev/tcp/$(host_part)/22" 2>/dev/null; t1=$(now_us); tcp+=("$(sec "$t0" "$t1")")
    t0=$(now_us); rssh true; t1=$(now_us); tot+=("$(sec "$t0" "$t1")")
  done
  for ((i = 0; i < 5; i++)); do
    account
    t0=$(now_us); printf 'exit\n' | timeout 30 ssh -tt "${SSH_OPTS[@]}" "$W1_TARGET" >/dev/null 2>&1; t1=$(now_us); inter+=("$(sec "$t0" "$t1")")
  done
  echo "m6_total_s: ${tot[*]}" >> "$MET"
  echo "m6_tcp_s: ${tcp[*]}" >> "$MET"
  echo "m6_login_s: ${inter[*]}" >> "$MET"
  LOGIN_REF=$(printf '%s\n' "${tot[@]}" | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}')
}

project() {
  [ "$RUN_START" -gt 0 ] || return 0
  local proj
  proj=$(awk -v e="$(sec "$RUN_START" "$2")" -v p="$(sec "$1" "$2")" -v n="$N" 'BEGIN { printf "%.0f", e + p * (n - 1) + n * 14 + 30 }')
  echo "projected total about ${proj}s (estimate, limit ${MAX_SECONDS}s)" >&2
  [ "$proj" -le "$MAX_SECONDS" ] || echo "warning: the projection exceeds W1_MAX_SECONDS, the run will abort at the limit" >&2
}

m3_bulk() {
  local i t0 t1 f down=() up=() off p0
  f=$(mktemp)
  for ((i = 0; i < N; i++)); do
    p0=$(now_us)
    t0=$p0
    rssh 'timeout 120 nice -n 19 head -c 16777216 /dev/zero; echo @@MARK@@; set -- $SSH_CONNECTION; ss -tinH state established "( sport = :$4 and dport = :$2 )" | awk "NR==2"' > "$f"
    t1=$(now_us)
    down+=("$(awk -v t="$(sec "$t0" "$t1")" -v l="${LOGIN_REF:-0}" 'BEGIN { printf "%.4f", t - l }')")
    off=$(LC_ALL=C grep -abo '@@MARK@@' "$f" | head -1 | cut -d: -f1)
    [ "$i" -eq $((N - 1)) ] && [ -n "$off" ] && tail -c +$((off + 10)) "$f" | "${STATS[@]}" parse-ss > "$OUT/.ss_after_bulk.json"
    t0=$(now_us)
    rssh 'timeout 120 cat >/dev/null' < <(head -c 16777216 /dev/zero)
    t1=$(now_us)
    up+=("$(awk -v t="$(sec "$t0" "$t1")" -v l="${LOGIN_REF:-0}" 'BEGIN { printf "%.4f", t - l }')")
    [ "$i" -eq 0 ] && project "$p0" "$t1"
  done
  rm -f "$f"
  echo "m3_down_s: ${down[*]}" >> "$MET"
  echo "m3_up_s: ${up[*]}" >> "$MET"
}

m4_idle() {
  local idle kib n i t0 tf tl first=() last=() line
  account
  coproc SSHP { ssh "${SSH_OPTS[@]}" "$W1_TARGET" "$M4_REMOTE" 2>/dev/null; }
  for idle in 1 5; do
    for kib in 16 64; do
      first=(); last=()
      for ((i = 0; i < N; i++)); do
        echo 3145728 >&"${SSHP[1]}"; read -r -N 3145729 -u "${SSHP[0]}" _
        echo S >&"${SSHP[1]}"; while read -r -u "${SSHP[0]}" line; do [ "$line" = @@ ] && break; done
        sleep "$idle"
        n=$((kib * 1024))
        t0=$(now_us); echo "$n" >&"${SSHP[1]}"
        read -r -N 1 -u "${SSHP[0]}" _; tf=$(now_us)
        read -r -N "$n" -u "${SSHP[0]}" _; tl=$(now_us)
        first+=("$(ms "$t0" "$tf")"); last+=("$(ms "$t0" "$tl")")
      done
      echo "m4_first_ms@${idle}s${kib}k: ${first[*]}" >> "$MET"
      echo "m4_last_ms@${idle}s${kib}k: ${last[*]}" >> "$MET"
    done
  done
  kill "$SSHP_PID" 2>/dev/null || true
}

m4_fresh() {
  local idle=$1 kib=$2 n t0 tf tl line
  M4_SS=
  account
  coproc SSHP { ssh "${SSH_OPTS[@]}" "$W1_TARGET" "$M4_REMOTE" 2>/dev/null; }
  echo 3145728 >&"${SSHP[1]}"; read -r -N 3145729 -u "${SSHP[0]}" _
  echo S >&"${SSHP[1]}"; while read -r -u "${SSHP[0]}" line; do [ "$line" = @@ ] && break; M4_SS+=$line; done
  sleep "$idle"
  n=$((kib * 1024))
  t0=$(now_us); echo "$n" >&"${SSHP[1]}"
  read -r -N 1 -u "${SSHP[0]}" _; tf=$(now_us)
  read -r -N "$n" -u "${SSHP[0]}" _; tl=$(now_us)
  kill "$SSHP_PID" 2>/dev/null || true
  wait "$SSHP_PID" 2>/dev/null || true
  M4_FIRST=$(ms "$t0" "$tf"); M4_LAST=$(ms "$t0" "$tl")
}

m5_echo() {
  local tag=$1 i t0 t1 s=() bg=0
  if [ "$tag" = m5b_echo_ms ]; then
    account
    ssh "${SSH_OPTS[@]}" "$W1_TARGET" 'timeout 120 head -c 268435456 /dev/zero' > /dev/null 2>&1 &
    bg=$!
    sleep 2
  fi
  account
  coproc ECHOP { timeout 120 ssh -tt "${SSH_OPTS[@]}" "$W1_TARGET" cat 2>/dev/null; }
  sleep 1
  for ((i = 0; i < 50; i++)); do
    t0=$(now_us); printf 'a' >&"${ECHOP[1]}"
    read -r -N 1 -t 5 -u "${ECHOP[0]}" _ || continue
    t1=$(now_us); s+=("$(ms "$t0" "$t1")")
    sleep 0.2
  done
  kill "$ECHOP_PID" 2>/dev/null || true
  [ "$bg" != 0 ] && kill "$bg" 2>/dev/null
  echo "$tag: ${s[*]}" >> "$MET"
}

cleanup_run() {
  local rc=$? j
  for j in $(jobs -p); do kill "$j" 2>/dev/null; done
  rm -f "${MET:-}" "${CTX:-}" "$OUT/.ss_after_bulk.json"
  [ "$rc" -eq 0 ] || rm -f "$OUT/${RUN_LABEL:-.none}.run.json"
}

cmd_run() {
  local label=${1:?label} skip_bulk=0 do_mem=0 do_udp=0 yes=0 w0 w1 c0 c1 ans
  shift
  for a in "$@"; do case $a in --skip-bulk) skip_bulk=1 ;; --mem) do_mem=1 ;; --udp-probe) do_udp=1 ;; --yes) yes=1 ;; *) die "unknown flag $a" ;; esac; done
  need_target; ssh_opts
  if [ "$yes" -eq 0 ]; then
    printf 'run sends about 0.8 GB and about 59 logins to %s and takes about 8 minutes at N=15. Do not run it during an active phone session. Continue? [y/N] ' "$W1_TARGET" >&2
    read -r ans || ans=n
    case $ans in y | Y) ;; *) die "not confirmed (pass --yes to skip the question)" ;; esac
  fi
  mkdir -p "$OUT"; chmod 700 "$OUT"
  MET=$(mktemp); CTX=$(mktemp); RUN_LABEL=$label
  trap cleanup_run EXIT
  RUN_START=$(now_us)
  ctx_remote > "$CTX" || die "cannot reach the target"
  guard_mem
  c0=$(awk -F= '/^psi_cpu_total=/{print $2}' "$CTX"); w0=$(now_us)
  m1_ping
  m6_login
  if [ "$skip_bulk" -eq 0 ]; then guard_mem; m3_bulk; guard_mem; m4_idle; m5_echo m5_echo_ms; m5_echo m5b_echo_ms; fi
  END_CTX=$(ctx_remote); w1=$(now_us)
  c1=$(printf '%s\n' "$END_CTX" | awk -F= '/^psi_cpu_total=/{print $2}')
  printf 'psi_cpu_total_start=%s\npsi_cpu_total_end=%s\npsi_cpu_avg10_end=%s\nwall_us=%s\nlogins=%s\n' "$c0" "$c1" "$(printf '%s\n' "$END_CTX" | awk -F= '/^psi_cpu_avg10=/{print $2}')" "$((w1 - w0))" "$LOGINS" >> "$CTX"
  [ -f "$OUT/.ss_after_bulk.json" ] && python3 -I -c 'import json,sys; [print("ss_"+k+"="+str(v)) for k,v in json.load(open(sys.argv[1])).items()]' "$OUT/.ss_after_bulk.json" >> "$CTX"
  "${STATS[@]}" assemble "$label" "$CTX" "$MET" > "$OUT/$label.run.json" || die "assemble failed"
  trap - EXIT
  rm -f "$MET" "$CTX" "$OUT/.ss_after_bulk.json"
  echo "run written: $OUT/$label.run.json (logins: $LOGINS)"
  [ "$do_mem" -eq 1 ] && cmd_mem
  [ "$do_udp" -eq 1 ] && cmd_udp
  return 0
}

cmd_compare() {
  local out show=--show-metrics pub=0
  [ "${3:-}" = --public ] && { show=; pub=1; }
  [ "$pub" -eq 1 ] && need_target
  out=$("${STATS[@]}" compare "$OUT/${1:?before}.run.json" "$OUT/${2:?after}.run.json" ${show:+"$show"}; [ -f "$OUT/$1.json" ] && [ -f "$OUT/$2.json" ] && "${STATS[@]}" snap-compare "$OUT/$1.json" "$OUT/$2.json"
    echo "LIMITS: no improvement is claimed for phone behaviour, subjective feel, BBR on a window-limited ssh path, earlyoom victim choice, or reboot persistence; only the pre-registered primary row (m4_last_ms@5s64k) marked attributable may be cited as an improvement, every other cell is descriptive; ssai=0 acts only on non-BBR sockets; compare across different times is bounded by the control rows above.")
  if [ "$pub" -eq 1 ]; then
    printf '%s\n' "$out" | W1_SCRUB_DENY="$(host_part),${W1_PING_HOST:-}" "${STATS[@]}" scrub || die "scrub failed, not printing a public block"
  fi
  printf '%s\n' "$out"
}

cmd_ab() {
  [ "${1:-}" = --yes ] || die "ab-toggle changes live sysctls; pass --yes after the check playbook is green"
  shift
  local rounds=5
  while [ $# -gt 0 ]; do case $1 in --rounds) rounds=${2:-}; shift 2 ;; *) die "unknown flag $1" ;; esac; done
  case $rounds in '' | *[!0-9]* | 0) die "--rounds needs a positive integer" ;; esac
  need_target; ssh_opts
  local snap_cc snap_ssai r arm cc ssai f doc t0 t1 tmp ab0
  mkdir -p "$OUT"
  [ "$(rcmd 'systemctl is-active agent-host-ab-restore.timer; ps -eo args= | grep -c "[a]nsible-tmp"' | tr '\n' ' ')" = "inactive 0 " ] || die "another A/B run or an ansible apply is active"
  snap_cc=$(rcmd 'sysctl -n net.ipv4.tcp_congestion_control'); snap_ssai=$(rcmd 'sysctl -n net.ipv4.tcp_slow_start_after_idle')
  rcmd "sudo -n systemctl reset-failed agent-host-ab-restore.service agent-host-ab-restore.timer 2>/dev/null; sudo -n systemd-run --unit=agent-host-ab-restore --on-active=900 --collect /usr/sbin/sysctl -w net.ipv4.tcp_congestion_control=$snap_cc net.ipv4.tcp_slow_start_after_idle=$snap_ssai" || die "cannot arm the dead-man restore"
  tmp=$(mktemp); ab0=$(now_us)
  for ((r = 0; r < rounds; r++)); do
    for arm in cubic/1 cubic/0 bbr/1 bbr/0; do
      [ $(($(now_us) - ab0)) -lt 780000000 ] || { echo "ab-toggle: stopping early, the 900 s dead-man restore is close; the arms so far are kept" >&2; break 2; }
      cc=${arm%/*}; ssai=${arm#*/}
      rcmd "sudo -n sysctl -w net.ipv4.tcp_congestion_control=$cc net.ipv4.tcp_slow_start_after_idle=$ssai >/dev/null" || break 2
      f=$(mktemp)
      t0=$(now_us)
      rssh 'timeout 120 nice -n 19 head -c 16777216 /dev/zero; echo @@MARK@@; set -- $SSH_CONNECTION; ss -tinH state established "( sport = :$4 and dport = :$2 )" | awk "NR==2"' > "$f"
      t1=$(now_us)
      LC_ALL=C grep -aq "$cc" "$f" || echo "arm $arm: socket did not report $cc" >&2
      echo "$arm m3_down_s $(sec "$t0" "$t1")" >> "$tmp"
      rm -f "$f"
      m4_fresh 5 64
      case $M4_SS in '' | *"$cc"*) ;; *) echo "arm $arm: the m4 socket did not report $cc" >&2 ;; esac
      echo "$arm m4_first_ms@5s64k $M4_FIRST" >> "$tmp"
      echo "$arm m4_last_ms@5s64k $M4_LAST" >> "$tmp"
    done
  done
  rcmd "sudo -n sysctl -w net.ipv4.tcp_congestion_control=$snap_cc net.ipv4.tcp_slow_start_after_idle=$snap_ssai >/dev/null; sudo -n systemctl stop agent-host-ab-restore.timer"
  [ "$(rcmd 'sysctl -n net.ipv4.tcp_congestion_control net.ipv4.tcp_slow_start_after_idle' | tr '\n' ' ')" = "$snap_cc $snap_ssai " ] || die "restore not verified, check the host now"
  doc=$(python3 -I - "$tmp" <<'PY'
import json, sys
arms = {}
for line in open(sys.argv[1]):
    arm, metric, val = line.split()
    arms.setdefault(arm, {}).setdefault(metric, []).append(float(val))
print(json.dumps({"arms": arms}))
PY
)
  printf '%s\n' "$doc" > "$OUT/ab.json"; rm -f "$tmp"
  "${STATS[@]}" ab-compare "$OUT/ab.json"
}

cmd_mem() {
  need_target; ssh_opts
  local out
  out=$(rcmd 'set -u; v0=$(awk "/^(oom_kill|pswpin|pswpout|zswpin|zswpout|zswpwb) /{printf \"%s=%s \", \$1, \$2}" /proc/vmstat); avail=$(awk "/^MemAvailable:/{print \$2}" /proc/meminfo); [ "$avail" -gt 4194304 ] || { echo ABORT_LOW_MEM; exit 0; }; for kind in random text; do
  systemd-run --user --scope --quiet --collect -p MemoryMax=256M -p MemorySwapMax=infinity --unit=agent-host-mem-exp-$kind nice -n 19 timeout 90 python3 -I -c "
import os, sys
kind = sys.argv[1]
chunks = []
for i in range(640):
    chunks.append(bytearray(os.urandom(1 << 20)) if kind == \"random\" else bytearray((b\"the quick brown fox %d \" % i) * 50000)[: 1 << 20])
cg = \"/sys/fs/cgroup\" + open(\"/proc/self/cgroup\").read().strip().split(\":\")[-1]
rd = lambda f: open(cg + \"/\" + f).read().strip() if os.path.exists(cg + \"/\" + f) else \"na\"
st = dict(l.split() for l in rd(\"memory.stat\").splitlines() if l.startswith((\"zswap \", \"zswapped \")))
print(\"SURVIVED\", kind, \"swap=\" + rd(\"memory.swap.current\"), \"zswap=\" + rd(\"memory.zswap.current\"), \"stat_zswap=\" + st.get(\"zswap\", \"na\"), \"stat_zswapped=\" + st.get(\"zswapped\", \"na\"))
" $kind & pid=$!; while kill -0 $pid 2>/dev/null; do awk "/^some/{sub(\"avg10=\",\"\",\$2); if (\$2 > 25) exit 1}" /proc/pressure/io || { systemctl --user stop agent-host-mem-exp-$kind.scope; echo ABORT_IO; }; sleep 1; done; wait $pid; echo "rc_$kind=$?"; done; v1=$(awk "/^(oom_kill|pswpin|pswpout|zswpin|zswpout|zswpwb) /{printf \"%s=%s \", \$1, \$2}" /proc/vmstat); echo "before: $v0"; echo "after: $v1"') || die "mem experiment failed to run"
  printf '%s\n' "$out"
}

cmd_udp() {
  need_target; ssh_opts
  local port=${W1_UDP_PORT:-60990} ok
  rcmd "timeout 12 python3 -I -c 'import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((\"0.0.0.0\", $port)); s.settimeout(10)
for _ in range(3):
    d, a = s.recvfrom(64); s.sendto(d, a)'" &
  sleep 3
  ok=$(python3 -I -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
n = 0
for i in range(3):
    s.sendto(b'p%d' % i, (sys.argv[1], int(sys.argv[2])))
    try:
        s.recvfrom(64); n += 1
    except OSError:
        pass
print(n)" "$(host_part)" "$port")
  wait
  echo "udp probe on port $port: $ok of 3 echoed"
  [ "$ok" -ge 1 ]
}

cmd_selftest() {
  local ssline='	 cubic wscale:12,7 rto:390 rtt:189.83/11.876 mss:1448 pmtu:1500 cwnd:10 ssthresh:15 bytes_sent:9776803 bytes_retrans:31764 pacing_rate 732272bps retrans:0/109 dsack_dups:94 minrtt:177.408'
  [ "$(printf '%s\n' "$ssline" | "${STATS[@]}" parse-ss | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["cc"], d["cwnd"], d["dsack_dups"], d["retrans_total"])')" = "cubic 10.0 94.0 109" ] || die "parse-ss"
  [ "$(printf '64 bytes from X: icmp_seq=1 ttl=51 time=183 ms\n64 bytes from X: icmp_seq=2 ttl=51 time=181 ms\n2 packets transmitted, 2 received, 0%% packet loss\n' | "${STATS[@]}" parse-ping | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["p50"], d["loss_pct"])')" = "182.0 0.0" ] || die "parse-ping"
  printf 'peer 203.0.113.9 host vmi123\n' | "${STATS[@]}" scrub 2>/dev/null && die "scrub accepted an address"
  printf 'loopback 127.0.0.1 and ::1 and 18:55:56\n' | "${STATS[@]}" scrub || die "scrub rejected loopback"
  [ -z "${W1_TARGET:-}" ] && { W1_TARGET= ; ( need_target ) 2>/dev/null && die "need_target accepted an empty target"; }
  echo "bench self-test: ok"
}

usage() {
  cat <<'USAGE'
usage: W1_TARGET=user@host tests/w1-agent-host-bench.sh COMMAND

  snapshot LABEL                   one login: the collector writes bench-out/LABEL.json
  snapshot-compare B A [--dry]     strict set (infra process pids and start times, user managers, oom counters, kernel kill lines)
                                   prints INFRA PROCESSES UNTOUCHED or CONTINUITY BROKEN; the tmux server pid and the sshd session
                                   pids are information keys (a warning when they vanish, never a failure); ended claude processes are counted
                                   --dry compares only the fingerprint of the role-written paths (config trees, agent-host scripts and
                                   libs, apt sources and keyrings, locale files, the gauge file by content, the swap file, the dpkg
                                   status and package list): DRY RUN CHANGED NO FINGERPRINTED PATH or DRY RUN CHANGED THE HOST
  run LABEL [--skip-bulk] [--mem] [--udp-probe] [--yes]
                                   passive run, asks y/N unless --yes; about 59 logins at N=15 (20 in M6, 30 in M3, 3 memory guards,
                                   2 context reads, 1 M4, 3 M5), about 0.8 GB, about 8 minutes; W1_MAX_SECONDS (default 900) aborts it
  compare B A [--public]           attributable only when the congestion control differs and the before run used cubic;
                                   the pre-registered primary row is m4_last_ms@5s64k, every other cell is descriptive
  ab-toggle --yes [--rounds N]     interleaved cubic/1, cubic/0, bbr/1, bbr/0 arms (default 5 rounds): 16 MiB download and a fresh-connection
                                   after-idle cell per arm; restores the sysctls it read; arms a 900 s dead-man
  mem-drill | udp-probe            opt-in drills
  self-test

environment: W1_TARGET W1_IDENTITY W1_PING_HOST N W1_MAX_LOGINS W1_MAX_SECONDS W1_OUT W1_SYSCTLS W1_KILL_SINCE W1_UDP_PORT W1_SCRUB_DENY
USAGE
}

case ${1:-} in
  snapshot) shift; cmd_snapshot "$@" ;;
  snapshot-compare) shift; cmd_snap_compare "$@" ;;
  run) shift; cmd_run "$@" ;;
  compare) shift; cmd_compare "$@" ;;
  ab-toggle) shift; cmd_ab "$@" ;;
  mem-drill) shift; cmd_mem "$@" ;;
  udp-probe) shift; cmd_udp "$@" ;;
  self-test) cmd_selftest ;;
  help | -h | --help) usage ;;
  *) usage >&2; exit 2 ;;
esac
