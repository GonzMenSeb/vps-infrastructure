#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

[ -f "$backups/latest/record.env" ] || fail "no backup record in $backups"
. "$backups/latest/record.env"
require_ip "$HOST_IP"

mapfile -t names <"$backups/latest/containers.txt"
[ "${#names[@]}" -gt 0 ] || fail "the backup recorded no running containers"

echo "Starting ${#names[@]} containers on $SERVICE_NAME ($HOST_IP): ${names[*]}"
remote "$HOST_IP" "docker start ${names[*]}"
