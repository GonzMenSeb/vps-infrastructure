#!/bin/sh
set -eu
export LC_ALL=C
dir=${AGENT_HOST_TEXTFILE_DIR:-/var/lib/node_exporter/textfile}
flag=${AGENT_HOST_REBOOT_FLAG:-/run/reboot-required}
tmp=$(mktemp "$dir/.agent_host_reboot.XXXXXX")
trap 'rm -f "$tmp"' EXIT
value=0
if [ -e "$flag" ]; then
  value=1
fi
printf '%s\n' '# HELP agent_host_reboot_required 1 when the reboot-required flag file exists.' '# TYPE agent_host_reboot_required gauge' "agent_host_reboot_required $value" >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$dir/agent_host_reboot.prom"
