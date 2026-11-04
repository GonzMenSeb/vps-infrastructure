#!/usr/bin/env bash
set -euo pipefail

plan=${1:?usage: $0 PLAN_FILE}

destructive=$(terraform show -json "$plan" | jq -r '
  .resource_changes[]?
  | select(
      (.change.actions | index("delete"))
      or (
        (.change.actions | index("update"))
        and (
          (.change.before.image_id != .change.after.image_id)
          or (.change.before.public_ssh_key != .change.after.public_ssh_key)
        )
      )
    )
  | "  \(.address): \(.change.actions | join(" + "))"')

if [ -n "$destructive" ] && [ "${ALLOW_DESTRUCTIVE:-0}" != 1 ]; then
  echo "This plan terminates or reinstalls a server:" >&2
  echo "$destructive" >&2
  echo "Re-run with ALLOW_DESTRUCTIVE=1 if that is intended." >&2
  exit 1
fi
