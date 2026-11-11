#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$PWD
NAME=${AGENT_HOST_LAB_NAME:-agent-host-lab-$$}
IMAGE=${AGENT_HOST_LAB_IMAGE:-agent-host-lab:local}
GUARD_SHA=13f9ae8c96d385aa4521ec4ce26d2a081e56f656b1ea551b73d47d7a6f95746d
DROPINS=/etc/ssh/sshd_config.d
WORK=$(mktemp -d)
OUT=$WORK/out.txt
FAILS=0
RC=0

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "${ANSIBLE_VAULT_PASSWORD_FILE:-}" ] && [ ! -f .vault_pass ]; then
  echo unused >"$WORK/vault-pass"
  export ANSIBLE_VAULT_PASSWORD_FILE=$WORK/vault-pass
fi
export ANSIBLE_NOCOWS=1 NO_COLOR=1 ANSIBLE_ROLES_PATH="$REPO/roles"

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1${2:+ ($2)}"; FAILS=$((FAILS + 1)); }
check() { local label=$1; shift; if "$@"; then pass "$label"; else fail "$label"; fi; }
dx() { docker exec "$NAME" "$@"; }
sh_in() { docker exec "$NAME" sh -c "$1"; }
sha_of() { sh_in "sha256sum $1 | cut -d' ' -f1"; }

recap() { sed -nE "s/^$NAME +: .*[[:space:]]$1=([0-9]+).*/\\1/p" "$OUT" | tail -n 1; }
recap_is() {
  local pair
  for pair in "$@"; do
    [ "$(recap "${pair%%=*}")" = "${pair#*=}" ] || return 1
  done
}
out_has() { grep -qF -- "$1" "$OUT"; }
sshd_t() { sh_in "/usr/sbin/sshd -T | grep -E '^$1 ' | sort | paste -sd,"; }
conf_glob() { sh_in "cd $DROPINS && ls *.conf | tr '\n' ' ' | sed 's/ \$//'"; }
dropin_shas() { sh_in "cd $DROPINS && sha256sum 10-agent-host-auth.conf 11-agent-host-transport.conf"; }

cat >"$WORK/play.yml" <<'EOF'
---
- name: Agent host role in the lab container
  hosts: all
  gather_facts: false
  roles:
    - { role: agent_host, tags: [agent_host] }
EOF

cat >"$WORK/lab-vars.yml" <<'EOF'
---
ssh_allowed_users: ubuntu
agent_host_second_terminal: true
agent_host_packages_enabled: false
agent_host_locale_enabled: false
agent_host_network_enabled: false
agent_host_memory_enabled: false
agent_host_session_enabled: false
agent_host_reporting_enabled: false
agent_host_firewall_enabled: false
agent_host_ssh_auth:
  AuthenticationMethods: "publickey"
agent_host_ssh_client_alive_interval: 60
agent_host_ssh_client_alive_count_max: 5
agent_host_limits_nofile_soft: 65536
agent_host_limits_nofile_hard: 1048576
agent_host_net_sysctl:
  net.ipv4.tcp_slow_start_after_idle: "0"
agent_host_mem_sysctl: {}
agent_host_sess_sysctl: {}
EOF

run_play() {
  local tags=${LAB_TAGS:-agent_host_ssh,agent_host_limits,agent_host_sysctl}
  set +e
  ansible-playbook -i "$NAME," -c community.docker.docker \
    -e ansible_python_interpreter=/usr/bin/python3 -e ansible_become=false \
    -e @"$WORK/lab-vars.yml" "$@" \
    --tags "$tags" --skip-tags agent_host_live "$WORK/play.yml" >"$OUT" 2>&1
  RC=$?
  set -e
}

run_engine() {
  local report=$1
  set +e
  ansible-playbook -i 'w1,' -c community.docker.docker -e "ansible_host=$NAME" \
    -e ansible_python_interpreter=/usr/bin/python3 -e ansible_become=false \
    -e @"$WORK/lab-vars.yml" -e "agent_host_check_report=$report" \
    -e '{"agent_host_check_domains": ["ssh", "limits", "sysctl"]}' \
    "$WORK/e/tests/w1-agent-host-check.yml" >"$WORK/engine.txt" 2>&1
  set -e
  [ -s "$report" ]
}

row_state() {
  python3 -I -c '
import json, sys
rows = {r["id"]: r["state"] for r in json.load(open(sys.argv[1]))["rows"]}
print(rows.get(sys.argv[2], "ABSENT"))
' "$1" "$2"
}

expect_rows() {
  local report=$1 want=$2 label=$3 id
  shift 3
  for id in "$@"; do
    if [ "$(row_state "$report" "$id")" != "$want" ]; then
      fail "$label $id" "expected $want, got $(row_state "$report" "$id")"
      return 0
    fi
  done
  pass "$label $*"
}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-apt openssh-server sudo procps ca-certificates ufw \
 && ssh-keygen -A && mkdir -p /run/sshd && (id ubuntu >/dev/null 2>&1 || useradd -m ubuntu)
EOF
docker run -d --name "$NAME" --network none "$IMAGE" sleep infinity >/dev/null

docker exec -i "$NAME" sh -eu <<'EOF'
cd /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >00-no-password.conf
chown root:root 00-no-password.conf
chmod 0644 00-no-password.conf
printf 'PasswordAuthentication yes\n' >50-cloud-init.conf
chmod 0600 50-cloud-init.conf
printf 'PasswordAuthentication no\n' >60-cloudimg-settings.conf
chmod 0644 60-cloudimg-settings.conf
printf '#!/bin/sh\necho "$@" >>/var/log/systemctl-shim.log\nexit 0\n' >/usr/local/bin/systemctl
chmod 0755 /usr/local/bin/systemctl
EOF

PROTECTED_RE='permitrootlogin|port|maxauthtries|listenaddress|allowusers|denyusers|allowgroups|denygroups'
PROTECTED_BEFORE=$(sh_in "/usr/sbin/sshd -T | grep -E '^($PROTECTED_RE) ' | sort")

check "L0 openssh-server is the 9.6 series" sh_in "dpkg-query -W -f='\${Version}' openssh-server | grep -q '^1:9.6p1'"
check "L0 sshd_config includes the drop-in directory" sh_in "grep -q '^Include /etc/ssh/sshd_config.d/\\*.conf' /etc/ssh/sshd_config"
check "L0 seeded guard has the canonical sha256" test "$(sha_of $DROPINS/00-no-password.conf)" = "$GUARD_SHA"

ENGINE_OK=0
if [ -f tests/w1-agent-host-check.yml ] && [ -f tests/files/w1-agent-host-collect.sh ]; then
  mkdir -p "$WORK/e/tests"
  cp -r tests/w1-agent-host-check.yml tests/w1-agent-host-check-rows tests/files "$WORK/e/tests/"
  printf -- '---\nvault_w1_ip: lab\n' >"$WORK/e/vault.yml"
  ENGINE_OK=1
  if run_engine "$WORK/check-before.json"; then
    expect_rows "$WORK/check-before.json" FAIL "L11 before: rows the converge will flip" \
      R04 R07 SSHD:authenticationmethods SSHD:clientaliveinterval SSHD:clientalivecountmax
    expect_rows "$WORK/check-before.json" PASS "L11 before: rows that already hold" R01 R02 R03a R03b R06b R12
  else
    ENGINE_OK=0
    fail "L11 the engine could not run against the container before the converge" "$(tail -n 5 "$WORK/engine.txt" | tr '\n' ' ')"
  fi
else
  fail "L11 the engine or its collector is missing"
fi

run_play
check "L1 first run has no failure" recap_is failed=0 unreachable=0
check "L1 first run reports the apply branch" out_has "sshd stage: applying"
check "L1 guard sha256 is unchanged" test "$(sha_of $DROPINS/00-no-password.conf)" = "$GUARD_SHA"
check "L1 adoption left no backup of the guard" test "$(sh_in "ls $DROPINS/00-no-password.conf.*~ 2>/dev/null | wc -l")" = 0

check "L2 auth drop-in is root:root 0644 with the lab values" test \
  "$(sh_in "stat -c '%U:%G %a' $DROPINS/10-agent-host-auth.conf; cat $DROPINS/10-agent-host-auth.conf")" = "$(printf 'root:root 644\nAuthenticationMethods publickey')"
check "L2 transport drop-in is root:root 0644 with the lab values" test \
  "$(sh_in "stat -c '%U:%G %a' $DROPINS/11-agent-host-transport.conf; cat $DROPINS/11-agent-host-transport.conf")" = "$(printf 'root:root 644\nClientAliveInterval 60\nClientAliveCountMax 5')"
check "L2 sshd -T keeps passwords off" test "$(sshd_t '(passwordauthentication|kbdinteractiveauthentication)')" = "kbdinteractiveauthentication no,passwordauthentication no"
check "L2 sshd -T reports the owned directives" test \
  "$(sshd_t '(clientaliveinterval|clientalivecountmax|authenticationmethods)')" = "authenticationmethods publickey,clientalivecountmax 5,clientaliveinterval 60"
check "L2 protected sshd values are unchanged" test "$(sh_in "/usr/sbin/sshd -T | grep -E '^($PROTECTED_RE) ' | sort")" = "$PROTECTED_BEFORE"

if [ "$ENGINE_OK" = 1 ]; then
  if run_engine "$WORK/check-after.json"; then
    expect_rows "$WORK/check-after.json" PASS "L11 after: rows that flipped" \
      R04 R07 SSHD:authenticationmethods SSHD:clientaliveinterval SSHD:clientalivecountmax
    expect_rows "$WORK/check-after.json" PASS "L11 after: rows that kept holding" R01 R02 R03a R03b R06b R12
    echo "NOTE L11 not evaluated here (needs systemd, the journal or a live PAM session): R08a R08b R09 R11 and the SYS runtime rows"
  else
    fail "L11 the engine could not run against the converged container" "$(tail -n 5 "$WORK/engine.txt" | tr '\n' ' ')"
  fi
fi

run_play
check "L3 second identical run is idle" recap_is changed=0 failed=0
check "L3 second run reports nothing to apply" out_has "sshd stage: nothing to apply"
run_play --check
check "L3 check run after the apply is idle" recap_is changed=0 failed=0

BEFORE_SHAS=$(dropin_shas)
run_play -e agent_host_second_terminal=false -e agent_host_ssh_client_alive_count_max=7
check "L3b missing attestation fails before the block" recap_is failed=1 rescued=0
check "L3b the failure names the attestation" out_has "agent_host_second_terminal=true"
check "L3b drop-ins are byte-identical" test "$(dropin_shas)" = "$BEFORE_SHAS"
run_play -e agent_host_second_terminal=false
check "L3b nothing to apply needs no attestation" recap_is changed=0 failed=0

BAD='{"agent_host_ssh_transport": {"ClientAliveInterval": "60", "BogusDirectiveXyz": "1"}}'
EXPECTED_GLOB="00-no-password.conf 50-cloud-init.conf 60-cloudimg-settings.conf"
sh_in ": >/var/log/systemctl-shim.log"
run_play -e "$BAD"
check "L4 injected failure is rescued" recap_is failed=1 rescued=1
check "L4 only the three original drop-ins remain" test "$(conf_glob)" = "$EXPECTED_GLOB"
check "L4 guard sha256 is unchanged" test "$(sha_of $DROPINS/00-no-password.conf)" = "$GUARD_SHA"
check "L4 the owned auth drop-in was set aside" sh_in "test -e $DROPINS/10-agent-host-auth.conf.rolledback~"
check "L4 sshd -T still keeps passwords off" test "$(sshd_t passwordauthentication)" = "passwordauthentication no"
check "L4 the rollback reloaded sshd" sh_in "grep -q 'reload ssh' /var/log/systemctl-shim.log"

sh_in "rm -f $DROPINS/00-no-password.conf"
run_play -e "$BAD"
check "L5 hostile start is rescued" recap_is failed=1 rescued=1
check "L5 the guard exists again with the canonical sha256" test "$(sha_of $DROPINS/00-no-password.conf)" = "$GUARD_SHA"
check "L5 sshd -T keeps passwords off" test "$(sshd_t passwordauthentication)" = "passwordauthentication no"
check "L5 only the three original drop-ins remain" test "$(conf_glob)" = "$EXPECTED_GLOB"

sh_in "rm -f $DROPINS/00-no-password.conf"
run_play
check "L6 a hand-deleted guard is recreated" recap_is failed=0
check "L6 the recreated guard has the canonical sha256" test "$(sha_of $DROPINS/00-no-password.conf)" = "$GUARD_SHA"
check "L6 the run reported a change" test "$(recap changed)" -ge 1

check "L7 the rollback script succeeds" dx /usr/local/sbin/agent-host-sshd-rollback
AFTER_ONE=$(sh_in "cd $DROPINS && ls -A | sort && sha256sum 00-no-password.conf")
check "L7 the rollback script succeeds again" dx /usr/local/sbin/agent-host-sshd-rollback
check "L7 the rollback script is idempotent" test "$(sh_in "cd $DROPINS && ls -A | sort && sha256sum 00-no-password.conf")" = "$AFTER_ONE"
check "L7 the guard keeps the canonical sha256" test "$(sha_of $DROPINS/00-no-password.conf)" = "$GUARD_SHA"
check "L7 no half-written guard is left" test "$(sh_in "ls $DROPINS/*.new~ 2>/dev/null | wc -l")" = 0

LIMITS=/etc/security/limits.d/60-agent-host.conf
check "L8 limits file is exactly the soft line" test "$(sh_in "cat $LIMITS")" = "ubuntu soft nofile 65536"
check "L8 limits file has no wildcard, root or nproc entry" test "$(sh_in "grep -cE '^\\*|root|nproc' $LIMITS || true")" = 0
LIMITS_SHA=$(sha_of $LIMITS)
run_play -e agent_host_limits_nofile_hard=2000000
check "L8 a hard limit above fs.nr_open fails the ceiling assert" recap_is failed=1
check "L8 the limits file is unchanged by the failed run" test "$(sha_of $LIMITS)" = "$LIMITS_SHA"

run_play
check "L9 the converge after the rollback is clean" recap_is failed=0
check "L9 the net sysctl file holds the lab key" test \
  "$(sh_in 'cat /etc/sysctl.d/60-agent-host-net.conf')" = "net.ipv4.tcp_slow_start_after_idle = 0"
run_play -e '{"agent_host_sess_sysctl": {"net.ipv4.tcp_slow_start_after_idle": "1"}}'
check "L9 the same key in two domains fails the uniqueness assert" recap_is failed=1
check "L9 the failure names the shared key" out_has "more than one domain map"
run_play -e '{"agent_host_net_sysctl": {}}'
check "L9 an emptied domain removes its file" sh_in "test ! -e /etc/sysctl.d/60-agent-host-net.conf"
run_play
check "L9 the file returns with the key" sh_in "test -e /etc/sysctl.d/60-agent-host-net.conf"

run_play -e agent_host_ssh_transport_enabled=false
check "L12 the transport switch off runs clean" recap_is failed=0
check "L12 the transport drop-in is removed" sh_in "test ! -e $DROPINS/11-agent-host-transport.conf"
check "L12 the auth drop-in stays" sh_in "test -e $DROPINS/10-agent-host-auth.conf"
run_play -e agent_host_ssh_transport_enabled=false
check "L12 the next run with the switch off is idle" recap_is changed=0 failed=0
run_play
check "L12 the switch back on restores the transport drop-in" sh_in "test -e $DROPINS/11-agent-host-transport.conf"

LAB_TAGS=agent_host_firewall run_play --check -e '{"agent_host_firewall_enabled": true}' -e agent_host_second_terminal=true
if [ "$RC" = 0 ] && grep -q '^PLAY RECAP' "$OUT"; then
  pass "L10 firewall stage under --check"
elif [ "${AGENT_HOST_LAB_FALLBACK:-0}" = 1 ]; then
  tail -n 8 "$OUT"
  LAB_TAGS=agent_host_firewall run_play --syntax-check -e '{"agent_host_firewall_enabled": true}'
  if [ "$RC" = 0 ]; then
    echo "NOTE L10 fell back to a syntax check: no firewall task was executed"
    pass "L10 firewall stage syntax only"
  else
    fail "L10 firewall stage syntax"
  fi
else
  fail "L10 firewall stage under --check" "$(tail -n 5 "$OUT" | tr '\n' ' ')"
fi

echo "lab failures: $FAILS"
[ "$FAILS" -eq 0 ]
