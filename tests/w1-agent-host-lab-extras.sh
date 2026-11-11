#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WITH_SYSTEMD=0
for arg in "$@"; do
  case $arg in
    --systemd) WITH_SYSTEMD=1 ;;
    *) echo "usage: $0 [--systemd]" >&2; exit 2 ;;
  esac
done

ROOT=$PWD
DEFAULTS=$ROOT/roles/agent_host/defaults/main
SCRATCH=$(mktemp -d)
PLAIN=agent-host-lab-extras-$$
SD=agent-host-lab-extras-sd-$$
IMAGE=agent-host-lab-extras-sd:$$
FAILS=0
RECAP=""
LAST_LOG=""
TEXTFILE=/var/lib/node_exporter/textfile
GAUGE_DIR=/usr/local/lib/agent-host
SETTINGS_SCRIPT=$GAUGE_DIR/settings-gauge.sh
SETTINGS_PROM=$TEXTFILE/agent_host_settings.prom
SETTINGS_RUN="PATH=/tmp/fakebin:\$PATH AGENT_HOST_ROOT=/tmp/fx AGENT_HOST_TEXTFILE_DIR=$TEXTFILE $SETTINGS_SCRIPT"

cleanup() {
  docker rm -f "$PLAIN" "$SD" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
}

default_value() {
  python3 -I -c 'import sys, yaml; print(yaml.safe_load(open(sys.argv[1]))[sys.argv[2]])' "$DEFAULTS/$1" "$2"
}

default_list() {
  python3 -I -c 'import sys, yaml; print(" ".join(yaml.safe_load(open(sys.argv[1]))[sys.argv[2]]))' "$DEFAULTS/$1" "$2"
}

cat >"$SCRATCH/ansible.cfg" <<EOF
[defaults]
roles_path = $ROOT/roles
host_key_checking = False
interpreter_python = auto_silent
retry_files_enabled = False
nocows = 1
deprecation_warnings = False
EOF

cat >"$SCRATCH/inventory.yml" <<EOF
all:
  hosts:
    lab:
      ansible_connection: community.docker.docker
      ansible_python_interpreter: /usr/bin/python3
EOF

cat >"$SCRATCH/play.yml" <<EOF
- hosts: lab
  gather_facts: true
  roles:
    - { role: agent_host, tags: [agent_host] }
EOF

run() {
  local container=$1 name=$2
  shift 2
  ANSIBLE_CONFIG=$SCRATCH/ansible.cfg ansible-playbook -i "$SCRATCH/inventory.yml" \
    -e "ansible_host=$container" -e ssh_allowed_users=ubuntu "$@" "$SCRATCH/play.yml" >"$SCRATCH/$name.log" 2>&1 || true
  LAST_LOG=$SCRATCH/$name.log
  RECAP=$(grep -E '^lab +:' "$LAST_LOG" | tail -1 || true)
}

recap_ok() {
  local label=$1 changed=$2
  if printf '%s' "$RECAP" | grep -Eq "changed=$changed +unreachable=0 +failed=0 "; then
    pass "$label"
  else
    fail "$label ($RECAP)"
    grep -E -A4 '^(fatal|failed):' "$LAST_LOG" | head -n 12 || true
  fi
}

dexec() {
  local container=$1
  shift
  docker exec "$container" sh -c "$*"
}

start_plain() {
  docker run -d --name "$PLAIN" ubuntu:24.04 sleep infinity >/dev/null
  dexec "$PLAIN" 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-apt ca-certificates >/dev/null'
  dexec "$PLAIN" 'printf "#!/bin/sh\necho inactive\n" >/usr/local/bin/systemctl && chmod 755 /usr/local/bin/systemctl'
}

packages_half() {
  local tags=agent_host_packages,agent_host_locale pin names name manual
  pin=$(default_value packages.yml agent_host_gh_keyring_sha256)
  names=$(default_list packages.yml agent_host_baseline_packages)

  check "gh absent before the apply" dexec "$PLAIN" '! command -v gh'

  run "$PLAIN" packages-check --tags "$tags" --check --diff
  recap_ok "packages --check on a fresh host" '[1-9][0-9]*'

  run "$PLAIN" packages-apply --tags "$tags"
  recap_ok "packages apply" '[1-9][0-9]*'
  check "gh runs" dexec "$PLAIN" 'gh --version'
  check "gh comes from the pinned repository" dexec "$PLAIN" \
    "apt-cache policy gh | awk '/\\*\\*\\*/{f=1;next} f&&/^ +[0-9]+ http/{print \$2; exit}' | grep -qx '$(default_value packages.yml agent_host_gh_repo_url)'"
  check "keyring matches the pin" dexec "$PLAIN" "sha256sum $(default_value packages.yml agent_host_gh_keyring) | grep -q '^$pin '"
  for name in $names; do
    check "baseline package $name is installed" dexec "$PLAIN" "dpkg-query -W -f='\${db:Status-Abbrev}' $name | grep -q '^ii'"
  done
  manual=$(dexec "$PLAIN" 'apt-mark showmanual')
  for name in $names; do
    check "baseline package $name is marked manual" grep -qx "$name" <<<"$manual"
  done

  run "$PLAIN" packages-again --tags "$tags"
  recap_ok "packages second apply" 0
  run "$PLAIN" packages-check-again --tags "$tags" --check
  recap_ok "packages second --check" 0

  dexec "$PLAIN" "apt-mark auto $names >/dev/null"
  run "$PLAIN" packages-mark --tags "$tags"
  recap_ok "re-marking is silent (changed=0)" 0
  manual=$(dexec "$PLAIN" 'apt-mark showmanual')
  for name in $names; do
    check "apt flipped $name back to manual" grep -qx "$name" <<<"$manual"
  done

  dexec "$PLAIN" "rm /etc/apt/sources.list.d/github-cli.list"
  run "$PLAIN" packages-source --tags "$tags"
  recap_ok "a deleted apt source is restored" '[1-9][0-9]*'
  run "$PLAIN" packages-source-again --tags "$tags"
  recap_ok "after the restore the next run is idle" 0

  run "$PLAIN" packages-off --tags "$tags" -e '{"agent_host_gh_enabled": false}' --check
  recap_ok "gh switched off, --check" 0
}

locale_half() {
  local tags=agent_host_locale
  if [ -z "${LAB_LOCALE:-}" ]; then
    echo "SKIP locale opt-in (LAB_LOCALE is not set)"
    return
  fi
  if ! [[ $LAB_LOCALE =~ ^[A-Za-z_]+\.UTF-8$ ]]; then
    fail "LAB_LOCALE must look like xx_YY.UTF-8"
    return
  fi
  local extra="{\"agent_host_locale_extra\": [\"$LAB_LOCALE\"]}" listed=${LAB_LOCALE%.UTF-8}.utf8

  run "$PLAIN" locale-check --tags "$tags" -e "$extra" --check --diff
  recap_ok "locale opt-in --check" '[1-9][0-9]*'
  check "locale not generated by --check" dexec "$PLAIN" "! locale -a | grep -qx '$listed'"

  run "$PLAIN" locale-apply --tags "$tags" -e "$extra"
  recap_ok "locale opt-in apply" '[1-9][0-9]*'
  check "locale is listed" dexec "$PLAIN" "locale -a | grep -qx '$listed'"
  check "the locale has a UTF-8 charmap" dexec "$PLAIN" "[ \"\$(LC_ALL=$LAB_LOCALE locale charmap)\" = UTF-8 ]"

  run "$PLAIN" locale-again --tags "$tags" -e "$extra"
  recap_ok "locale second apply" 0
  run "$PLAIN" locale-check-again --tags "$tags" -e "$extra" --check
  recap_ok "locale second --check" 0
}

gauge_files_half() {
  local tags=agent_host_reporting skip=agent_host_live
  local prom=$TEXTFILE/agent_host_reboot.prom script=$GAUGE_DIR/reboot-gauge.sh

  dexec "$PLAIN" "mkdir -p $TEXTFILE"

  run "$PLAIN" gauge-check --tags "$tags" --skip-tags "$skip" --check --diff
  recap_ok "gauge --check on a host without units" 7
  run "$PLAIN" gauge-apply --tags "$tags" --skip-tags "$skip"
  recap_ok "gauge files apply" 7
  check "script is 755 root" dexec "$PLAIN" "[ \"\$(stat -c '%a %U' $script)\" = '755 root' ]"
  check "service unit names the script" dexec "$PLAIN" "grep -qx 'ExecStart=$script' /etc/systemd/system/agent-host-reboot-gauge.service"
  check "service unit is sandboxed to the textfile directory" dexec "$PLAIN" "grep -qx 'ReadWritePaths=$TEXTFILE' /etc/systemd/system/agent-host-reboot-gauge.service"
  check "timer unit carries the interval" dexec "$PLAIN" "grep -qx 'OnUnitActiveSec=5min' /etc/systemd/system/agent-host-reboot-gauge.timer"
  run "$PLAIN" gauge-again --tags "$tags" --skip-tags "$skip"
  recap_ok "gauge second apply" 0
  run "$PLAIN" gauge-check-again --tags "$tags" --skip-tags "$skip" --check
  recap_ok "gauge second --check" 0

  dexec "$PLAIN" "AGENT_HOST_TEXTFILE_DIR=$TEXTFILE AGENT_HOST_REBOOT_FLAG=/nonexistent $script"
  check "gauge file is 644 root" dexec "$PLAIN" "[ \"\$(stat -c '%a %U' $prom)\" = '644 root' ]"
  check "gauge reads 0 without the flag" dexec "$PLAIN" "grep -qx 'agent_host_reboot_required 0' $prom"
  dexec "$PLAIN" "touch /tmp/reboot-required && AGENT_HOST_TEXTFILE_DIR=$TEXTFILE AGENT_HOST_REBOOT_FLAG=/tmp/reboot-required $script"
  check "gauge reads 1 with the flag" dexec "$PLAIN" "grep -qx 'agent_host_reboot_required 1' $prom"
  check "no temporary file is left" dexec "$PLAIN" "[ -z \"\$(find $TEXTFILE -name '.agent_host_reboot.*')\" ]"
  check "only the one .prom file exists" dexec "$PLAIN" "[ \"\$(ls $TEXTFILE | wc -l)\" = 1 ]"

  settings_script_half

  run "$PLAIN" settings-interval --tags "$tags" --skip-tags "$skip" -e agent_host_reporting_settings_interval_seconds=300
  recap_ok "a new settings interval changes only the settings timer" 1
  check "settings timer carries the new interval" dexec "$PLAIN" "grep -qx 'OnUnitActiveSec=300s' /etc/systemd/system/agent-host-settings-gauge.timer"
  run "$PLAIN" settings-interval-restore --tags "$tags" --skip-tags "$skip"
  recap_ok "the default settings interval is restored" 1
  run "$PLAIN" settings-interval-bad --tags "$tags" --skip-tags "$skip" -e agent_host_reporting_settings_interval_seconds=5
  if printf '%s' "$RECAP" | grep -Eq 'failed=1 '; then
    pass "an interval under 30 seconds is refused"
  else
    fail "an interval under 30 seconds is refused ($RECAP)"
  fi
  run "$PLAIN" settings-interval-long --tags "$tags" --skip-tags "$skip" -e agent_host_reporting_settings_interval_seconds=301
  if printf '%s' "$RECAP" | grep -Eq 'failed=1 '; then
    pass "an interval over 300 seconds is refused"
  else
    fail "an interval over 300 seconds is refused ($RECAP)"
  fi

  settings_lean_half

  run "$PLAIN" gauge-interval --tags "$tags" --skip-tags "$skip" -e agent_host_reporting_gauge_interval=10min
  recap_ok "a new interval changes only the timer" 1
  check "timer carries the new interval" dexec "$PLAIN" "grep -qx 'OnUnitActiveSec=10min' /etc/systemd/system/agent-host-reboot-gauge.timer"
  run "$PLAIN" gauge-restore --tags "$tags" --skip-tags "$skip"
  recap_ok "the default interval is restored" 1

  settings_removal_half

  run "$PLAIN" gauge-off-check --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false}' --check
  recap_ok "gauge removal --check" 1
  run "$PLAIN" gauge-off --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false}'
  recap_ok "gauge removal" 1
  check "gauge files are gone" dexec "$PLAIN" "[ ! -e $script ] && [ ! -e $prom ] && [ ! -e /etc/systemd/system/agent-host-reboot-gauge.timer ] && [ ! -e /etc/systemd/system/agent-host-reboot-gauge.service ]"
  check "the settings gauge is untouched by the reboot gauge removal" dexec "$PLAIN" "[ -e $SETTINGS_SCRIPT ] && [ -e /etc/systemd/system/agent-host-settings-gauge.timer ]"
  run "$PLAIN" gauge-off-again --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false}'
  recap_ok "gauge removal is idempotent" 0

  dexec "$PLAIN" "rmdir $TEXTFILE && rmdir /var/lib/node_exporter"
  run "$PLAIN" gauge-nodir --tags "$tags" --skip-tags "$skip"
  if printf '%s' "$RECAP" | grep -Eq 'failed=1 ' && grep -q 'run the host_agent role first' "$SCRATCH/gauge-nodir.log"; then
    pass "a missing textfile directory stops the stage with a message"
  else
    fail "a missing textfile directory stops the stage with a message ($RECAP)"
  fi
  run "$PLAIN" gauge-both-off --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false, "agent_host_reporting_settings_enabled": false}'
  recap_ok "with both gauges off a missing textfile directory is not an error" 1
  check "both gauges are gone" dexec "$PLAIN" "[ ! -e $SETTINGS_SCRIPT ] && [ ! -e /etc/systemd/system/agent-host-settings-gauge.timer ] && [ ! -e $GAUGE_DIR/reboot-gauge.sh ]"
}

settings_fixture() {
  docker exec -i "$PLAIN" sh -c 'cat >/tmp/fx-build.sh' <<'EOF'
set -e
rm -rf /tmp/fx /tmp/fakebin
mkdir -p /tmp/fx/proc/sys/net/ipv4 /tmp/fx/proc/sys/fs/inotify /tmp/fx/sys/module/zswap/parameters
mkdir -p /tmp/fx/etc/ssh/sshd_config.d /tmp/fx/etc/security/limits.d /tmp/fakebin
mkdir -p /tmp/fx/lib/modules/6.8.0-9-generic /tmp/fx/lib/modules/6.8.0-10-generic /tmp/fx/lib/modules/6.10.0-1-generic
echo bbr >/tmp/fx/proc/sys/net/ipv4/tcp_congestion_control
echo 262144 >/tmp/fx/proc/sys/fs/inotify/max_user_watches
echo 512 >/tmp/fx/proc/sys/fs/inotify/max_user_instances
printf 'Filename\tType\tSize\tUsed\tPriority\n/swapfile file 4194304 0 -2\n' >/tmp/fx/proc/swaps
printf 'MemTotal:       16384 kB\nSwapTotal:    4194300 kB\nSwapFree:     4194300 kB\n' >/tmp/fx/proc/meminfo
echo Y >/tmp/fx/sys/module/zswap/parameters/enabled
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/tmp/fx/etc/ssh/sshd_config.d/00-no-password.conf
echo 'ubuntu soft nofile 65536' >/tmp/fx/etc/security/limits.d/60-agent-host.conf
printf 'authenticationmethods publickey\npasswordauthentication no\nclientaliveinterval 60\nclientalivecountmax 10\n' >/tmp/fx/sshd.out
printf 'agent-host-sshd-rollback.timer inactive\nagent-host-ufw-rollback.timer inactive\n' >/tmp/fx/timers
echo yes >/tmp/fx/linger
echo 'install ok installed' >/tmp/fx/mosh
cat >/tmp/fakebin/sshd <<'FAKE'
#!/bin/sh
cat /tmp/fx/sshd.out
FAKE
cat >/tmp/fakebin/systemctl <<'FAKE'
#!/bin/sh
awk -v u="$2" '$1 == u { print $2 }' /tmp/fx/timers
FAKE
cat >/tmp/fakebin/loginctl <<'FAKE'
#!/bin/sh
cat /tmp/fx/linger
FAKE
cat >/tmp/fakebin/dpkg-query <<'FAKE'
#!/bin/sh
cat /tmp/fx/mosh
FAKE
chmod 755 /tmp/fakebin/*
EOF
}

SETTINGS_OUT=""
settings_case() {
  local label=$1 want=$2 mutation=$3 zeros total
  SETTINGS_OUT=$(dexec "$PLAIN" "sh /tmp/fx-build.sh && $mutation && $SETTINGS_RUN && cat $SETTINGS_PROM" 2>&1) || {
    fail "settings gauge: $label (the script failed)"
    return
  }
  zeros=$(sed -n 's/^agent_host_setting_ok{setting="\([a-z_]*\)"} 0$/\1/p' <<<"$SETTINGS_OUT" | sort | paste -sd,)
  total=$(grep -c '^agent_host_setting_ok{' <<<"$SETTINGS_OUT" || true)
  if [ "$zeros" = "$want" ] && [ "$total" = 13 ]; then
    pass "settings gauge: $label"
  else
    fail "settings gauge: $label (zeros '$zeros', want '$want', series $total)"
  fi
}

settings_lean_half() {
  local tags=agent_host_reporting skip=agent_host_live
  local none='{"agent_host_sysctl_enabled": false, "agent_host_memory_enabled": false, "agent_host_ssh_enabled": false, "agent_host_firewall_enabled": false, "agent_host_network_enabled": false, "agent_host_limits_enabled": false, "agent_host_session_enabled": false}'
  local some='{"agent_host_memory_enabled": false, "agent_host_ssh_transport_enabled": false, "agent_host_sess_sysctl": {}, "agent_host_ssh_auth": {}}'

  run "$PLAIN" settings-none --tags "$tags" --skip-tags "$skip" -e "$none"
  recap_ok "with every owning stage off only the settings script changes" 1
  docker exec "$PLAIN" cat "$SETTINGS_SCRIPT" >"$SCRATCH/settings-none.sh"
  check "no setting is checked when every owning stage is off" test "$(grep -c '^check ' "$SCRATCH/settings-none.sh")" = 0
  check "the script with no setting is valid sh" sh -n "$SCRATCH/settings-none.sh"
  dexec "$PLAIN" "AGENT_HOST_TEXTFILE_DIR=$TEXTFILE $SETTINGS_SCRIPT"
  check "the file keeps the timestamp and kernel series and no setting series" dexec "$PLAIN" \
    "grep -q '^agent_host_settings_run_timestamp_seconds ' $SETTINGS_PROM && grep -q '^agent_host_kernel_info{' $SETTINGS_PROM && ! grep -q agent_host_setting_ok $SETTINGS_PROM"

  run "$PLAIN" settings-some --tags "$tags" --skip-tags "$skip" -e "$some"
  recap_ok "switching off some owners changes only the settings script" 1
  docker exec "$PLAIN" cat "$SETTINGS_SCRIPT" >"$SCRATCH/settings-some.sh"
  check "swap, zswap, keepalive, inotify and publickey are not checked without their owner" \
    test "$(grep -cE '^check (swap_active|zswap|ssh_keepalive|inotify_watches|inotify_instances|ssh_publickey_only) ' "$SCRATCH/settings-some.sh")" = 0
  check "the other seven settings are still checked" test "$(grep -c '^check ' "$SCRATCH/settings-some.sh")" = 7

  run "$PLAIN" settings-nokeys --tags "$tags" --skip-tags "$skip" -e '{"agent_host_net_sysctl": {}, "agent_host_ssh_transport": {}}'
  recap_ok "emptying the net sysctl and the ssh transport changes only the settings script" 1
  docker exec "$PLAIN" cat "$SETTINGS_SCRIPT" >"$SCRATCH/settings-nokeys.sh"
  check "congestion control and keepalive are not checked without their keys" \
    test "$(grep -cE '^check (congestion_control|ssh_keepalive) ' "$SCRATCH/settings-nokeys.sh")" = 0
  check "the script without those keys is valid sh" sh -n "$SCRATCH/settings-nokeys.sh"
  check "the script without those keys still checks the other eleven settings" \
    test "$(grep -c '^check ' "$SCRATCH/settings-nokeys.sh")" = 11

  run "$PLAIN" settings-absent --tags "$tags" --skip-tags "$skip" -e agent_host_mem_state=absent
  recap_ok "memory state absent changes only the settings script" 1
  docker exec "$PLAIN" cat "$SETTINGS_SCRIPT" >"$SCRATCH/settings-absent.sh"
  check "swap and zswap are not checked once the memory state is absent" \
    test "$(grep -cE '^check (swap_active|zswap) ' "$SCRATCH/settings-absent.sh")" = 0

  run "$PLAIN" settings-lean-restore --tags "$tags" --skip-tags "$skip"
  recap_ok "the default settings script is restored" 1
  run "$PLAIN" settings-lean-again --tags "$tags" --skip-tags "$skip"
  recap_ok "the restored settings script is idempotent" 0
  docker exec "$PLAIN" cat "$SETTINGS_SCRIPT" >"$SCRATCH/settings-default.sh"
  check "the script bounds sshd, systemctl, dpkg-query and loginctl with timeout" \
    test "$(grep -cE 'timeout 10 (sshd -T|systemctl is-active|dpkg-query -W|loginctl show-user)' "$SCRATCH/settings-default.sh")" -ge 4
  check "the service bounds a stalled run with TimeoutStartSec" \
    dexec "$PLAIN" "grep -qx 'TimeoutStartSec=60' /etc/systemd/system/agent-host-settings-gauge.service"
}

settings_removal_half() {
  local tags=agent_host_reporting skip=agent_host_live off='{"agent_host_reporting_settings_enabled": false}'

  run "$PLAIN" settings-off-check --tags "$tags" --skip-tags "$skip" -e "$off" --check
  recap_ok "settings gauge removal --check" 1
  run "$PLAIN" settings-off --tags "$tags" --skip-tags "$skip" -e "$off"
  recap_ok "settings gauge removal" 1
  check "settings gauge files are gone" dexec "$PLAIN" \
    "[ ! -e $SETTINGS_SCRIPT ] && [ ! -e $SETTINGS_PROM ] && [ ! -e /etc/systemd/system/agent-host-settings-gauge.timer ] && [ ! -e /etc/systemd/system/agent-host-settings-gauge.service ]"
  check "the reboot gauge is untouched by the settings removal" dexec "$PLAIN" \
    "[ -e $GAUGE_DIR/reboot-gauge.sh ] && [ -e $TEXTFILE/agent_host_reboot.prom ] && [ -e /etc/systemd/system/agent-host-reboot-gauge.timer ]"
  run "$PLAIN" settings-off-again --tags "$tags" --skip-tags "$skip" -e "$off"
  recap_ok "settings gauge removal is idempotent" 0
  run "$PLAIN" settings-on --tags "$tags" --skip-tags "$skip"
  recap_ok "the settings gauge comes back" 3
}

settings_script_half() {
  local kernel
  kernel=$(dexec "$PLAIN" 'uname -r')

  check "settings script is 755 root" dexec "$PLAIN" "[ \"\$(stat -c '%a %U' $SETTINGS_SCRIPT)\" = '755 root' ]"
  check "settings service unit names the script" dexec "$PLAIN" "grep -qx 'ExecStart=$SETTINGS_SCRIPT' /etc/systemd/system/agent-host-settings-gauge.service"
  check "settings service unit is sandboxed to the textfile directory" dexec "$PLAIN" "grep -qx 'ReadWritePaths=$TEXTFILE' /etc/systemd/system/agent-host-settings-gauge.service"
  check "settings timer unit runs every 120 seconds" dexec "$PLAIN" "grep -qx 'OnUnitActiveSec=120s' /etc/systemd/system/agent-host-settings-gauge.timer"
  check "settings timer unit starts after boot" dexec "$PLAIN" "grep -qx 'OnBootSec=30s' /etc/systemd/system/agent-host-settings-gauge.timer"
  docker exec "$PLAIN" cat "$SETTINGS_SCRIPT" >"$SCRATCH/settings-gauge.sh"
  check "settings script is valid sh" sh -n "$SCRATCH/settings-gauge.sh"
  if command -v shellcheck >/dev/null 2>&1; then
    check "settings script passes shellcheck" shellcheck -s sh "$SCRATCH/settings-gauge.sh"
  fi
  check "settings script checks the thirteen settings" test "$(grep -c '^check ' "$SCRATCH/settings-gauge.sh")" = 13

  settings_fixture
  settings_case "converged state reads 1 everywhere" "" true
  check "settings gauge file is 644 root" dexec "$PLAIN" "[ \"\$(stat -c '%a %U' $SETTINGS_PROM)\" = '644 root' ]"
  check "settings gauge leaves no temporary file" dexec "$PLAIN" "[ -z \"\$(find $TEXTFILE -name '.agent_host_settings.*')\" ]"
  check "settings gauge reports the running and the newest kernel by version order" \
    grep -qxF "agent_host_kernel_info{running=\"$kernel\",newest=\"6.10.0-1-generic\"} 1" <<<"$SETTINGS_OUT"
  check "settings gauge writes the run timestamp" \
    test "$(sed -n 's/^agent_host_settings_run_timestamp_seconds //p' <<<"$SETTINGS_OUT")" -ge "$(($(date +%s) - 30))"
  check "settings gauge declares each family once" \
    test "$(grep -c '^# TYPE ' <<<"$SETTINGS_OUT")" = 3
  if command -v promtool >/dev/null 2>&1; then
    check "settings gauge parses as Prometheus text format" promtool check metrics <<<"$SETTINGS_OUT"
  fi

  settings_case "a different congestion control reads 0" congestion_control "echo cubic >/tmp/fx/proc/sys/net/ipv4/tcp_congestion_control"
  settings_case "inotify watches below the role value read 0" inotify_watches "echo 8192 >/tmp/fx/proc/sys/fs/inotify/max_user_watches"
  settings_case "inotify watches above the role value read 1" "" "echo 1048576 >/tmp/fx/proc/sys/fs/inotify/max_user_watches"
  settings_case "inotify instances below the role value read 0" inotify_instances "echo 128 >/tmp/fx/proc/sys/fs/inotify/max_user_instances"
  settings_case "a swap file that is not listed reads 0" swap_active "printf 'Filename\tType\tSize\tUsed\tPriority\n' >/tmp/fx/proc/swaps"
  settings_case "another swap file reads 0" swap_active "printf 'Filename\tType\tSize\tUsed\tPriority\n/other file 4194304 0 -2\n' >/tmp/fx/proc/swaps"
  settings_case "a swap total one kilobyte short reads 0" swap_active "sed -i 's/4194300/4194299/' /tmp/fx/proc/meminfo"
  settings_case "zswap off reads 0" zswap "echo N >/tmp/fx/sys/module/zswap/parameters/enabled"
  settings_case "another authentication method reads 0" ssh_publickey_only "sed -i 's/^authenticationmethods .*/authenticationmethods any/' /tmp/fx/sshd.out"
  settings_case "password authentication on reads 0" ssh_password_off "sed -i 's/^passwordauthentication no/passwordauthentication yes/' /tmp/fx/sshd.out"
  settings_case "another keepalive interval reads 0" ssh_keepalive "sed -i 's/^clientaliveinterval 60/clientaliveinterval 0/' /tmp/fx/sshd.out"
  settings_case "another keepalive count reads 0" ssh_keepalive "sed -i 's/^clientalivecountmax 10/clientalivecountmax 3/' /tmp/fx/sshd.out"
  settings_case "a guard with one byte changed reads 0" ssh_guard_intact "printf 'PasswordAuthentication yes\nKbdInteractiveAuthentication no\n' >/tmp/fx/etc/ssh/sshd_config.d/00-no-password.conf"
  settings_case "a missing guard reads 0" ssh_guard_intact "rm /tmp/fx/etc/ssh/sshd_config.d/00-no-password.conf"
  settings_case "an armed sshd rollback timer reads 0" ssh_rollback_idle "sed -i 's/^agent-host-sshd-rollback.timer inactive/agent-host-sshd-rollback.timer active/' /tmp/fx/timers"
  settings_case "an armed ufw rollback timer reads 0" ssh_rollback_idle "sed -i 's/^agent-host-ufw-rollback.timer inactive/agent-host-ufw-rollback.timer active/' /tmp/fx/timers"
  settings_case "mosh removed reads 0" mosh_installed "echo 'deinstall ok config-files' >/tmp/fx/mosh"
  settings_case "another nofile limit reads 0" limits_nofile "echo 'ubuntu soft nofile 1024' >/tmp/fx/etc/security/limits.d/60-agent-host.conf"
  settings_case "a missing limits file reads 0" limits_nofile "rm /tmp/fx/etc/security/limits.d/60-agent-host.conf"
  settings_case "no linger reads 0" linger "echo no >/tmp/fx/linger"
  settings_case "a failing sshd -T reads 0 for the three settings that need it" ssh_keepalive,ssh_password_off,ssh_publickey_only \
    "printf '#!/bin/sh\nexit 255\n' >/tmp/fakebin/sshd"
  settings_case "two drifted settings read 0 together" congestion_control,zswap \
    "echo cubic >/tmp/fx/proc/sys/net/ipv4/tcp_congestion_control && echo N >/tmp/fx/sys/module/zswap/parameters/enabled"
  settings_case "missing sources read 0 and the run still completes" swap_active,zswap \
    "rm /tmp/fx/sys/module/zswap/parameters/enabled /tmp/fx/proc/swaps"

  dexec "$PLAIN" 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1; mkdir -p /run/sshd /etc/ssh/sshd_config.d'
  dexec "$PLAIN" "printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/00-no-password.conf; printf 'AuthenticationMethods publickey\n' >/etc/ssh/sshd_config.d/10-agent-host-auth.conf; printf 'ClientAliveInterval 60\nClientAliveCountMax 10\n' >/etc/ssh/sshd_config.d/11-agent-host-transport.conf"
  settings_case "the real sshd -T output matches the converged drop-ins" "" "rm /tmp/fakebin/sshd"
  settings_case "the real sshd -T output shows a changed keepalive" ssh_keepalive \
    "rm /tmp/fakebin/sshd && sed -i 's/^ClientAliveInterval 60/ClientAliveInterval 30/' /etc/ssh/sshd_config.d/11-agent-host-transport.conf"
  dexec "$PLAIN" "printf 'ClientAliveInterval 60\nClientAliveCountMax 10\n' >/etc/ssh/sshd_config.d/11-agent-host-transport.conf"
  settings_case "the real sshd -T output shows password authentication on" ssh_password_off \
    "rm /tmp/fakebin/sshd && printf 'PasswordAuthentication yes\n' >/etc/ssh/sshd_config.d/00-no-password.conf"
  dexec "$PLAIN" "printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/00-no-password.conf"
  settings_case "the real sshd -T without its runtime directory reads 0 and the run completes" ssh_keepalive,ssh_password_off,ssh_publickey_only \
    "rm /tmp/fakebin/sshd && rm -rf /run/sshd"

  check "the script completes against the real sources when sshd, loginctl and dpkg are absent or unhelpful" \
    dexec "$PLAIN" "rm -rf /run/sshd /tmp/fakebin; AGENT_HOST_TEXTFILE_DIR=$TEXTFILE $SETTINGS_SCRIPT && [ \"\$(grep -c '^agent_host_setting_ok{' $SETTINGS_PROM)\" = 13 ]"
  dexec "$PLAIN" 'rm -rf /tmp/fx /tmp/fakebin /tmp/fx-build.sh /etc/ssh/sshd_config.d/*'
}

systemd_half() {
  local tags=agent_host_reporting
  local prom=$TEXTFILE/agent_host_reboot.prom off='{"agent_host_reporting_gauge_enabled": false}'

  docker build -q -t "$IMAGE" - >/dev/null <<EOF
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv python3 python3-apt ca-certificates openssh-server >/dev/null && mkdir -p $TEXTFILE
EOF
  docker run -d --name "$SD" --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw "$IMAGE" /sbin/init >/dev/null
  dexec "$SD" 'systemctl is-system-running --wait >/dev/null 2>&1 || true'

  run "$SD" sd-check --tags "$tags" --check --diff
  recap_ok "systemd: --check on a host without units" 7
  run "$SD" sd-apply --tags "$tags"
  recap_ok "systemd: apply" '1[01]'
  check "systemd: timer is enabled" dexec "$SD" "[ \"\$(systemctl is-enabled agent-host-reboot-gauge.timer)\" = enabled ]"
  check "systemd: timer is active" dexec "$SD" "[ \"\$(systemctl is-active agent-host-reboot-gauge.timer)\" = active ]"
  check "systemd: gauge file is 644 root" dexec "$SD" "[ \"\$(stat -c '%a %U' $prom)\" = '644 root' ]"
  check "systemd: gauge reads 0" dexec "$SD" "grep -qx 'agent_host_reboot_required 0' $prom"
  check "systemd: service result is success" dexec "$SD" "systemctl show -p Result agent-host-reboot-gauge.service | grep -qx 'Result=success'"
  dexec "$SD" 'touch /run/reboot-required && systemctl start agent-host-reboot-gauge.service'
  check "systemd: gauge reads 1 with the flag" dexec "$SD" "grep -qx 'agent_host_reboot_required 1' $prom"
  dexec "$SD" 'rm /run/reboot-required && systemctl start agent-host-reboot-gauge.service'
  check "systemd: gauge reads 0 again" dexec "$SD" "grep -qx 'agent_host_reboot_required 0' $prom"

  check "systemd: settings timer is enabled" dexec "$SD" "[ \"\$(systemctl is-enabled agent-host-settings-gauge.timer)\" = enabled ]"
  check "systemd: settings timer is active" dexec "$SD" "[ \"\$(systemctl is-active agent-host-settings-gauge.timer)\" = active ]"
  check "systemd: settings gauge file is 644 root" dexec "$SD" "[ \"\$(stat -c '%a %U' $SETTINGS_PROM)\" = '644 root' ]"
  check "systemd: settings service result is success" dexec "$SD" "systemctl show -p Result agent-host-settings-gauge.service | grep -qx 'Result=success'"
  check "systemd: the settings gauge lists the settings the script checks" dexec "$SD" \
    "[ \"\$(sed -n 's/^agent_host_setting_ok{setting=\"\\([a-z_]*\\)\"}.*/\\1/p' $SETTINGS_PROM | sort | paste -sd,)\" = \"\$(awk '\$1 == \"check\" { print \$2 }' $SETTINGS_SCRIPT | sort | paste -sd,)\" ]"
  check "systemd: the settings gauge carries a fresh run timestamp" dexec "$SD" \
    "[ \$(( \$(date +%s) - \$(sed -n 's/^agent_host_settings_run_timestamp_seconds //p' $SETTINGS_PROM) )) -lt 60 ]"
  check "systemd: the settings gauge reports the running kernel" dexec "$SD" \
    "grep -q \"^agent_host_kernel_info{running=\\\"\$(uname -r)\\\",\" $SETTINGS_PROM"
  dexec "$SD" "mkdir -p /run/sshd /etc/ssh/sshd_config.d && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/00-no-password.conf && systemctl start agent-host-settings-gauge.service"
  check "systemd: sshd -T works inside the service sandbox (password off, guard intact)" dexec "$SD" \
    "grep -qx 'agent_host_setting_ok{setting=\"ssh_password_off\"} 1' $SETTINGS_PROM && grep -qx 'agent_host_setting_ok{setting=\"ssh_guard_intact\"} 1' $SETTINGS_PROM"
  check "systemd: a setting the host does not have reads 0 (no authentication drop-in)" dexec "$SD" \
    "grep -qx 'agent_host_setting_ok{setting=\"ssh_publickey_only\"} 0' $SETTINGS_PROM"
  run "$SD" sd-again --tags "$tags"
  recap_ok "systemd: second apply" 0
  run "$SD" sd-check-again --tags "$tags" --check
  recap_ok "systemd: second --check" 0

  dexec "$SD" "rm $prom"
  run "$SD" sd-regenerate --tags "$tags"
  recap_ok "systemd: a deleted gauge file is regenerated" 1
  check "systemd: gauge file is back" dexec "$SD" "test -s $prom"

  dexec "$SD" "rm $SETTINGS_PROM"
  run "$SD" sd-settings-regenerate --tags "$tags"
  recap_ok "systemd: a deleted settings gauge file is regenerated" 1
  check "systemd: settings gauge file is back" dexec "$SD" "test -s $SETTINGS_PROM"

  local stamp_before stamp_after
  stamp_before=$(dexec "$SD" "sed -n 's/^agent_host_settings_run_timestamp_seconds //p' $SETTINGS_PROM")
  dexec "$SD" 'sleep 1'
  run "$SD" sd-script-change --tags "$tags" -e agent_host_ssh_client_alive_interval=30
  recap_ok "systemd: a changed settings script re-runs the service at once" 2
  stamp_after=$(dexec "$SD" "sed -n 's/^agent_host_settings_run_timestamp_seconds //p' $SETTINGS_PROM")
  check "systemd: the settings gauge was rewritten after the script changed" test "$stamp_after" -gt "$stamp_before"
  run "$SD" sd-script-restore --tags "$tags"
  recap_ok "systemd: the default settings script is restored and re-run" 2

  run "$SD" sd-settings-interval --tags "$tags" -e agent_host_reporting_settings_interval_seconds=300
  recap_ok "systemd: a new settings interval restarts the settings timer" '[1-3]'
  check "systemd: settings timer carries the new interval" dexec "$SD" "systemctl cat agent-host-settings-gauge.timer | grep -qx 'OnUnitActiveSec=300s'"
  run "$SD" sd-settings-restore --tags "$tags"
  recap_ok "systemd: the default settings interval is restored" '[1-3]'

  run "$SD" sd-interval --tags "$tags" -e agent_host_reporting_gauge_interval=10min
  recap_ok "systemd: a new interval restarts the timer" '[1-3]'
  check "systemd: timer carries the new interval" dexec "$SD" "systemctl cat agent-host-reboot-gauge.timer | grep -qx 'OnUnitActiveSec=10min'"
  run "$SD" sd-restore --tags "$tags"
  recap_ok "systemd: the default interval is restored" '[1-3]'

  run "$SD" sd-off-check --tags "$tags" -e "$off" --check
  recap_ok "systemd: removal --check" '[1-9][0-9]*'
  run "$SD" sd-off --tags "$tags" -e "$off"
  recap_ok "systemd: removal" '[1-9][0-9]*'
  check "systemd: timer is gone" dexec "$SD" "[ \"\$(systemctl is-enabled agent-host-reboot-gauge.timer 2>&1)\" != enabled ] && ! systemctl list-timers --all --no-legend | grep -q agent-host-reboot-gauge"
  run "$SD" sd-off-again --tags "$tags" -e "$off"
  recap_ok "systemd: removal is idempotent" 0
  run "$SD" sd-off-check-again --tags "$tags" -e "$off" --check
  recap_ok "systemd: second removal --check" 0
  run "$SD" sd-on --tags "$tags"
  recap_ok "systemd: the gauge comes back" '[1-9][0-9]*'
  local settings_off='{"agent_host_reporting_settings_enabled": false}'
  run "$SD" sd-settings-off-check --tags "$tags" -e "$settings_off" --check
  recap_ok "systemd: settings gauge removal --check" '[1-9][0-9]*'
  run "$SD" sd-settings-off --tags "$tags" -e "$settings_off"
  recap_ok "systemd: settings gauge removal" '[1-9][0-9]*'
  check "systemd: settings timer is gone" dexec "$SD" "[ \"\$(systemctl is-enabled agent-host-settings-gauge.timer 2>&1)\" != enabled ] && ! systemctl list-timers --all --no-legend | grep -q agent-host-settings-gauge"
  check "systemd: settings gauge files are gone" dexec "$SD" "[ ! -e $SETTINGS_SCRIPT ] && [ ! -e $SETTINGS_PROM ]"
  run "$SD" sd-settings-off-again --tags "$tags" -e "$settings_off"
  recap_ok "systemd: settings gauge removal is idempotent" 0
  run "$SD" sd-settings-on --tags "$tags"
  recap_ok "systemd: the settings gauge comes back" '[1-9][0-9]*'
}

start_plain
packages_half
locale_half
gauge_files_half
if [ "$WITH_SYSTEMD" = 1 ]; then
  systemd_half
else
  echo "SKIP systemd half (pass --systemd to run it in a privileged container)"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "FAIL $FAILS assertion(s)"
  exit 1
fi
echo "PASS all assertions"
