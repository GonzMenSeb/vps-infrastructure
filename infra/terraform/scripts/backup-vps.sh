#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

old_ip=${MAIN_IP:-$(vault_var vault_main_vps_ip)}
require_ip "$old_ip"
service=${SERVICE_NAME:-$(find_service "$old_ip")} || fail "no OVH VPS owns $old_ip"

ps_out=$(remote "$old_ip" "docker ps --format '{{.Names}}' | sort")
running=()
while IFS= read -r line; do
  if [ -n "$line" ]; then
    running+=("$line")
  fi
done <<<"$ps_out"
size=$(remote "$old_ip" "sudo du -sch $vol_root $opt_root 2>/dev/null | tail -1" | cut -f1)

echo "Backup source: $service ($old_ip)"
echo "Running containers (${#running[@]}): ${running[*]:-none}"
echo "Data to copy: about $size"
echo "Every running container is stopped first so the databases are copied consistently."
if [ "${ASSUME_YES:-}" != 1 ]; then
  read -r -p "Type yes to stop them and take the backup: " answer
  [ "$answer" = yes ] || exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest=$backups/$stamp
umask 077
mkdir -p "$backups" "$dest"
printf '%s\n' "${running[@]}" >"$dest/containers.txt"

restart_stopped() {
  echo "Backup failed: restarting the containers that were stopped" >&2
  if [ "${#running[@]}" -gt 0 ]; then
    remote "$old_ip" "docker start ${running[*]}" >/dev/null || echo "Restart failed; run make resume-old" >&2
  fi
}
on_exit() {
  local rc=$?
  [ "$rc" = 0 ] || restart_stopped
}
trap on_exit EXIT

if [ "${#running[@]}" -gt 0 ]; then
  remote "$old_ip" "docker stop ${running[*]}" >/dev/null
fi

remote "$old_ip" "sudo tar --numeric-owner -czpf - -C $vol_root --exclude=./metadata.db --exclude=./backingFsBlockDev ." >"$dest/volumes.tar.gz"
remote "$old_ip" "sudo tar --numeric-owner -czpf - -C $opt_root --exclude=./containerd ." >"$dest/opt.tar.gz"

for part in volumes opt; do
  gzip -t "$dest/$part.tar.gz"
  tar -tzf "$dest/$part.tar.gz" >"$dest/$part.list"
  [ -s "$dest/$part.list" ] || fail "$part archive is empty"
done

expected=$(remote "$old_ip" "ls -1 $vol_root | grep -vxE 'metadata.db|backingFsBlockDev' || true" | sort)
archived=$(awk -F/ 'NF >= 2 && $2 != "" {print $2}' "$dest/volumes.list" | sort -u)
[ "$expected" = "$archived" ] || fail "archived volumes differ from the volumes on the host"

(cd "$dest" && sha256sum volumes.tar.gz opt.tar.gz >SHA256SUMS)
cat >"$dest/record.env" <<EOF
HOST_IP=$old_ip
SERVICE_NAME=$service
CREATED=$stamp
EOF
touch "$dest/COMPLETE"
ln -sfn "$stamp" "$backups/latest"

echo "Backup complete: $dest"
echo "Volumes: $(echo "$archived" | tr '\n' ' ')"
echo "The old server's containers stay stopped. To roll back before retiring it, run make resume-old."
