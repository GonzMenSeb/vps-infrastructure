# shellcheck shell=bash disable=SC2034
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
infra=$(cd "$here/.." && pwd)
root=$(cd "$infra/../.." && pwd)

ssh_user=${SSH_USER:-ubuntu}
ssh_bin=${SSH_BIN:-ssh}
ovh=${OVH_SH:-$here/ovh.sh}
backups=${BACKUP_DIR:-$infra/.backups}
vol_root=${REMOTE_VOLUMES_ROOT:-/var/lib/docker/volumes}
opt_root=${REMOTE_OPT_ROOT:-/opt}

fail() {
  echo "$*" >&2
  exit 1
}

vault_var() {
  (cd "$root" && ansible-vault view "${VAULT_FILE:-vault.yml}") | sed -nE "s/^$1: \"?([^\"]*)\"?$/\1/p"
}

remote() {
  local host=$1
  shift
  "$ssh_bin" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$ssh_user@$host" "$@"
}

find_service() {
  local service
  for service in $("$ovh" get /vps | jq -r '.[]'); do
    if "$ovh" get "/vps/$service/ips" | jq -e --arg ip "$1" 'index($ip)' >/dev/null; then
      echo "$service"
      return 0
    fi
  done
  return 1
}

require_ip() {
  [[ $1 =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail "not an IPv4 address: $1"
}

require_backup() {
  [ -f "$backups/latest/COMPLETE" ] || fail "no completed backup in $backups; run make backup first"
  (cd "$backups/latest" && sha256sum --quiet -c SHA256SUMS) || fail "backup checksums do not match"
}

backed_up_volumes() {
  awk -F/ 'NF >= 2 && $2 != "" {print $2}' "$backups/latest/volumes.list" | sort -u
}
