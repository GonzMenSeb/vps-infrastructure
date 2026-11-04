#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tfvars=${TFVARS:-$here/../terraform.tfvars}

tfvar() {
  sed -nE "s/^$1[[:space:]]*=[[:space:]]*\"(.*)\"[[:space:]]*$/\1/p" "$tfvars"
}

plan=$(tfvar plan_code)
datacenter=$(tfvar datacenter)
os=$(tfvar os)

if [ -n "${STOCK_JSON:-}" ]; then
  stock=$(cat "$STOCK_JSON")
else
  subsidiary=$("$here/ovh.sh" get /me | jq -r .ovhSubsidiary)
  stock=$("$here/ovh.sh" get "/vps/order/rule/datacenter?ovhSubsidiary=$subsidiary&planCode=$plan&os=${os// /%20}")
fi

field=linuxStatus
if [[ $os == Windows* ]]; then
  field=windowsStatus
fi

status=$(jq -r --arg dc "$datacenter" --arg f "$field" '.datacenters[] | select(.datacenter == $dc) | .[$f]' <<<"$stock")

if [ "$status" = available ]; then
  echo "$plan in $datacenter: available"
  exit 0
fi

alternatives=$(jq -r --arg f "$field" '[.datacenters[] | select(.[$f] == "available") | .datacenter] | join(", ")' <<<"$stock")
echo "$plan in $datacenter: ${status:-not offered}" >&2
echo "available now: ${alternatives:-none}" >&2
exit 1
