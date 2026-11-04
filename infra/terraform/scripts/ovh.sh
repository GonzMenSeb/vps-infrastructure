#!/usr/bin/env bash
set -euo pipefail

: "${OVH_ENDPOINT:?}" "${OVH_APPLICATION_KEY:?}" "${OVH_APPLICATION_SECRET:?}" "${OVH_CONSUMER_KEY:?}"

case "$OVH_ENDPOINT" in
  ovh-eu) base=https://eu.api.ovh.com/1.0 ;;
  ovh-ca) base=https://ca.api.ovh.com/1.0 ;;
  *)
    echo "unsupported OVH_ENDPOINT: $OVH_ENDPOINT" >&2
    exit 2
    ;;
esac

get() {
  local url ts sig
  url="$base$1"
  ts=$(curl -fsS "$base/auth/time")
  sig='$1$'$(printf '%s' "$OVH_APPLICATION_SECRET+$OVH_CONSUMER_KEY+GET+$url++$ts" | sha1sum | cut -d' ' -f1)
  curl -fsS "$url" \
    -H "X-Ovh-Application: $OVH_APPLICATION_KEY" \
    -H "X-Ovh-Consumer: $OVH_CONSUMER_KEY" \
    -H "X-Ovh-Timestamp: $ts" \
    -H "X-Ovh-Signature: $sig"
}

images() {
  local service=${1:-} candidate
  if [ -z "$service" ]; then
    for candidate in $(get /vps | jq -r '.[]'); do
      if [ "$(get "/vps/$candidate" | jq -r .state)" = running ]; then
        service=$candidate
        break
      fi
    done
  fi
  [ -n "$service" ] || {
    echo "no running VPS found; pass a service name" >&2
    exit 1
  }
  echo "images offered by $service" >&2
  for id in $(get "/vps/$service/images/available" | jq -r '.[]'); do
    get "/vps/$service/images/available/$id" | jq -r '[.name, .id] | @tsv'
  done | sort
}

catalog() {
  local subsidiary
  subsidiary=$(get /me | jq -r .ovhSubsidiary)
  curl -fsS "$base/order/catalog/public/vps?ovhSubsidiary=$subsidiary" | jq -r '
    .locale.currencyCode as $currency
    | .plans[]
    | select(.planCode | test("^vps-20[0-9]{2}-model[0-9]+$"))
    | [
        .planCode,
        .invoiceName,
        ([.pricings[]
          | select(.intervalUnit == "month" and .mode == "default" and (.capacities | index("renew")))
          | "\(.price / 100000000) \($currency)/month"] | first // "n/a")
      ]
    | @tsv' | sort
}

cmd=${1:-}
shift || true
case "$cmd" in
  get) get "$@" ;;
  images) images "$@" ;;
  catalog) catalog ;;
  *)
    echo "usage: $0 {get PATH | images [SERVICE] | catalog}" >&2
    exit 2
    ;;
esac
