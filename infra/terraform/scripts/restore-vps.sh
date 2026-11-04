#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

require_backup
. "$backups/latest/record.env"

target=${MAIN_IP:-$(vault_var vault_main_vps_ip)}
require_ip "$target"
[ "$target" != "$HOST_IP" ] || fail "vault_main_vps_ip still points at the backed-up server ($HOST_IP); run make cutover first"
remote "$target" "sudo -n true" || fail "cannot reach $target with passwordless sudo"

present=$(remote "$target" "ls -1 $vol_root")
restorable=()
missing=()
while IFS= read -r vol; do
  [ -n "$vol" ] || continue
  [[ $vol =~ ^[A-Za-z0-9_.-]+$ ]] || fail "unexpected volume name in the backup: $vol"
  if grep -qxF "$vol" <<<"$present"; then
    restorable+=("$vol")
  else
    missing+=("$vol")
  fi
done <<<"$(backed_up_volumes)"

echo "Backup: $backups/latest (from $SERVICE_NAME, $HOST_IP, $CREATED)"
echo "Target: $target"
echo "Volumes whose contents will be replaced (${#restorable[@]}): ${restorable[*]:-none}"
echo "Files under $opt_root are overwritten from the backup; the next playbook run re-renders every templated file."
echo "All running containers on the target are stopped first and stay stopped until make converge."
if [ "${ASSUME_YES:-}" != 1 ]; then
  read -r -p "Type yes to restore onto $target: " answer
  [ "$answer" = yes ] || exit 1
fi

remote "$target" 'ids=$(docker ps -q); if [ -n "$ids" ]; then docker stop $ids >/dev/null; fi'

if [ "${#restorable[@]}" -gt 0 ]; then
  members=()
  for vol in "${restorable[@]}"; do
    remote "$target" "sudo find $vol_root/$vol/_data -mindepth 1 -delete"
    members+=("./$vol")
  done
  remote "$target" "sudo tar --numeric-owner -xzpf - -C $vol_root ${members[*]}" <"$backups/latest/volumes.tar.gz"
fi
remote "$target" "sudo tar --numeric-owner -xzpf - -C $opt_root" <"$backups/latest/opt.tar.gz"

echo "Restored ${#restorable[@]} volumes and $opt_root onto $target."
if [ "${#missing[@]}" -gt 0 ]; then
  echo "NOT restored, no matching volume on the target (still in the backup): ${missing[*]}" >&2
  echo "If any of these should be live, run make converge so Ansible creates them, then make restore again." >&2
fi
echo "Next: make converge"
