#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)

required=(
  "GET /me"
  "GET /me/payment/method"
  "POST /order/cart"
  "GET /order/cart/*"
  "POST /order/cart/*"
  "GET /me/order/*"
  "POST /me/order/*/pay"
  "POST /me/order/*/payWithRegisteredPaymentMean"
  "GET /me/notification/email/history"
  "GET /me/notification/email/history/*"
  "GET /vps"
  "GET /vps/*"
  "POST /vps/*"
  "PUT /vps/*"
)

if [ -n "${CREDENTIAL_JSON:-}" ]; then
  credential=$(cat "$CREDENTIAL_JSON")
else
  credential=$("$here/ovh.sh" get /auth/currentCredential)
fi

status=$(jq -r .status <<<"$credential")
expiration=$(jq -r '.expiration // empty' <<<"$credential")
mapfile -t granted < <(jq -r '.rules[] | "\(.method) \(.path)"' <<<"$credential")

fail=0

if [ "$status" != validated ]; then
  echo "key status is $status, expected validated" >&2
  fail=1
fi

if [ -n "$expiration" ]; then
  remaining=$(($(date -d "$expiration" +%s) - $(date +%s)))
  if [ "$remaining" -le 0 ]; then
    echo "key expired on $expiration" >&2
    fail=1
  else
    echo "key expires $expiration ($((remaining / 86400)) days left)"
  fi
fi

for need in "${required[@]}"; do
  method=${need%% *}
  path=${need#* }
  found=0
  for rule in "${granted[@]}"; do
    [ "${rule%% *}" = "$method" ] || continue
    pattern=${rule#* }
    # shellcheck disable=SC2053
    if [[ $path == $pattern ]]; then
      found=1
      break
    fi
  done
  if [ "$found" != 1 ]; then
    echo "missing right: $need" >&2
    fail=1
  fi
done

exit "$fail"
