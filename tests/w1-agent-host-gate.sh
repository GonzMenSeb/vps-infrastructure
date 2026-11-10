#!/usr/bin/env bash
set -euo pipefail

SELF=$(realpath "${BASH_SOURCE[0]}")
cd "$(dirname "$SELF")/.."

PLAYBOOKS=(w1-playbook.yml w1-reboot-playbook.yml tests/w1-agent-host-check.yml tests/w1-agent-host-preflight.yml tests/w1-health-check.yml)
OPT_INS='{"agent_host_firewall_enabled": true, "agent_host_mem_earlyoom_enabled": true, "agent_host_fail2ban_enabled": true, "agent_host_locale_extra": ["x"]}'

IPV4_RE='(?<![0-9.])(?!(?:127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.[0-9]{1,3}|198\.51\.100\.[0-9]{1,3}|203\.0\.113\.[0-9]{1,3})(?![0-9.]))(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])'
EMAIL_RE='[A-Za-z0-9._+-]+@(?!(?:openssh\.com|libssh\.org)(?![A-Za-z0-9.-])|[0-9]+\.(?:service|scope|slice)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
HOME_RE='/home/(?!ubuntu(?![A-Za-z0-9_-]))[A-Za-z_][A-Za-z0-9_-]*'
# Character classes keep these words from matching this file's own added lines.
WORD_RE='es_C[O]|Colombi[a]|contab[o]|claudi[a]'

export ANSIBLE_NOCOWS=1 NO_COLOR=1

stage_tree() {
  local t=$GATE_TMP/tree d
  [ ! -d "$t" ] || return 0
  mkdir -p "$t"
  cp ansible.cfg w1-playbook.yml w1-reboot-playbook.yml "$t/"
  cp -r tests "$t/tests"
  ln -s "$PWD/roles" "$t/roles"
  for d in group_vars host_vars; do
    [ ! -d "$d" ] || ln -s "$PWD/$d" "$t/$d"
  done
  printf -- '---\nvault_w1_ip: gate\n' >"$t/vault.yml"
}

tree_ansible() {
  stage_tree
  (cd "$GATE_TMP/tree" && ANSIBLE_VAULT_PASSWORD_FILE=$GATE_TMP/vault-pass ansible-playbook -i 'w1,' "$@")
}

stage_engine_tree() {
  local dir=$1
  mkdir -p "$dir/tests"
  cp -r tests/w1-agent-host-check.yml tests/w1-agent-host-check-rows "$dir/tests/"
  [ ! -d tests/files ] || cp -r tests/files "$dir/tests/"
  printf -- '---\nvault_w1_ip: gate\n' >"$dir/vault.yml"
}

check_syntax() {
  local f
  for f in "${PLAYBOOKS[@]}"; do
    if ! tree_ansible --syntax-check "$f" >"$GATE_TMP/syntax.txt" 2>&1; then
      echo "syntax-check failed: $f"
      tail -n 10 "$GATE_TMP/syntax.txt"
      return 1
    fi
  done
}

check_lint() {
  local out
  out=$(ansible-lint "${PLAYBOOKS[@]}" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g') || true
  if ! grep -qF 'Passed: 0 failure(s), 0 warning(s)' <<<"$out"; then
    echo "ansible-lint did not report 0 failures and 0 warnings"
    tail -n 25 <<<"$out"
    return 1
  fi
  grep -E "^Passed: .*Profile 'min' was required" <<<"$out" | sed -E "s/(Profile 'min' was required).*/\\1/"
}

check_reboot_isolation() {
  local tasks=roles/agent_host/tasks hits more lt
  if grep -qE 'reboot' "$tasks/main.yml" w1-playbook.yml; then
    echo "the routine path references reboot:"
    grep -nE 'reboot' "$tasks/main.yml" w1-playbook.yml
    return 1
  fi
  hits=$(grep -rnE '^\s*(ansible\.builtin\.)?reboot:|shutdown|systemctl restart ssh|restart ssh\.socket|systemctl (try-)?restart (sshd|user@|systemd-logind)|meta: *(reset_connection|flush_handlers)|force_handlers' "$tasks" | grep -v "^$tasks/reboot.yml:" || true)
  more=$(grep -rnE '^\s*(ansible\.builtin\.)?reboot:|sysctl --system|daemon-reexec|daemon_reexec' roles/agent_host w1-playbook.yml | grep -v "^$tasks/reboot.yml:" || true)
  hits+=${more:+$'\n'$more}
  if [ -n "$hits" ]; then
    echo "forbidden construct outside reboot.yml:"
    echo "$hits"
    return 1
  fi
  python3 -I - <<'EOF'
import pathlib
import re
import sys

import yaml

forbidden = re.compile(r"^(ssh|sshd)(\.service|\.socket)?$|^user@")


def walk(items):
    for task in items or []:
        if isinstance(task, dict):
            yield task
            for key in ("block", "rescue", "always"):
                yield from walk(task.get(key))


bad = 0
for path in sorted(pathlib.Path("roles/agent_host/tasks").glob("*.yml")):
    if path.name == "reboot.yml":
        continue
    for task in walk(yaml.safe_load(path.read_text())):
        for key, value in task.items():
            if key.split(".")[-1] in ("systemd", "service", "systemd_service") and isinstance(value, dict):
                if value.get("state") == "restarted" and forbidden.match(str(value.get("name", ""))):
                    print(f"{path}: state restarted on {value.get('name')}")
                    bad = 1
sys.exit(bad)
EOF
  lt=$(tree_ansible w1-playbook.yml --tags agent_host --list-tasks 2>&1 | sed 's/\t.*//')
  if grep -qE '^ *agent_host : Reboot - ' <<<"$lt"; then
    echo "a Reboot - task is listed under --tags agent_host"
    return 1
  fi
  if grep -E '^ *agent_host : ' <<<"$lt" | grep -E 'ssh\.socket|user@|shutdown|restart ssh'; then
    echo "a task name carries a banned word"
    return 1
  fi
}

check_role_tag() {
  local all tagged missing
  all=$(tree_ansible w1-playbook.yml --list-tasks 2>&1 | sed 's/\t.*//' | grep -E '^ *agent_host : ' | sort || true)
  tagged=$(tree_ansible w1-playbook.yml --tags agent_host --list-tasks 2>&1 | sed 's/\t.*//' | grep -E '^ *agent_host : ' | sort || true)
  if [ -z "$all" ]; then
    echo "no agent_host task is listed"
    return 1
  fi
  missing=$(comm -23 <(printf '%s\n' "$all") <(printf '%s\n' "$tagged"))
  if [ -n "$missing" ]; then
    echo "tasks without the agent_host tag:"
    echo "$missing"
    return 1
  fi
}

check_diff_hygiene() {
  local forbidden
  [ -n "${BASE:-}" ] || { echo "no merge base"; return 1; }
  forbidden=$(git diff --name-only "$BASE"...HEAD | grep -P '^(vault\.yml|vault\.yml\.example|Jenkinsfile|playbook\.yml|jenkins-playbook\.yml|inventory\.yml|requirements\.yml|ansible\.cfg|\.ansible-lint|group_vars/|host_vars/|panel/|roles/(?!agent_host/))' || true)
  if [ -n "$forbidden" ]; then
    echo "paths outside this change's scope:"
    echo "$forbidden"
    return 1
  fi
}

pattern_cases() {
  local dot=. at=@ home=/home/ bad=0 case
  for case in "10${dot}0${dot}0${dot}1" "127${dot}0${dot}0${dot}12" "1${dot}2${dot}3${dot}4"; do
    grep -qP "$IPV4_RE" <<<"$case" || { echo "IPv4 pattern misses a bad case"; bad=1; }
  done
  for case in 127.0.0.1 0.0.0.0 192.0.2.1 198.51.100.7 203.0.113.9 6.8.0-147; do
    ! grep -qP "$IPV4_RE" <<<"$case" || { echo "IPv4 pattern flags $case"; bad=1; }
  done
  for case in "me${at}example.com" "a.b${at}corp.io" "x${at}openssh.com.evil.org" "foo${at}bar.service.evil.com"; do
    grep -qP "$EMAIL_RE" <<<"$case" || { echo "e-mail pattern misses a bad case"; bad=1; }
  done
  for case in "x@openssh.com" "um.user@1000.service.InvocationID" "user@0.service" "curve25519-sha256@libssh.org" "user@*" "ssh root@<w1-host>"; do
    ! grep -qP "$EMAIL_RE" <<<"$case" || { echo "e-mail pattern flags $case"; bad=1; }
  done
  grep -qP "$HOME_RE" <<<"${home}someone/x" || { echo "home pattern misses a bad case"; bad=1; }
  ! grep -qP "$HOME_RE" <<<"/home/ubuntu/.config" || { echo "home pattern flags the stock user"; bad=1; }
  for case in "es_C""O" "Colom""bia" "conta""bo" "clau""dia"; do
    grep -qiP "$WORD_RE" <<<"$case" || { echo "word pattern misses a bad case"; bad=1; }
  done
  ! grep -qiP "$WORD_RE" <<<"plain prose" || { echo "word pattern flags plain prose"; bad=1; }
  return "$bad"
}

check_identifier_hygiene() {
  local added hits=0
  [ -n "${BASE:-}" ] || { echo "no merge base"; return 1; }
  pattern_cases || return 1
  added=$(git diff -U0 "$BASE"...HEAD | grep '^+' | grep -v '^+++' || true)
  grep -nP "$IPV4_RE" <<<"$added" && hits=1
  grep -nP "$EMAIL_RE" <<<"$added" && hits=1
  grep -nP "$HOME_RE" <<<"$added" && hits=1
  grep -niP "$WORD_RE" <<<"$added" && hits=1
  [ "$hits" -eq 0 ] || { echo "identifier hygiene hits in added lines"; return 1; }
}

check_lab() {
  bash tests/w1-agent-host-lab.sh
}

check_selftest() {
  if [ "${GATE_VAULT:-0}" != 1 ]; then
    echo "the selftest loads vault.yml: export ANSIBLE_VAULT_PASSWORD_FILE or create .vault_pass"
    return 1
  fi
  bash tests/w1-agent-host-selftest.sh
}

check_syntax_helpers() {
  local f
  while IFS= read -r f; do
    bash -n "$f" || return 1
    if command -v shellcheck >/dev/null 2>&1; then
      shellcheck -s bash "$f" || return 1
    fi
  done < <(find tests -name '*.sh' | sort)
  local pys
  mapfile -t pys < <(find tests -name '*.py' | sort)
  if [ "${#pys[@]}" -gt 0 ]; then
    python3 -I -c 'import sys
for p in sys.argv[1:]:
    compile(open(p).read(), p, "exec")' "${pys[@]}"
    if command -v ruff >/dev/null 2>&1; then
      ruff check --no-cache --select F,E9 "${pys[@]}"
    fi
  fi
  python3 tests/w1-net-lab.py --dry-run >/dev/null
}

check_purity() {
  python3 -I tests/files/w1-agent-host-purity.py roles/agent_host/tasks
}

check_role_hygiene() {
  local d=roles/agent_host bad=0 out
  python3 -I - <<'EOF' || bad=1
import glob
import sys

import yaml


class Strict(yaml.SafeLoader):
    pass


def mapping(loader, node):
    keys = [loader.construct_object(k) for k, _ in node.value]
    dup = {k for k in keys if keys.count(k) > 1}
    if dup:
        raise yaml.constructor.ConstructorError(None, None, f"duplicate key {sorted(dup)}", node.start_mark)
    return loader.construct_mapping(node)


Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
seen = {}
bad = 0
for path in sorted(glob.glob("roles/agent_host/defaults/main/*.yml")):
    try:
        data = yaml.load(open(path), Loader=Strict) or {}
    except yaml.YAMLError as exc:
        print(f"{path}: {exc}")
        bad = 1
        continue
    for key in data:
        if key in seen:
            print(f"{key} is defined in {seen[key]} and {path}")
            bad = 1
        seen[key] = path
sys.exit(bad)
EOF
  [ ! -e "$d/handlers" ] || { echo "$d/handlers exists"; bad=1; }
  out=$(grep -rnE '^\s*agent_host_[A-Za-z0-9_]+\s*:' group_vars host_vars 2>/dev/null || true)
  [ -z "$out" ] || { echo "agent_host_ key outside the role defaults:"; echo "$out"; bad=1; }
  out=$(grep -rn 'vault_' "$d" || true)
  [ -z "$out" ] || { echo "vault variable in the role:"; echo "$out"; bad=1; }
  out=$(grep -rnE 'community\.general|ansible\.posix' "$d" tests || true)
  [ -z "$out" ] || { echo "collection outside builtin:"; echo "$out"; bad=1; }
  out=$(grep -rn 'notify:' "$d" || true)
  [ -z "$out" ] || { echo "notify in the role:"; echo "$out"; bad=1; }
  out=$(grep -rn '52agent-host' "$d" || true)
  [ -z "$out" ] || { echo "apt pin file in the role:"; echo "$out"; bad=1; }
  out=$(grep -rnE '^\s*(#|\{#)' "$d" | grep -vE ':1:#!' || true)
  [ -z "$out" ] || { echo "comment line in the role:"; echo "$out"; bad=1; }
  out=$(grep -rn 'ansible\.builtin\.' "$d" || true)
  [ -z "$out" ] || { echo "FQCN module name in the role:"; echo "$out"; bad=1; }
  out=$(grep -nE 'RUNNING[ ]HANDLER' CLAUDE.md README.md 2>/dev/null || true)
  [ -z "$out" ] || { echo "handler step in the runbook text:"; echo "$out"; bad=1; }
  return "$bad"
}

render_rows() {
  local out=$1
  shift
  cat >"$GATE_TMP/render.yml" <<'EOF'
---
- name: Render every rows variable
  hosts: all
  gather_facts: false
  tasks:
    - name: Load the role defaults
      include_role:
        name: agent_host
        tasks_from: load_defaults
        public: true

    - name: Load the rows files
      include_vars:
        dir: "{{ gate_rows_dir }}"

    - name: Name the rows variables
      set_fact:
        gate_names: "{{ vars | list | select('match', '^agent_host_check_rows_') | list }}"

    - name: Render the rows variables
      set_fact:
        gate_rows: "{{ gate_rows_json | from_json }}"
      vars:
        gate_rows_json: >-
          {%- set out = {} -%}
          {%- for n in gate_names -%}
          {%- set _ = out.update({n: lookup('ansible.builtin.vars', n)}) -%}
          {%- endfor -%}
          {{ out | to_json }}

    - name: Write the rendered rows
      copy:
        dest: "{{ gate_rows_out }}"
        content: "{{ gate_rows | to_json }}"
        mode: "0600"
EOF
  ansible-playbook -i 'w1,' -c local -e ansible_become=false -e ssh_allowed_users=ubuntu \
    -e "gate_rows_dir=$PWD/tests/w1-agent-host-check-rows" -e "gate_rows_out=$out" "$@" "$GATE_TMP/render.yml" >"$GATE_TMP/render.txt" 2>&1 || {
    echo "a rows file does not render:"
    tail -n 15 "$GATE_TMP/render.txt"
    return 1
  }
}

check_rows_contract() {
  render_rows "$GATE_TMP/rows-default.json"
  render_rows "$GATE_TMP/rows-optin.json" -e "$OPT_INS"
  python3 -I - "$GATE_TMP/rows-default.json" "$GATE_TMP/rows-optin.json" <<'EOF'
import glob
import json
import os
import re
import sys

import yaml

play = yaml.safe_load(open("tests/w1-agent-host-check.yml"))[0]["vars"]
domains_all = set(play["agent_host_row_domains_all"])
domains_known = domains_all | set(play["agent_host_row_domains_extra"])
bad = 0


def fail(message):
    global bad
    print(message)
    bad = 1


for path in sorted(glob.glob("tests/w1-agent-host-check-rows/*.yml")):
    base = os.path.basename(path)[:-4]
    keys = list((yaml.safe_load(open(path)) or {}).keys())
    rows_keys = [k for k in keys if k.startswith("agent_host_check_rows_")]
    if rows_keys != [f"agent_host_check_rows_{base}"]:
        fail(f"{path}: the rows variable must be exactly agent_host_check_rows_{base}, found {rows_keys}")
    if base not in domains_all:
        fail(f"{path}: {base} is not in agent_host_row_domains_all")
    for key in keys:
        if key not in rows_keys and not re.match(r"^agent_host_[a-z0-9]+_rows_", key):
            fail(f"{path}: unexpected top-level key {key}")

for report in sys.argv[1:]:
    rendered = json.load(open(report))
    for base_path in sorted(glob.glob("tests/w1-agent-host-check-rows/*.yml")):
        base = os.path.basename(base_path)[:-4]
        rows = rendered.get(f"agent_host_check_rows_{base}", [])
        if not isinstance(rows, list):
            fail(f"{base}: the rows variable does not render to a list")
            continue
        for row in rows:
            rid = row.get("id", "<no id>")
            for field in ("id", "severity", "cmp", "expect"):
                if field not in row:
                    fail(f"{base}/{rid}: missing {field}")
            if ("cmd" in row) == ("key" in row):
                fail(f"{base}/{rid}: needs exactly one of cmd or key")
            if row.get("domain", base) not in domains_known:
                fail(f"{base}/{rid}: unknown domain {row.get('domain')}")
sys.exit(bad)
EOF
}

check_rows_syntax() {
  local variant args
  stage_engine_tree "$GATE_TMP/engine"
  for variant in default optin; do
    args=()
    [ "$variant" = default ] || args=(-e "$OPT_INS")
    ansible-playbook -i 'w1,' -c local -e ansible_become=false -e ssh_allowed_users=ubuntu \
      -e agent_host_check_print_args=true "${args[@]}" "$GATE_TMP/engine/tests/w1-agent-host-check.yml" >"$GATE_TMP/args-$variant.txt" 2>&1 || {
      echo "the engine did not print its collector arguments ($variant)"
      tail -n 15 "$GATE_TMP/args-$variant.txt"
      return 1
    }
    python3 -I - "$GATE_TMP/args-$variant.txt" "$variant" <<'EOF'
import base64
import re
import subprocess
import sys

text = open(sys.argv[1]).read()
match = re.search(r"--rows-b64 '([A-Za-z0-9+/=]*)'", text)
if not match:
    print(f"no --rows-b64 argument in the engine output ({sys.argv[2]})")
    sys.exit(1)
rows = [r for r in base64.b64decode(match.group(1)).decode().split("\n") if r]
bad = 0
for row in rows:
    rid, sep, cmd = row.partition("\t")
    if not sep:
        print(f"{rid}: row without a tab separator")
        bad = 1
        continue
    proc = subprocess.run(["bash", "-n"], input=cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        print(f"{rid}: bash -n failed: {proc.stderr.strip()}")
        bad = 1
print(f"{len(rows)} rows decoded ({sys.argv[2]})")
sys.exit(bad)
EOF
  done
}

if [ "${1:-}" = --check ]; then
  : "${GATE_TMP:?}"
  "$2"
  exit
fi

CONTAINER=1
for arg in "$@"; do
  case $arg in
    --container) CONTAINER=1 ;;
    --no-container) CONTAINER=0 ;;
    *) echo "usage: $0 [--container|--no-container]" >&2; exit 2 ;;
  esac
done

GATE_TMP=$(mktemp -d)
trap 'rm -rf "$GATE_TMP"' EXIT
export GATE_TMP
echo unused >"$GATE_TMP/vault-pass"

GATE_VAULT=1
if [ -z "${ANSIBLE_VAULT_PASSWORD_FILE:-}" ] && [ ! -f .vault_pass ]; then
  export ANSIBLE_VAULT_PASSWORD_FILE=$GATE_TMP/vault-pass
  GATE_VAULT=0
fi
export GATE_VAULT

git fetch --quiet origin || echo "gate: git fetch failed, using the remote refs already present" >&2
BASE=${BASE:-$(git merge-base HEAD origin/feat/w1-monitoring 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || true)}
if [ -z "$BASE" ] || ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "gate: no merge base against origin/feat/w1-monitoring or origin/main; checks 5 and 6 will fail" >&2
  BASE=
fi
export BASE

FAILS=0
run_check() {
  local label=$1 fn=$2 out
  if out=$(bash "$SELF" --check "$fn" 2>&1); then
    echo "PASS $label"
    [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/     /'
  else
    echo "FAIL $label"
    printf '%s\n' "$out" | tail -n 40 | sed 's/^/     /'
    FAILS=$((FAILS + 1))
  fi
}

run_check "01 syntax-check of the five playbooks" check_syntax
run_check "02 ansible-lint, profile min, 0 failures" check_lint
run_check "03 reboot isolation" check_reboot_isolation
run_check "04 role tag on every task" check_role_tag
run_check "05 diff hygiene (paths)" check_diff_hygiene
run_check "06 identifier hygiene (added lines)" check_identifier_hygiene
if [ "$CONTAINER" -eq 1 ]; then
  run_check "07 container lab" check_lab
else
  echo "SKIP 07 container lab (--no-container)"
fi
run_check "08 selftest" check_selftest
run_check "09 shell and python helpers" check_syntax_helpers
run_check "10 task purity" check_purity
run_check "11 role hygiene greps" check_role_hygiene
run_check "12 rows-file contract" check_rows_contract
run_check "13 rendered-row syntax" check_rows_syntax

echo "gate failures: $FAILS"
[ "$FAILS" -eq 0 ]
