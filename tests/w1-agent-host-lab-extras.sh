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
  recap_ok "gauge --check on a host without units" 4
  run "$PLAIN" gauge-apply --tags "$tags" --skip-tags "$skip"
  recap_ok "gauge files apply" 4
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

  run "$PLAIN" gauge-interval --tags "$tags" --skip-tags "$skip" -e agent_host_reporting_gauge_interval=10min
  recap_ok "a new interval changes only the timer" 1
  check "timer carries the new interval" dexec "$PLAIN" "grep -qx 'OnUnitActiveSec=10min' /etc/systemd/system/agent-host-reboot-gauge.timer"
  run "$PLAIN" gauge-restore --tags "$tags" --skip-tags "$skip"
  recap_ok "the default interval is restored" 1

  run "$PLAIN" gauge-off-check --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false}' --check
  recap_ok "gauge removal --check" 1
  run "$PLAIN" gauge-off --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false}'
  recap_ok "gauge removal" 1
  check "gauge files are gone" dexec "$PLAIN" "[ ! -e $script ] && [ ! -e $prom ] && [ ! -e /etc/systemd/system/agent-host-reboot-gauge.timer ] && [ ! -e /etc/systemd/system/agent-host-reboot-gauge.service ]"
  run "$PLAIN" gauge-off-again --tags "$tags" --skip-tags "$skip" -e '{"agent_host_reporting_gauge_enabled": false}'
  recap_ok "gauge removal is idempotent" 0

  dexec "$PLAIN" "rmdir $TEXTFILE && rmdir /var/lib/node_exporter"
  run "$PLAIN" gauge-nodir --tags "$tags" --skip-tags "$skip"
  if printf '%s' "$RECAP" | grep -Eq 'failed=1 ' && grep -q 'run the host_agent role first' "$SCRATCH/gauge-nodir.log"; then
    pass "a missing textfile directory stops the stage with a message"
  else
    fail "a missing textfile directory stops the stage with a message ($RECAP)"
  fi
}

systemd_half() {
  local tags=agent_host_reporting
  local prom=$TEXTFILE/agent_host_reboot.prom off='{"agent_host_reporting_gauge_enabled": false}'

  docker build -q -t "$IMAGE" - >/dev/null <<EOF
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv python3 python3-apt ca-certificates >/dev/null && mkdir -p $TEXTFILE
EOF
  docker run -d --name "$SD" --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw "$IMAGE" /sbin/init >/dev/null
  dexec "$SD" 'systemctl is-system-running --wait >/dev/null 2>&1 || true'

  run "$SD" sd-check --tags "$tags" --check --diff
  recap_ok "systemd: --check on a host without units" 4
  run "$SD" sd-apply --tags "$tags"
  recap_ok "systemd: apply" '[5-6]'
  check "systemd: timer is enabled" dexec "$SD" "[ \"\$(systemctl is-enabled agent-host-reboot-gauge.timer)\" = enabled ]"
  check "systemd: timer is active" dexec "$SD" "[ \"\$(systemctl is-active agent-host-reboot-gauge.timer)\" = active ]"
  check "systemd: gauge file is 644 root" dexec "$SD" "[ \"\$(stat -c '%a %U' $prom)\" = '644 root' ]"
  check "systemd: gauge reads 0" dexec "$SD" "grep -qx 'agent_host_reboot_required 0' $prom"
  check "systemd: service result is success" dexec "$SD" "systemctl show -p Result agent-host-reboot-gauge.service | grep -qx 'Result=success'"
  dexec "$SD" 'touch /run/reboot-required && systemctl start agent-host-reboot-gauge.service'
  check "systemd: gauge reads 1 with the flag" dexec "$SD" "grep -qx 'agent_host_reboot_required 1' $prom"
  dexec "$SD" 'rm /run/reboot-required && systemctl start agent-host-reboot-gauge.service'
  check "systemd: gauge reads 0 again" dexec "$SD" "grep -qx 'agent_host_reboot_required 0' $prom"

  run "$SD" sd-again --tags "$tags"
  recap_ok "systemd: second apply" 0
  run "$SD" sd-check-again --tags "$tags" --check
  recap_ok "systemd: second --check" 0

  dexec "$SD" "rm $prom"
  run "$SD" sd-regenerate --tags "$tags"
  recap_ok "systemd: a deleted gauge file is regenerated" 1
  check "systemd: gauge file is back" dexec "$SD" "test -s $prom"

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
