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
before = {"kv": {"strict.1.10": "5", "um.user@1000.service.InvocationID": "a", "claude.7": "9", "oom_kill": "0", "um1000_oom_kill": "0", "um1000_oom_group_kill": "0"}}
added = {"kv": dict(before["kv"], **{"strict.1.11": "6"})}
lines, ok = m.snap_compare(before, added)
assert ok and "NEW infra" in lines[0] and lines[-1] == "INFRA PROCESSES UNTOUCHED", lines
gone = {"kv": {k: v for k, v in before["kv"].items() if k != "strict.1.10"}}
assert not m.snap_compare(before, gone)[1]
moved = {"kv": dict(before["kv"], **{"strict.1.10": "6"})}
assert not m.snap_compare(before, moved)[1]
assert m.snap_compare(before, dict(before, kv=dict(before["kv"], fingerprint="x")), dry=True)[1] is False
PY

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
