#!/usr/bin/env bash
set -euo pipefail

name=${1:?usage: set-vault-var.sh NAME VALUE}
value=${2:?usage: set-vault-var.sh NAME VALUE}

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
vault=${VAULT_FILE:-$root/vault.yml}

[[ $name =~ ^vault_[a-z0-9_]+$ ]] || {
  echo "bad variable name: $name" >&2
  exit 1
}
[[ $value =~ ^[A-Za-z0-9._:-]+$ ]] || {
  echo "unsupported characters in value" >&2
  exit 1
}

umask 077
work=$(mktemp -d /dev/shm/vaultvar.XXXXXX)
trap 'rm -rf "$work"' EXIT

cd "$root"
ansible-vault decrypt --output "$work/old.yml" "$vault" >/dev/null

matches=$(grep -cE "^$name:" "$work/old.yml" || true)
[ "$matches" = 1 ] || {
  echo "expected exactly one $name line, found $matches" >&2
  exit 1
}

sed -E "s/^($name: ).*/\1\"$value\"/" "$work/old.yml" >"$work/new.yml"

if cmp -s "$work/old.yml" "$work/new.yml"; then
  echo "$name already has that value"
  exit 0
fi

changed=$({ diff "$work/old.yml" "$work/new.yml" || true; } | grep -c '^>' || true)
[ "$changed" = 1 ] || {
  echo "expected one changed line, got $changed" >&2
  exit 1
}

python3 -I - "$work/old.yml" "$work/new.yml" "$name" "$value" <<'PY'
import sys, yaml
old, new = (yaml.safe_load(open(p)) for p in sys.argv[1:3])
name, value = sys.argv[3:5]
assert old.keys() == new.keys(), "key set changed"
assert new[name] == value, "value not applied"
assert all(old[k] == new[k] for k in old if k != name), "another value changed"
PY

cp "$work/new.yml" "$work/enc.yml"
ansible-vault encrypt "$work/enc.yml" >/dev/null
ansible-vault decrypt --output "$work/roundtrip.yml" "$work/enc.yml" >/dev/null
cmp "$work/new.yml" "$work/roundtrip.yml"

cat "$work/enc.yml" >"$vault"
echo "$name updated"
