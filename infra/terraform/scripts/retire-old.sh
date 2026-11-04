#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

require_backup
. "$backups/latest/record.env"

new_service=$(terraform -chdir="$infra" output -raw service_name 2>/dev/null || true)
new_ip=$(terraform -chdir="$infra" output -raw ipv4 2>/dev/null || true)
if [ -n "$new_service" ] && [ "$SERVICE_NAME" = "$new_service" ]; then
  fail "the backed-up server is the managed one; refusing to retire it"
fi

problems=()
if [ -z "$new_service" ]; then
  problems+=("no replacement server exists in the Terraform state (make up has not run)")
else
  [ "$(vault_var vault_main_vps_ip)" = "$new_ip" ] || problems+=("vault_main_vps_ip does not point at the replacement yet (make cutover)")
  [ "$("$ovh" get "/vps/$new_service" | jq -r .state)" = running ] || problems+=("the replacement server is not running")
fi

old=$("$ovh" get "/vps/$SERVICE_NAME") || fail "$SERVICE_NAME is not in this OVH account"
info=$("$ovh" get "/vps/$SERVICE_NAME/serviceInfos")

echo "Old server: $SERVICE_NAME ($HOST_IP), $(jq -r .zone <<<"$old"), state $(jq -r .state <<<"$old")"
echo "Paid until $(jq -r .expiration <<<"$info"), automatic renewal $(jq -r .renew.automatic <<<"$info")"
echo "Replacement: ${new_service:-none} ${new_ip:+($new_ip)}"

if [ "${#problems[@]}" -gt 0 ]; then
  printf 'WARNING: %s\n' "${problems[@]}" >&2
  echo "Retiring now can leave production without a working server, and Singapore is out of stock." >&2
  read -r -p "Type the old service name to continue anyway: " answer
  [ "$answer" = "$SERVICE_NAME" ] || exit 1
fi

echo "Terraform will request termination and wait for OVH's confirmation email."
retire=$infra/retire
terraform -chdir="$retire" init -input=false >/dev/null
if terraform -chdir="$retire" state list 2>/dev/null | grep -qx 'ovh_vps.old'; then
  terraform -chdir="$retire" state rm ovh_vps.old >/dev/null
fi
terraform -chdir="$retire" import -input=false ovh_vps.old "$SERVICE_NAME"
terraform -chdir="$retire" destroy

if after=$("$ovh" get "/vps/$SERVICE_NAME/serviceInfos" 2>/dev/null); then
  echo "After termination: status $(jq -r .status <<<"$after"), expiration $(jq -r .expiration <<<"$after"), deleteAtExpiration $(jq -r .renew.deleteAtExpiration <<<"$after"), automatic renewal $(jq -r .renew.automatic <<<"$after")"
else
  echo "After termination: $SERVICE_NAME is no longer in the account"
fi
