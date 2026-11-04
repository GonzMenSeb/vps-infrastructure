#!/usr/bin/env bash
# Edits exactly one top-level key of vault.yml (or of group_vars/all.yml for hash vars),
# commits it with a message that names only the variable, and pushes to main.
# The value is read from VAR_VALUE and never appears in argv, logs, commits or messages.
set +x
set -euo pipefail
umask 077
LC_ALL=C

die() {
  echo "panel-secrets: $*" >&2
  exit 1
}

vault_die() {
  echo "panel-secrets: $*" >&2
  head -n 3 "$work/vault.err" >&2 || true
  exit 1
}

: "${VAR_NAME:?VAR_NAME is required}"
: "${VAR_VALUE:?VAR_VALUE is required}"
: "${VAULT_PASSWORD_FILE:?VAULT_PASSWORD_FILE is required}"
PANEL_SECRET_VARS="${PANEL_SECRET_VARS:-}"
PANEL_HASH_VARS="${PANEL_HASH_VARS:-}"
SHM_DIR="${SHM_DIR:-/dev/shm}"
WORK_DIR="${WORK_DIR:-.}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
VAULT_FILE="${VAULT_FILE:-vault.yml}"
GROUP_FILE="${GROUP_FILE:-group_vars/all.yml}"
PUSH_ATTEMPTS="${PUSH_ATTEMPTS:-3}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_PLAYBOOK="${VERIFY_PLAYBOOK:-$HERE/panel-secrets-verify.yml}"
VAULT_HEADER="\$ANSIBLE_VAULT;1.1;AES256"

[[ $VAR_NAME =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid variable name"
(( ${#VAR_NAME} <= 128 )) || die "invalid variable name"

in_list() {
  local needle=$1 item
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

read -r -a secret_vars <<<"$PANEL_SECRET_VARS"
read -r -a hash_vars <<<"$PANEL_HASH_VARS"
if in_list "$VAR_NAME" ${secret_vars[@]+"${secret_vars[@]}"}; then
  target=vault
elif in_list "$VAR_NAME" ${hash_vars[@]+"${hash_vars[@]}"}; then
  target=grouphash
else
  die "$VAR_NAME is not in the allowlist"
fi

(( ${#VAR_VALUE} >= 1 && ${#VAR_VALUE} <= 512 )) || die "the value must be 1 to 512 characters"
[[ $VAR_VALUE =~ ^[[:print:]]+$ ]] || die "the value must be printable ASCII on a single line"
[[ $VAR_VALUE != " "* && $VAR_VALUE != *" " ]] || die "the value must not start or end with a space"
case $VAR_VALUE in
  *'{{'* | *'{%'* | *'{#'*) die "the value must not contain Jinja delimiters" ;;
esac

safe_re='^[A-Za-z0-9._~+=:@%^*!?,/-]+$'
min_length=1
if [ "$target" = vault ]; then
  [[ $VAR_VALUE =~ $safe_re ]] || die "the value may only contain letters, digits and . _ ~ + = : @ % ^ * ! ? , / -"
  [ -n "${PANEL_SECRET_MIN+set}" ] || die "PANEL_SECRET_MIN is not set; run jenkins-playbook.yml so the job knows the minimum lengths"
  read -r -a min_entries <<<"$PANEL_SECRET_MIN"
  for entry in ${min_entries[@]+"${min_entries[@]}"}; do
    [[ $entry =~ ^([A-Za-z_][A-Za-z0-9_]*):([1-9][0-9]{0,3})$ ]] || die "malformed PANEL_SECRET_MIN entry"
    if [ "${BASH_REMATCH[1]}" = "$VAR_NAME" ] && (( BASH_REMATCH[2] > min_length )); then
      min_length=${BASH_REMATCH[2]}
    fi
  done
  (( ${#VAR_VALUE} >= min_length )) || die "the value for $VAR_NAME must be at least $min_length characters"
fi

export LC_ALL=C.UTF-8

if [ "$target" = grouphash ]; then
  [[ $VAR_VALUE =~ ^[A-Za-z0-9._-]{1,32}:\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || die "a hash variable needs a user:bcrypt line"
  stored=${VAR_VALUE//\$/\$\$}
  edit_file=$GROUP_FILE
else
  stored=$VAR_VALUE
  edit_file=$VAULT_FILE
fi

[ -d "$SHM_DIR" ] && [ -w "$SHM_DIR" ] && [ -x "$SHM_DIR" ] || die "$SHM_DIR is not usable; refusing to write the decrypted vault to disk"
work=$(mktemp -d "$SHM_DIR/panel-secrets.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Replaces the value of one top-level "key: scalar" line. Reads the value from
# EDIT_VALUE (never from argv, since awk -v would process backslash escapes) and
# fails unless the key occurs exactly once as a single-line scalar.
edit_key() {
  EDIT_KEY=$VAR_NAME EDIT_VALUE=$stored LC_ALL=C awk '
    function fail(msg) { print "panel-secrets: " msg > "/dev/stderr"; bad = 1; exit 1 }
    function esc(s,   i, c, out) {
      out = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\\" || c == "\"") out = out "\\"
        out = out c
      }
      return out
    }
    BEGIN { key = ENVIRON["EDIT_KEY"]; val = ENVIRON["EDIT_VALUE"]; n = 0; after = 0 }
    {
      if (after && $0 ~ /^[ \t]+[^ \t]/) fail("the key spans several lines")
      after = 0
      klen = length(key)
      if (substr($0, 1, klen + 1) == key ":" && (length($0) == klen + 1 || substr($0, klen + 2, 1) ~ /^[ \t]$/)) {
        n++
        rest = substr($0, klen + 2)
        p = 1
        while (substr(rest, p, 1) ~ /^[ \t]$/) p++
        c = substr(rest, p, 1)
        if (c == "\"") {
          q = p + 1
          while (q <= length(rest)) {
            d = substr(rest, q, 1)
            if (d == "\\") { q += 2; continue }
            if (d == "\"") break
            q++
          }
          if (q > length(rest)) fail("the key is not a single-line scalar")
          tail = substr(rest, q + 1)
        } else if (c == "\047") {
          q = p + 1
          while (q <= length(rest)) {
            d = substr(rest, q, 1)
            if (d == "\047") { if (substr(rest, q + 1, 1) == "\047") { q += 2; continue } break }
            q++
          }
          if (q > length(rest)) fail("the key is not a single-line scalar")
          tail = substr(rest, q + 1)
        } else if (c == "" || c == "|" || c == ">" || c == "[" || c == "{" || c == "&" || c == "*" || c == "!" || c == "#") {
          fail("the key is not a plain single-line scalar")
        } else {
          t = substr(rest, p)
          k = index(t, " #")
          v = (k > 0) ? substr(t, 1, k - 1) : t
          sub(/[ \t]+$/, "", v)
          tail = substr(t, length(v) + 1)
        }
        if (tail !~ /^[ \t]*(#.*)?$/) fail("unexpected text after the value")
        print key ":" substr(rest, 1, p - 1) "\"" esc(val) "\"" tail
        after = 1
        next
      }
      print
    }
    END { if (!bad && n != 1) { print "panel-secrets: the key must occur exactly once, found " n > "/dev/stderr"; exit 1 } }
  ' "$1"
}

changed_lines() {
  local n
  n=$(diff "$1" "$2" | grep -c '^[<>] ' || true)
  echo "$n"
}

sha256_of() {
  printf %s "$1" | sha256sum | cut -d' ' -f1
}

verify_value() {
  EXPECTED_SHA256=$(sha256_of "$stored") SECRET_NAME=$VAR_NAME ANSIBLE_LOCALHOST_WARNING=False \
    ANSIBLE_INVENTORY_UNPARSED_WARNING=False ANSIBLE_NOCOLOR=True \
    ansible-playbook -i localhost, -c local -e "plain_file=$1" "$VERIFY_PLAYBOOK" >/dev/null 2>"$work/verify.err" \
    || die "the edited file does not parse back to the requested value"
}

apply_edit() {
  local file="$WORK_DIR/$edit_file"
  [ -f "$file" ] || die "$edit_file is missing from the checkout"
  if [ "$target" = vault ]; then
    [ "$(head -n1 "$file")" = "$VAULT_HEADER" ] || die "$edit_file is not an AES256 vault"
    ansible-vault decrypt --vault-password-file "$VAULT_PASSWORD_FILE" --output "$work/old.yml" "$file" >/dev/null 2>"$work/vault.err" \
      || vault_die "could not decrypt $edit_file"
  else
    cp "$file" "$work/old.yml"
  fi
  edit_key "$work/old.yml" >"$work/new.yml" || die "could not edit $VAR_NAME in $edit_file"
  [ "$(wc -l <"$work/old.yml")" = "$(wc -l <"$work/new.yml")" ] || die "the edit changed the line count"
  local n
  n=$(changed_lines "$work/old.yml" "$work/new.yml")
  if [ "$n" = 0 ]; then
    unchanged=1
    return 0
  fi
  [ "$n" = 2 ] || die "the edit would change more than one line"
  verify_value "$work/new.yml"
  if [ "$target" = vault ]; then
    ansible-vault encrypt --vault-password-file "$VAULT_PASSWORD_FILE" --output "$work/new.vault" "$work/new.yml" >/dev/null 2>"$work/vault.err" \
      || vault_die "could not encrypt the edited vault"
    [ "$(head -n1 "$work/new.vault")" = "$VAULT_HEADER" ] || die "unexpected vault header after encrypting"
    ansible-vault decrypt --vault-password-file "$VAULT_PASSWORD_FILE" --output "$work/check.yml" "$work/new.vault" >/dev/null 2>"$work/vault.err" \
      || vault_die "the re-encrypted vault does not decrypt"
    cmp -s "$work/new.yml" "$work/check.yml" || die "the re-encrypted vault does not round-trip"
    [ "$(changed_lines "$work/old.yml" "$work/check.yml")" = 2 ] || die "the re-encrypted vault differs in more than one line"
    cp "$work/new.vault" "$file"
  else
    cp "$work/new.yml" "$file"
  fi
  rm -f "$work"/*.yml "$work"/new.vault
}

git_w() {
  git -C "$WORK_DIR" "$@"
}

result() {
  echo "$1"
  if [ -n "$OUTPUT_FILE" ]; then echo "$1" >"$OUTPUT_FILE"; fi
}

attempt=1
while :; do
  git_w fetch --quiet "$REMOTE" "$BRANCH" || die "could not fetch $REMOTE/$BRANCH"
  git_w reset --quiet --hard "$REMOTE/$BRANCH"
  git_w clean --quiet -fd

  unchanged=0
  apply_edit
  if [ "$unchanged" = 1 ]; then
    result "unchanged"
    exit 0
  fi

  git_w add -- "$edit_file"
  [ "$(git_w diff --cached --name-only)" = "$edit_file" ] || die "the commit would touch files other than $edit_file"
  [ -z "$(git_w status --porcelain --untracked-files=all | grep -v "^M  $edit_file\$" || true)" ] || die "the working tree has unexpected changes"
  git_w -c user.name="panel-secrets" -c user.email="panel-secrets@jenkins.invalid" commit --quiet \
    -m "Update $VAR_NAME via the admin panel" \
    -m "Applied by the panel-secrets Jenkins job. The value is not recorded here."
  sha=$(git_w rev-parse HEAD)
  if git_w push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH" 2>"$work/push.err"; then
    result "commit $sha"
    exit 0
  fi
  (( attempt < PUSH_ATTEMPTS )) || die "the push was rejected $attempt times; $BRANCH moved or is protected"
  attempt=$((attempt + 1))
  sleep "${PUSH_RETRY_SLEEP:-2}"
done
