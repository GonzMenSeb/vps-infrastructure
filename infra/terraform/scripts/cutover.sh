#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

new_ip=$(terraform -chdir="$infra" output -raw ipv4)
require_ip "$new_ip"
current=$(vault_var vault_main_vps_ip)
require_ip "$current"

if [ "$current" != "$new_ip" ] && [ "${FRESH:-}" != 1 ]; then
  require_backup
  . "$backups/latest/record.env"
  [ "$HOST_IP" = "$current" ] || fail "the backup is of $HOST_IP but the vault points at $current; run make backup again, or FRESH=1 make cutover to skip data"
fi

echo "Waiting for SSH on $new_ip"
for _ in $(seq 60); do
  remote "$new_ip" true 2>/dev/null && break
  sleep 10
done
remote "$new_ip" true || fail "cannot ssh to $ssh_user@$new_ip"

"$here/set-vault-var.sh" vault_main_vps_ip "$new_ip"

cd "$root"
ansible-playbook playbook.yml
