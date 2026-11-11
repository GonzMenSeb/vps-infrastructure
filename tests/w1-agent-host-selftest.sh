#!/bin/bash
# shellcheck disable=SC2015,SC2086
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export ANSIBLE_NOCOWS=1 LC_ALL=C.UTF-8
FX=tests/fixtures
TMP=$(mktemp -d)
trap 'rm -rf "${TMP:?}"' EXIT
FAILS=0

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
expect_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

run_check() {
  local fx=$1; shift
  case $fx in /*) ;; *) fx=$PWD/$fx ;; esac
  ansible-playbook -i 'w1,' -c local -e ansible_become=false \
    -e "agent_host_check_fixture=$fx" -e "@$FX/w1-agent-host-expect.yml" -e "agent_host_check_report=$TMP/report.json" \
    -e '{"agent_host_row_domains":["prove","repo","memory"]}' \
    "$@" tests/w1-agent-host-check.yml > "$TMP/out.txt" 2>&1
  echo $?
}
ids() { python3 -I -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))[sys.argv[2]])))' "$TMP/report.json" "$1"; }
mutate() { local name=$1; shift; sed "$@" "$FX/w1-agent-host-after.txt" > "$TMP/$name.txt"; }

expect_eq "sysboot evaluator: last assignment wins, '-' prefix, slash form, spaces" \
  "$(bash tests/files/w1-agent-host-collect.sh --sysboot-stdin < $FX/sysctl-cat-config.txt | sort)" "$(cat $FX/sysctl-cat-config.expected)"

expect_eq "baseline fixture exits non-zero" "$(run_check $FX/w1-agent-host-before.txt)" 2
expect_eq "baseline fixture fails exactly the pinned required set" "$(ids req_fail)" "$(cat $FX/w1-agent-host-before.expected)"
expect_eq "baseline fixture: every access guard passes" "$(grep -E '^ *"(PASS|FAIL) \| required \| G[0-9]+ ' "$TMP/out.txt" | grep -c FAIL)" 0

expect_eq "converged fixture exits zero" "$(run_check $FX/w1-agent-host-after.txt)" 0
expect_eq "converged fixture has no required failure" "$(ids req_fail)" ""
expect_eq "rows judged against a baseline that was not given are named" "$(ids vacuous_no_baseline | tr '\n' ' ')" "G03 G04 "

mutate half -e 's/^sysctl.net.ipv4.tcp_congestion_control=bbr/sysctl.net.ipv4.tcp_congestion_control=cubic/'
expect_eq "disk ahead of runtime exits non-zero" "$(run_check "$TMP/half.txt")" 2
expect_eq "disk ahead of runtime fails only that row" "$(ids req_fail)" "SYS:net.ipv4.tcp_congestion_control:runtime"
grep -q 'HALF-APPLIED SYS:net.ipv4.tcp_congestion_control' "$TMP/out.txt" && pass "half-applied verdict printed" || fail "half-applied verdict printed"

mutate rtonly -e 's/^sysboot.vm.swappiness=100/sysboot.vm.swappiness=60/'
run_check "$TMP/rtonly.txt" > /dev/null
grep -q 'RUNTIME-ONLY SYS:vm.swappiness' "$TMP/out.txt" && pass "runtime-only verdict printed" || fail "runtime-only verdict printed"

mutate stale -e 's/^sshd_daemon_current=ok/sshd_daemon_current=stale/'
expect_eq "stale sshd daemon is advisory" "$(run_check "$TMP/stale.txt")" 0
expect_eq "stale sshd daemon is listed" "$(ids adv_fail)" "R09"
mutate inconc -e 's/^sshd_daemon_current=ok/sshd_daemon_current=inconclusive/'
expect_eq "rotated journal is inconclusive, not failed" "$(run_check "$TMP/inconc.txt")" 0
expect_eq "rotated journal is listed" "$(ids inconclusive)" "R09"

mutate guard -e 's/^visudo_rc=0/visudo_rc=1/'
expect_eq "broken sudoers fails the run" "$(run_check "$TMP/guard.txt")" 2
expect_eq "broken sudoers fails only G01" "$(ids req_fail)" "G01"

expect_eq "authorized_keys unchanged vs before report" "$(run_check $FX/w1-agent-host-after.txt -e agent_host_before_report=$PWD/$FX/w1-agent-host-before-report.json)" 0
expect_eq "no row is judged vacuously when the before report is given" "$(ids vacuous_no_baseline)" ""
mkdir -p bench-out
cp "$FX/w1-agent-host-before-report.json" "bench-out/.selftest-before.json"
expect_eq "relative before-report path resolves from the repo root" "$(run_check $FX/w1-agent-host-after.txt -e agent_host_before_report=bench-out/.selftest-before.json)" 0
rm -f "bench-out/.selftest-before.json"
mutate keys -e 's/^authkeys_fp=aaaaaaaaaaaaaaaa/authkeys_fp=cccccccccccccccc/'
expect_eq "changed authorized_keys fails G03" "$(run_check "$TMP/keys.txt" -e agent_host_before_report=$PWD/$FX/w1-agent-host-before-report.json)" 2
expect_eq "changed authorized_keys fails only G03" "$(ids req_fail)" "G03"

mutate nodone -e '/^collector.done/d'
expect_eq "incomplete evidence is refused" "$(run_check "$TMP/nodone.txt")" 2
grep -q 'collector did not finish' "$TMP/out.txt" && pass "incomplete evidence message" || fail "incomplete evidence message"

mutate timeout -e 's/^row.M08=ok/row.M08=/' -e 's/^row.M08.rc=0/row.M08.rc=124/'
run_check "$TMP/timeout.txt" > /dev/null
expect_eq "a timed-out probe fails its row" "$(ids req_fail)" "M08"
grep -q '<timeout>' "$TMP/out.txt" && pass "timeout shown in the table" || fail "timeout shown in the table"

run_check $FX/w1-agent-host-before.txt -e '{"agent_host_check_domains":["ssh"]}' > /dev/null
expect_eq "domain filter keeps ssh and guard rows only" "$(ids req_fail | grep -cE '^(SYS:|M0)')" 0
expect_eq "domain filter still evaluates ssh rows" "$(ids req_fail | grep -c '^SSHD:')" 4

expect_eq "duplicate row ids are refused" "$(run_check $FX/w1-agent-host-after.txt -e '{"agent_host_check_rows_memory":[{"id":"M01","cmd":"true"},{"id":"M01","cmd":"true"}]}')" 2
grep -q 'duplicate or invalid row id' "$TMP/out.txt" && pass "duplicate id message" || fail "duplicate id message"

expect_eq "an undefined variable inside a row fails the play" "$(run_check $FX/w1-agent-host-after.txt -e '{"agent_host_check_rows_memory":[{"id":"M01","cmd":"true","expect":"{{ agent_host_undefined_probe }}"},{"id":"M02","cmd":"true","expect":"x"}]}')" 2
grep -q 'undefined variable' "$TMP/out.txt" && pass "undefined variable message" || fail "undefined variable message"
expect_eq "a rows variable named for an unknown domain is refused" "$(run_check $FX/w1-agent-host-after.txt -e '{"agent_host_check_rows_bogus":[]}')" 2
grep -q 'missing from agent_host_row_domains_all' "$TMP/out.txt" && pass "unknown rows variable message" || fail "unknown rows variable message"
expect_eq "a requested domain the engine does not know is refused" "$(run_check $FX/w1-agent-host-after.txt -e '{"agent_host_check_domains":["memroy"]}')" 2
grep -q 'outside agent_host_row_domains_all' "$TMP/out.txt" && pass "unknown domain message" || fail "unknown domain message"
expect_eq "a requested domain without rows is refused, not passed vacuously" "$(run_check $FX/w1-agent-host-after.txt -e '{"agent_host_check_domains":["firewall"]}')" 2
grep -q 'has no rows' "$TMP/out.txt" && pass "empty domain message" || fail "empty domain message"

render_all() {
  ansible-playbook -i 'w1,' -c local -e ansible_become=false -e ssh_allowed_users=ubuntu \
    -e "agent_host_check_fixture=$PWD/$FX/w1-agent-host-before.txt" "$@" tests/w1-agent-host-check.yml > "$TMP/render.txt" 2>&1
  grep -q 'TASK \[Verdicts\]' "$TMP/render.txt" && ! grep -qE 'undefined variable|is undefined|Unable to look up' "$TMP/render.txt"
}
if [ -f roles/agent_host/defaults/main/network.yml ]; then
  render_all && pass "render-all: every row of every domain resolves with the real registries" || { fail "render-all: every row of every domain resolves with the real registries"; grep -E 'undefined|Unable to look up' "$TMP/render.txt" | head -5; }
  render_all -e '{"agent_host_firewall_enabled":true,"agent_host_mem_earlyoom_enabled":true,"agent_host_fail2ban_enabled":true,"agent_host_locale_extra":["x"]}' \
    && pass "render-all with every opt-in switched on" || { fail "render-all with every opt-in switched on"; grep -E 'undefined|Unable to look up' "$TMP/render.txt" | head -5; }
else
  echo "SKIP render-all (no role defaults yet)"
fi


make_shim() {
  local b=$1/bin st=$1/state i
  mkdir -p "$b" "$st/pressure"
  printf cubic > "$st/net.ipv4.tcp_congestion_control"; printf 1 > "$st/net.ipv4.tcp_slow_start_after_idle"; printf fq_codel > "$st/net.core.default_qdisc"
  for i in cpu memory io; do printf 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' > "$st/pressure/$i"; done
  cat > "$b/ssh" <<'SHIM'
#!/bin/bash
echo ssh >> "$SHIM_STATE/calls"
if [ -n "${SHIM_FAIL:-}" ]; then echo "Permission denied (publickey)." >&2; exit 255; fi
args=("$@"); i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case ${args[$i]} in
    -o | -i) i=$((i + 2)) ;;
    -*) i=$((i + 1)) ;;
    *) break ;;
  esac
done
i=$((i + 1))
cmd="${args[*]:$i}"
cmd=${cmd//\/proc\/pressure\//$SHIM_STATE/pressure/}
export PATH="$SHIM_BIN:$PATH" SSH_CONNECTION="127.0.0.1 50000 127.0.0.1 22"
if [ -z "$cmd" ]; then cat > /dev/null; exit 0; fi
exec bash -c "$cmd"
SHIM
  cat > "$b/sleep" <<'SHIM'
#!/bin/bash
exec /bin/sleep "$(awk -v s="$1" 'BEGIN { printf "%.4f", s / 50 }')"
SHIM
  cat > "$b/ping" <<'SHIM'
#!/bin/bash
for i in $(seq 1 $((100 - ${SHIM_LOSS:-0}))); do echo "64 bytes from x: icmp_seq=$i ttl=51 time=$((180 + i % 5)).$((i % 10)) ms"; done
echo "100 packets transmitted, $((100 - ${SHIM_LOSS:-0})) received, ${SHIM_LOSS:-0}% packet loss, time 20000ms"
SHIM
  cat > "$b/sudo" <<'SHIM'
#!/bin/bash
[ "$1" = -n ] && shift
exec "$@"
SHIM
  cat > "$b/sysctl" <<'SHIM'
#!/bin/bash
S=$SHIM_STATE
case $1 in
  -n) shift; for k in "$@"; do if [ -f "$S/$k" ]; then cat "$S/$k"; else echo 0; fi; done ;;
  -w) shift; for kv in "$@"; do printf '%s\n' "${kv#*=}" > "$S/${kv%%=*}"; echo "sysctl ${kv%%=*}=${kv#*=}" >> "$S/writes"; done ;;
esac
SHIM
  cat > "$b/systemctl" <<'SHIM'
#!/bin/bash
[ "$1" = is-active ] && echo inactive
exit 0
SHIM
  cat > "$b/systemd-run" <<'SHIM'
#!/bin/bash
echo "systemd-run $*" >> "$SHIM_STATE/writes"
SHIM
  cat > "$b/ss" <<'SHIM'
#!/bin/bash
echo "ESTAB 0 0 local peer"
printf '\t %s wscale:12,7 rto:390 rtt:189.83/11.876 mss:1448 pmtu:1500 cwnd:10 ssthresh:15 bytes_sent:9776803 bytes_retrans:%s pacing_rate 732272bps retrans:0/109 dsack_dups:94 minrtt:177.408\n' "$(cat "$SHIM_STATE/net.ipv4.tcp_congestion_control")" "${SHIM_RETRANS:-31764}"
SHIM
  cat > "$b/ip" <<'SHIM'
#!/bin/bash
echo "192.0.2.1 age 5.1sec ssthresh ${SHIM_SSTHRESH:-15} cwnd 10 rtt 180000us rttvar 5000us source 192.0.2.2"
SHIM
  printf '#!/bin/bash\nexit 0\n' > "$b/ps"
  chmod +x "$b"/*
}

bench_shim() {
  PATH="$SHIM/bin:$PATH" SHIM_BIN="$SHIM/bin" SHIM_STATE="$SHIM/state" W1_TARGET=ubuntu@localhost W1_OUT="$TMP/bout" N=3 TMPDIR="$TMP/tmpd" \
    bash tests/w1-agent-host-bench.sh "$@"
}

SHIM=$TMP/shim
make_shim "$SHIM"
mkdir -p "$TMP/tmpd" "$TMP/bout"

expect_eq "bench help states the login count" "$(bash tests/w1-agent-host-bench.sh help | grep -c 'about 59 logins')" 1
expect_eq "bench text names no bench M2" "$(grep -c 'M2' tests/w1-agent-host-bench.sh tests/files/w1-agent-host-bench-stats.py | grep -vc ':0$')" 0
expect_eq "run without --yes and without an answer stops before any login" "$(bench_shim run asked < /dev/null > /dev/null 2> "$TMP/ask.err"; echo $?)" 3
grep -q 'not confirmed' "$TMP/ask.err" && pass "run refusal message" || fail "run refusal message"
expect_eq "the refused run made no login" "$(wc -l < "$SHIM/state/calls" 2> /dev/null || echo 0)" 0
expect_eq "run with W1_MAX_SECONDS exceeded aborts" "$(W1_MAX_SECONDS=0 bench_shim run late --yes > /dev/null 2> "$TMP/late.err"; echo $?)" 3
grep -q 'W1_MAX_SECONDS' "$TMP/late.err" && pass "abort message names W1_MAX_SECONDS" || fail "abort message names W1_MAX_SECONDS"
expect_eq "an aborted run leaves no partial file and no temp file" "$(find "$TMP/bout" "$TMP/tmpd" -type f | wc -l)" 0
expect_eq "authentication failure stops the run" "$(SHIM_FAIL=1 bench_shim run denied --yes > /dev/null 2> "$TMP/denied.err"; echo $?)" 3
grep -q 'authentication failed' "$TMP/denied.err" && pass "authentication failure message" || fail "authentication failure message"

printf 'y\n' | bench_shim run before > "$TMP/run-before.out" 2> "$TMP/run-before.err" && pass "run answered y completes" || { fail "run answered y completes"; cat "$TMP/run-before.err"; }
grep -q 'projected total about' "$TMP/run-before.err" && pass "projected total printed after the first M3 pair" || fail "projected total printed after the first M3 pair"
printf 'bbr' > "$SHIM/state/net.ipv4.tcp_congestion_control"
SHIM_LOSS=4 SHIM_RETRANS=200000 SHIM_SSTHRESH=40 bench_shim run after --yes > "$TMP/run-after.out" 2> /dev/null && pass "run --yes completes" || fail "run --yes completes"
printf 'cubic' > "$SHIM/state/net.ipv4.tcp_congestion_control"
bench_shim run same --yes > /dev/null 2>&1
expect_eq "the run context records loss, the metrics cache and the socket cc" "$(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1]))["context"]; print(c["m1_loss_pct"], c["tcp_metrics_peer"].strip(), c["ss_cc"])' "$TMP/bout/before.run.json")" "0.0 ssthresh=15 cwnd=10 rtt=180000us rttvar=5000us cubic"
expect_eq "every upload counts against the login budget" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["context"]["logins"])' "$TMP/bout/before.run.json")" 19
expect_eq "no run file keeps the peer address" "$(grep -l '192\.0\.2' "$TMP"/bout/*.run.json | wc -l)" 0

bench_shim compare before after > "$TMP/cmp1.txt" 2>&1
grep -q '^before: sysctl cc=cubic' "$TMP/cmp1.txt" && grep -q '^after:  sysctl cc=bbr' "$TMP/cmp1.txt" && pass "compare prints both congestion controls" || fail "compare prints both congestion controls"
grep -q 'CC UNCHANGED' "$TMP/cmp1.txt" && fail "a cubic to bbr compare is not CC UNCHANGED" || pass "a cubic to bbr compare is not CC UNCHANGED"
for flag in 'LOSS CHANGED' 'RETRANS CHANGED' 'METRICS CACHE DIFFERS'; do
  grep -q "$flag" "$TMP/cmp1.txt" && pass "compare flags $flag" || fail "compare flags $flag"
done
expect_eq "compare labels every non-primary row descriptive" "$(grep -E '^m[0-9a-z_]+(@[0-9a-z]+)? +median' "$TMP/cmp1.txt" | grep -v '^m4_last_ms@5s64k' | grep -vc '\[descriptive\]')" 0
grep -E '^m4_last_ms@5s64k ' "$TMP/cmp1.txt" | grep -q '\[primary, descriptive\]' && pass "the primary row is demoted when loss and retransmits changed" || fail "the primary row is demoted when loss and retransmits changed"
grep -q 'tcp_metrics_peer: before' "$TMP/cmp1.txt" && pass "private compare shows the metrics entries" || fail "private compare shows the metrics entries"
bench_shim compare before same > "$TMP/cmp2.txt" 2>&1
grep -q 'CC UNCHANGED' "$TMP/cmp2.txt" && pass "same congestion control prints CC UNCHANGED" || fail "same congestion control prints CC UNCHANGED"
grep -qE 'IMPROVED|REGRESSED' "$TMP/cmp2.txt" && fail "no IMPROVED or REGRESSED survives CC UNCHANGED" || pass "no IMPROVED or REGRESSED survives CC UNCHANGED"
bench_shim compare before after --public > "$TMP/cmp3.txt" 2>&1
grep -q 'tcp_metrics_peer' "$TMP/cmp3.txt" && fail "public compare hides the metrics entries" || pass "public compare hides the metrics entries"
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["context"][sys.argv[3]]="203.0.113.9"; json.dump(d, open(sys.argv[2], "w"))' "$TMP/bout/before.run.json" "$TMP/bout/tainted.run.json" "sysctl.net.ipv4.tcp_slow_start_after_idle"
expect_eq "public compare refuses to print when the scrub finds an address" "$(bench_shim compare tainted after --public 2> "$TMP/cmp4.err" | wc -c) $(bench_shim compare tainted after --public > /dev/null 2>&1; echo $?)" "0 3"
grep -q 'scrub failed' "$TMP/cmp4.err" && pass "public compare names the scrub failure on stderr" || fail "public compare names the scrub failure on stderr"
bench_shim compare tainted after 2> /dev/null | grep -q '203.0.113.9' && pass "private compare still prints the address" || fail "private compare still prints the address"
rm -f "$TMP/bout/tainted.run.json"

printf 'cubic' > "$SHIM/state/net.ipv4.tcp_congestion_control"; printf 1 > "$SHIM/state/net.ipv4.tcp_slow_start_after_idle"; rm -f "$SHIM/state/writes"
expect_eq "ab-toggle without --yes is refused" "$(bench_shim ab-toggle > /dev/null 2>&1; echo $?)" 3
expect_eq "ab-toggle refuses a bad --rounds" "$(bench_shim ab-toggle --yes --rounds x > /dev/null 2>&1; echo $?)" 3
bench_shim ab-toggle --yes --rounds 3 > "$TMP/ab.out" 2> "$TMP/ab.err" && pass "ab-toggle against the shim completes" || { fail "ab-toggle against the shim completes"; cat "$TMP/ab.err"; }
expect_eq "ab-toggle runs the four arms with the three metrics, three rounds each" "$(python3 -I -c 'import json,sys; a=json.load(open(sys.argv[1]))["arms"]; print(sorted(a), sorted({m for v in a.values() for m in v}), {len(x) for v in a.values() for x in v.values()})' "$TMP/bout/ab.json")" "['bbr/0', 'bbr/1', 'cubic/0', 'cubic/1'] ['m3_down_s', 'm4_first_ms@5s64k', 'm4_last_ms@5s64k'] {3}"
expect_eq "ab-toggle restored the values it read" "$(cat "$SHIM/state/net.ipv4.tcp_congestion_control") $(cat "$SHIM/state/net.ipv4.tcp_slow_start_after_idle")" "cubic 1"
expect_eq "ab-toggle armed one server-side dead-man" "$(grep -c '^systemd-run .*agent-host-ab-restore' "$SHIM/state/writes")" 1
grep -q '^LIMITS: the arms measure' "$TMP/ab.out" && grep -q '\[primary\]' "$TMP/ab.out" && pass "ab-compare prints the primary label and the honest limit" || fail "ab-compare prints the primary label and the honest limit"
expect_eq "the ab arms never report a congestion control mismatch" "$(grep -c 'did not report' "$TMP/ab.err")" 0
expect_eq "the bench leaves no temp file behind" "$(find "$TMP/tmpd" -type f | wc -l)" 0

if bash tests/w1-agent-host-bench.sh self-test > "$TMP/bench.txt" 2>&1; then pass "bench self-test"; else fail "bench self-test"; cat "$TMP/bench.txt"; fi
for f in "$FX"/*; do
  python3 -I tests/files/w1-agent-host-bench-stats.py scrub < "$f" 2> "$TMP/scrub.txt" && pass "scrub: $f has no address, hostname or key material" || { fail "scrub: $f"; cat "$TMP/scrub.txt"; }
done

python3 -I - tests/files/w1-agent-host-bench-stats.py <<'PY' && pass "stats self-check" || fail "stats self-check"
import importlib.util, random, sys
spec = importlib.util.spec_from_file_location("s", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rng = random.Random(1)
b = [rng.gauss(1.9, 0.1) for _ in range(10)]
assert m.verdict("m3_down_s", b, [x * 0.85 for x in b])["verdict"] == "IMPROVED"
assert m.verdict("m3_down_s", b, [x * 1.01 for x in b])["verdict"] == "WITHIN NOISE"
assert m.verdict("m3_down_s", b, [x * 1.2 for x in b])["verdict"] == "REGRESSED"
assert m.scrub_findings("host 203.0.113.9") == ["ipv4"]
assert m.scrub_findings("fine 127.0.0.1 ::1 12:34:56") == []
before = {"kv": {"collector.done": "1", "strict.sshd.9": "4", "strict.1.10": "5", "um.user@1000.service.InvocationID": "a", "claude.7": "9", "oom_kill": "0", "um1000_oom_kill": "0", "um1000_oom_group_kill": "0"}}
added = {"kv": dict(before["kv"], **{"strict.1.11": "6"})}
lines, ok = m.snap_compare(before, added)
assert ok and "NEW infra" in lines[0] and lines[-1] == "INFRA PROCESSES UNTOUCHED", lines
gone = {"kv": {k: v for k, v in before["kv"].items() if k != "strict.1.10"}}
assert not m.snap_compare(before, gone)[1]
moved = {"kv": dict(before["kv"], **{"strict.1.10": "6"})}
assert not m.snap_compare(before, moved)[1]
assert m.snap_compare(before, dict(before, kv=dict(before["kv"], fingerprint="x")), dry=True)[1] is False
PY

python3 -I - tests/files/w1-agent-host-bench-stats.py <<'PY' && pass "stats rules: attribution, controls, ab validity, scrub words, continuity information, dry-run parts" || fail "stats rules: attribution, controls, ab validity, scrub words, continuity information, dry-run parts"
import importlib.util, random, sys
spec = importlib.util.spec_from_file_location("s", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
P = "m4_last_ms@5s64k"
rng = random.Random(2)
base = [rng.gauss(100, 3) for _ in range(10)]

def ctx(cc, sysctl_cc=None, loss="0", sent=100000, retrans=1000, peer="ssthresh=15"):
    c = {m.SSAI_SYSCTL: "1", "m1_loss_pct": str(loss), "tcp_metrics_peer": peer, "ss_bytes_sent": str(sent), "ss_bytes_retrans": str(retrans)}
    if cc:
        c["ss_cc"] = cc
    if sysctl_cc or cc:
        c[m.CC_SYSCTL] = sysctl_cc or cc
    return c

def doc(c, scale=1.0, primary=True):
    mt = {"m4_first_ms@5s64k": [x * scale for x in base], "m5_echo_ms": list(base)}
    if primary:
        mt[P] = [x * scale for x in base]
    return {"context": c, "metrics": mt}

def row(res, name):
    return next(r for r in res["rows"] if r["metric"] == name)

r = m.compare(doc(ctx("cubic")), doc(ctx("bbr"), 0.5))
assert r["attributable"] and row(r, P)["verdict"] == "IMPROVED" and row(r, P)["role"] == "primary, attributable", r
assert row(r, "m4_first_ms@5s64k")["role"] == "descriptive" and row(r, "m4_first_ms@5s64k")["verdict"] == "IMPROVED"
assert not any(f.startswith("CC ") for f in r["flags"]), r["flags"]
r = m.compare(doc(ctx("bbr")), doc(ctx("bbr"), 0.5))
assert not r["attributable"] and row(r, P)["verdict"] == "DRIFT (not attributable)" and any(f.startswith("CC UNCHANGED") for f in r["flags"]), r
assert row(r, P)["role"] == "primary, not attributable"
r = m.compare(doc(ctx("cubic")), doc(ctx("cubic"), 1.4))
assert row(r, P)["verdict"] == "DRIFT (not attributable)" and any(f.startswith("CC UNCHANGED") for f in r["flags"])
r = m.compare(doc(ctx("bbr")), doc(ctx("cubic"), 0.5))
assert not r["attributable"] and any(f.startswith("CC NOT ATTRIBUTABLE") for f in r["flags"]) and row(r, P)["verdict"] == "DRIFT (not attributable)"
r = m.compare(doc({"m1_loss_pct": "0"}), doc({"m1_loss_pct": "0"}, 0.5))
assert not r["attributable"] and any(f.startswith("CC UNKNOWN") for f in r["flags"])
r = m.compare(doc(ctx("cubic", sysctl_cc="bbr")), doc(ctx("bbr"), 0.5))
assert r["attributable"], "the congestion control of the last transfer must outrank the sysctl"
r = m.compare(doc(ctx("cubic", loss=0)), doc(ctx("bbr", loss=3), 0.5))
assert any(f.startswith("LOSS CHANGED") for f in r["flags"]) and row(r, P)["verdict"] == "DESCRIPTIVE (controls changed)" and row(r, P)["role"] == "primary, descriptive", r
r = m.compare(doc(ctx("cubic", loss=0)), doc(ctx("bbr", loss=0.9), 0.5))
assert not any(f.startswith("LOSS CHANGED") for f in r["flags"]) and row(r, P)["verdict"] == "IMPROVED"
r = m.compare(doc(ctx("cubic", loss=0)), doc(ctx("bbr", loss=1.1), 0.5))
assert any(f.startswith("LOSS CHANGED") for f in r["flags"])
r = m.compare(doc(ctx("cubic", retrans=1000)), doc(ctx("bbr", retrans=2000), 0.5))
assert any(f.startswith("RETRANS CHANGED") for f in r["flags"]) and row(r, P)["verdict"] == "DESCRIPTIVE (controls changed)"
r = m.compare(doc(ctx("cubic", retrans=1000)), doc(ctx("bbr", retrans=1400), 0.5))
assert not any(f.startswith("RETRANS CHANGED") for f in r["flags"])
r = m.compare(doc(ctx("cubic", peer="ssthresh=15")), doc(ctx("bbr", peer="ssthresh=40"), 0.5))
assert any(f.startswith("METRICS CACHE DIFFERS") for f in r["flags"])
r = m.compare(doc(ctx("cubic", peer="ssthresh=15")), doc(ctx("bbr", peer="ssthresh=15"), 0.5))
assert not any(f.startswith("METRICS CACHE DIFFERS") for f in r["flags"])
c = ctx("bbr"); del c["tcp_metrics_peer"]
assert not any(f.startswith("METRICS CACHE DIFFERS") for f in m.compare(doc(ctx("cubic")), doc(c, 0.5))["flags"])
def shifted(c, shift):
    d = doc(c, 0.5)
    d["metrics"]["m1_rtt_ms"] = [x + shift for x in base]
    return d

b1 = doc(ctx("cubic"))
b1["metrics"]["m1_rtt_ms"] = list(base)
r = m.compare(b1, shifted(ctx("bbr"), 40))
assert any(f.startswith("PATH CHANGED") for f in r["flags"]) and any(f.startswith("CONTROL MOVED") for f in r["flags"]), r["flags"]
assert row(r, P)["verdict"] == "DESCRIPTIVE (controls changed)" and row(r, P)["role"] == "primary, descriptive" and row(r, P)["raw_verdict"] == "IMPROVED", r
r = m.compare(doc(ctx("cubic")), doc(dict(ctx("bbr"), psi_cpu_avg10_end="60"), 0.5))
assert any(f.startswith("NOISY") for f in r["flags"]) and row(r, P)["verdict"] == "DESCRIPTIVE (controls changed)" and row(r, P)["role"] == "primary, descriptive", r
r = m.compare(doc(ctx("cubic")), doc(ctx("bbr"), 0.5, primary=False))
assert any(f.startswith("PRIMARY METRIC") for f in r["flags"]) and all(x["role"] == "descriptive" for x in r["rows"])

def abdoc(null_scale):
    b = lambda sc: [x * sc for x in base[:5]]
    return {"arms": {"cubic/1": {P: b(1.0), "m3_down_s": b(1.0)}, "cubic/0": {P: b(0.5), "m3_down_s": b(1.0)},
                     "bbr/1": {P: b(1.0), "m3_down_s": b(1.0)}, "bbr/0": {P: b(null_scale), "m3_down_s": b(1.0)}}}
r = m.ab_compare(abdoc(1.0))
assert not r["flags"] and next(x for x in r["rows"] if x["arm"] == "cubic/0" and x["metric"] == P)["verdict"] == "IMPROVED", r
assert next(x for x in r["rows"] if x["arm"] == "cubic/0" and x["metric"] == P)["role"] == "primary"
assert next(x for x in r["rows"] if x["arm"] == "cubic/0" and x["metric"] == "m3_down_s")["role"] == "descriptive"
r = m.ab_compare(abdoc(0.5))
assert any(f.startswith("A/B INVALID") for f in r["flags"]) and next(x for x in r["rows"] if x["arm"] == "cubic/0" and x["metric"] == P)["verdict"] == "DRIFT (null control moved)", r

assert m.scrub_findings("host " + "Col" + "ombia") == ["denied-word"]
assert m.scrub_findings("locale " + "es_" + "CO.UTF-8") == ["denied-word"]
assert m.scrub_findings("vendor " + "CONTA" + "BO") == ["denied-word"]
assert m.scrub_findings("color column collection") == []

kb = {"collector.done": "1", "strict.sshd.9": "4", "strict.1.10": "5", "info.tmux.40": "9", "info.sshdsess.50": "9", "info.sshdsess.51": "9", "claude.1": "1", "claude.2": "2", "oom_kill": "0"}
ka = {"collector.done": "1", "strict.sshd.9": "4", "strict.1.10": "5", "info.sshdsess.51": "9", "oom_kill": "0"}
lines, ok = m.snap_compare({"kv": kb}, {"kv": ka})
assert ok and any(l.startswith("WARNING") and "tmux server" in l and "40" in l for l in lines) and any(l.startswith("WARNING") and "sshd session" in l and "50" in l for l in lines), lines
assert lines[-1] == "INFRA PROCESSES UNTOUCHED (2 claude process(es) ended)", lines
K = {"collector.done": "1", "strict.sshd.9": "4"}
lines, ok = m.snap_compare({"kv": dict(K, **{"strict.1.10": "5", "claude.1": "1"})}, {"kv": dict(K, **{"strict.1.10": "6"})})
assert not ok and lines[-1].startswith("CONTINUITY BROKEN") and lines[-1].endswith("(1 claude process(es) ended)"), lines
lines, ok = m.snap_compare({"kv": dict(K, **{"strict.1.10": "5", "info.tmux.40": "9"})}, {"kv": dict(K, **{"strict.1.10": "5", "info.tmux.40": "9"})})
assert ok and lines == ["INFRA PROCESSES UNTOUCHED"], lines
lines, ok = m.snap_compare({"kv": {}}, {"kv": {}})
assert not ok and lines == ["CONTINUITY UNKNOWN: incomplete snapshot"], lines
lines, ok = m.snap_compare({"kv": K}, {"kv": {"strict.sshd.9": "4"}})
assert not ok and lines == ["CONTINUITY UNKNOWN: incomplete snapshot"], lines
lines, ok = m.snap_compare({"kv": {"collector.done": "1", "strict.1.10": "5"}}, {"kv": K})
assert not ok and lines == ["CONTINUITY UNKNOWN: incomplete snapshot"], lines

same = {"kv": {"fingerprint": "aa", "fp.role": "1", "fp.dpkg": "2"}}
assert m.snap_compare(same, same, dry=True) == ([m.DRY_OK], True)
lines, ok = m.snap_compare(same, {"kv": {"fingerprint": "bb", "fp.role": "9", "fp.dpkg": "8"}}, dry=True)
assert not ok and lines[0] == "DRY RUN CHANGED THE HOST: fingerprint differs in dpkg, role" and "apt or unattended-upgrades" in lines[1], lines
assert m.snap_compare({"kv": {}}, {"kv": {}}, dry=True)[1] is False
PY

FPR=$TMP/fproot
mkdir -p "$FPR"/{etc/ssh/sshd_config.d,etc/apt/sources.list.d,etc/apt/keyrings,etc/default,usr/local/sbin,usr/local/lib/agent-host,var/lib/node_exporter/textfile,var/lib/dpkg}
printf 'Port 22\n' > "$FPR/etc/ssh/sshd_config"
printf 'X11Forwarding yes\n' > "$FPR/etc/ssh/sshd_config.d/10-x.conf"
printf '#!/bin/sh\ntrue\n' > "$FPR/usr/local/sbin/agent-host-x"
printf 'gauge\n' > "$FPR/usr/local/lib/agent-host/reboot-gauge.sh"
printf 'deb [signed-by=/etc/apt/keyrings/gh.gpg] https://example.invalid stable main\n' > "$FPR/etc/apt/sources.list.d/github-cli.list"
printf 'keyring\n' > "$FPR/etc/apt/keyrings/gh.gpg"
printf 'LANG=C.UTF-8\n' > "$FPR/etc/default/locale"
printf 'en_US.UTF-8 UTF-8\n' > "$FPR/etc/locale.gen"
head -c 1000 /dev/zero > "$FPR/swapfile"
printf 'agent_host_reboot_required 0\n' > "$FPR/var/lib/node_exporter/textfile/agent_host_reboot.prom"
printf 'Package: demo\nStatus: install ok installed\nVersion: 1\nArchitecture: all\nDescription: demo\n\n' > "$FPR/var/lib/dpkg/status"
fpall() { bash tests/files/w1-agent-host-collect.sh --fp-only --fp-root "$FPR"; }
fpv() { fpall | grep '^fingerprint='; }
FP0=$(fpv)
expect_eq "the fingerprint is stable between two reads" "$(fpv)" "$FP0"
find "$FPR" -type f -exec touch -d 2001-01-01 {} +
expect_eq "the fingerprint ignores modification times, the gauge file included" "$(fpv)" "$FP0"
for f in etc/ssh/sshd_config.d/10-x.conf usr/local/sbin/agent-host-x usr/local/lib/agent-host/reboot-gauge.sh etc/apt/sources.list.d/github-cli.list etc/apt/keyrings/gh.gpg etc/default/locale etc/locale.gen swapfile var/lib/node_exporter/textfile/agent_host_reboot.prom var/lib/dpkg/status; do
  cp -p "$FPR/$f" "$TMP/fp.bak"
  printf 'x' >> "$FPR/$f"
  [ "$(fpv)" != "$FP0" ] && pass "the fingerprint covers $f" || fail "the fingerprint covers $f"
  cp -p "$TMP/fp.bak" "$FPR/$f"
done
expect_eq "the fingerprint returns to its value once every path is restored" "$(fpv)" "$FP0"
printf 'x\n' > "$FPR/usr/local/sbin/agent-host-new"
[ "$(fpv)" != "$FP0" ] && pass "a new agent-host script changes the fingerprint" || fail "a new agent-host script changes the fingerprint"
rm -f "$FPR/usr/local/sbin/agent-host-new"
fpall | grep '^fp\.' | grep -v '^fp\.gauge' > "$TMP/fp.parts"
printf 'agent_host_reboot_required 1\n' > "$FPR/var/lib/node_exporter/textfile/agent_host_reboot.prom"
expect_eq "a gauge-only change moves only the gauge part" "$(fpall | grep '^fp\.' | grep -v '^fp\.gauge' | cmp - "$TMP/fp.parts" && echo same)" same
printf 'agent_host_reboot_required 0\n' > "$FPR/var/lib/node_exporter/textfile/agent_host_reboot.prom"
cat > "$TMP/fpplay.yml" <<'YML'
- hosts: all
  gather_facts: false
  tasks:
    - name: script
      copy: {dest: "{{ fproot }}/usr/local/sbin/agent-host-play", content: "x\n"}
    - name: library
      copy: {dest: "{{ fproot }}/usr/local/lib/agent-host/play.sh", content: "x\n"}
    - name: apt source
      copy: {dest: "{{ fproot }}/etc/apt/sources.list.d/play.list", content: "x\n"}
    - name: locale
      copy: {dest: "{{ fproot }}/etc/default/locale", content: "LANG=C.UTF-8\nLC_X=y\n"}
    - name: gauge file
      copy: {dest: "{{ fproot }}/var/lib/node_exporter/textfile/agent_host_reboot.prom", content: "agent_host_reboot_required 1\n"}
    - name: sshd drop-in
      copy: {dest: "{{ fproot }}/etc/ssh/sshd_config.d/11-play.conf", content: "x\n"}
YML
play() { ansible-playbook -i 'localhost,' -c local -e ansible_become=false -e "fproot=$FPR" "$@" "$TMP/fpplay.yml" > "$TMP/fpplay.out" 2>&1; }
play --check
grep -q 'changed=6' "$TMP/fpplay.out" && pass "the dry run of the role-shaped play reports its six changes" || fail "the dry run of the role-shaped play reports its six changes"
expect_eq "a --check run leaves the fingerprint unchanged" "$(fpv)" "$FP0"
fpall | python3 -I tests/files/w1-agent-host-bench-stats.py kv-json a > "$TMP/fp-a.json"
play
[ "$(fpv)" != "$FP0" ] && pass "the same play applied changes the fingerprint (negative control)" || fail "the same play applied changes the fingerprint (negative control)"
fpall | python3 -I tests/files/w1-agent-host-bench-stats.py kv-json b > "$TMP/fp-b.json"
expect_eq "dry compare of a snapshot with itself says nothing changed" "$(python3 -I tests/files/w1-agent-host-bench-stats.py snap-compare "$TMP/fp-a.json" "$TMP/fp-a.json" --dry)" "DRY RUN CHANGED NO FINGERPRINTED PATH"
python3 -I tests/files/w1-agent-host-bench-stats.py snap-compare "$TMP/fp-a.json" "$TMP/fp-b.json" --dry > "$TMP/fp-dry.txt"
expect_eq "dry compare after a real apply fails and names the parts" "$? $(head -1 "$TMP/fp-dry.txt")" "3 DRY RUN CHANGED THE HOST: fingerprint differs in cfg, gauge, role"

sleep 60 & SLEEP_PID=$!
( exec -a 'tmux: server' sleep 60 ) & TMUX_PID=$!
( exec -a 'sshd: ubuntu@pts/9' sleep 60 ) & SSHS_PID=$!
sleep 1
bash tests/files/w1-agent-host-collect.sh --user "$(id -un)" --continuity-re '/never-matches-anything/' > "$TMP/collect-info.txt" 2> /dev/null
kill "$SLEEP_PID" "$TMUX_PID" "$SSHS_PID" 2> /dev/null
wait 2> /dev/null
grep -qE "^info\.tmux\.$TMUX_PID=[0-9]+$" "$TMP/collect-info.txt" && pass "the collector records the tmux server pid as an information key" || fail "the collector records the tmux server pid as an information key"
grep -qE "^info\.sshdsess\.$SSHS_PID=[0-9]+$" "$TMP/collect-info.txt" && pass "the collector records sshd session pids as information keys" || fail "the collector records sshd session pids as information keys"
expect_eq "information keys never enter the strict set" "$(grep -c '^strict\..*info' "$TMP/collect-info.txt")" 0
expect_eq "the collector prints the five fingerprint parts" "$(grep -c '^fp\.' "$TMP/collect-info.txt")" 5

if command -v shellcheck > /dev/null; then
  shellcheck -s bash tests/files/w1-agent-host-collect.sh tests/w1-agent-host-bench.sh tests/w1-agent-host-selftest.sh && pass "shellcheck" || fail "shellcheck"
else
  echo "SKIP shellcheck (not installed)"
fi

mkdir -p "$TMP/good" "$TMP/bad"
printf -- '---\n- name: read\n  ansible.builtin.command: sysctl -n vm.swappiness\n  check_mode: false\n  changed_when: false\n- name: blk\n  block:\n    - name: write\n      ansible.builtin.copy: {dest: /x, content: y}\n' > "$TMP/good/a.yml"
printf -- '---\n- name: sneaky\n  ansible.builtin.copy: {dest: /x, content: y}\n  check_mode: false\n- name: noflag\n  ansible.builtin.command: id\n  check_mode: false\n' > "$TMP/bad/a.yml"
python3 -I tests/files/w1-agent-host-purity.py "$TMP/good" > /dev/null && pass "purity gate accepts a read" || fail "purity gate accepts a read"
python3 -I tests/files/w1-agent-host-purity.py "$TMP/bad" > /dev/null && fail "purity gate rejects a write and a flagless read" || pass "purity gate rejects a write and a flagless read"
if [ -d roles/agent_host/tasks ]; then
  python3 -I tests/files/w1-agent-host-purity.py roles/agent_host/tasks && pass "role: check_mode false tasks are read-only reads" || fail "role: check_mode false tasks are read-only reads"
else
  echo "SKIP role purity (no roles/agent_host/tasks yet)"
fi

echo "selftest failures: $FAILS"
[ "$FAILS" -eq 0 ]
