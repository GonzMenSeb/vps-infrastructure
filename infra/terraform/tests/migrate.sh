#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
scripts=$(cd "$here/../scripts" && pwd)
root=$(cd "$here/../../.." && pwd)

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

cat >"$T/bin/ssh" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case $1 in
    -o) shift 2 ;;
    *@*)
      host=${1#*@}
      shift
      break
      ;;
    *) shift ;;
  esac
done
case $host in
  10.0.0.1) dir=old ;;
  10.0.0.2) dir=new ;;
  *)
    echo "unknown host $host" >&2
    exit 255
    ;;
esac
cmd=${*//\/fakeroot/$FAKE_ROOT/$dir}
export FAKE_HOST_DIR=$FAKE_ROOT/$dir
exec bash -c "$cmd"
EOF

cat >"$T/bin/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -n ] && shift
exec "$@"
EOF

cat >"$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
state=$FAKE_HOST_DIR/running
touch "$state"
case $1 in
  ps) cat "$state" ;;
  stop)
    shift
    for n in "$@"; do sed -i "/^$n\$/d" "$state"; done
    ;;
  start)
    shift
    for n in "$@"; do grep -qx "$n" "$state" || echo "$n" >>"$state"; done
    ;;
  *)
    echo "fake docker: $*" >&2
    exit 1
    ;;
esac
EOF

cat >"$T/bin/ovh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = get ] || exit 2
case $2 in
  /vps) echo '["svc-new.vps.test","svc-old.vps.test"]' ;;
  /vps/svc-old.vps.test/ips) echo '["2001:db8::1","10.0.0.1"]' ;;
  /vps/svc-new.vps.test/ips) echo '["10.0.0.2"]' ;;
  /vps/svc-new.vps.test) echo '{"state":"running","zone":"z"}' ;;
  /vps/svc-old.vps.test) echo '{"state":"stopped","zone":"z"}' ;;
  /vps/svc-old.vps.test/serviceInfos)
    echo '{"status":"ok","expiration":"2026-12-03","renew":{"automatic":true,"deleteAtExpiration":false}}'
    ;;
  *) exit 1 ;;
esac
EOF
cat >"$T/bin/terraform" <<'EOF'
#!/usr/bin/env bash
shift
case $1 in
  output)
    case $3 in
      service_name) [ -n "${FAKE_TF_SERVICE:-}" ] && echo -n "$FAKE_TF_SERVICE" || exit 1 ;;
      ipv4) [ -n "${FAKE_TF_IP:-}" ] && echo -n "$FAKE_TF_IP" || exit 1 ;;
    esac
    ;;
  state) exit 1 ;;
  *) echo "terraform $*" >>"$FAKE_TF_LOG" ;;
esac
EOF
chmod +x "$T"/bin/*

export FAKE_ROOT=$T/hosts
export PATH="$T/bin:$PATH" OVH_SH=$T/bin/ovh BACKUP_DIR=$T/backups
export REMOTE_VOLUMES_ROOT=/fakeroot/vols REMOTE_OPT_ROOT=/fakeroot/opt ASSUME_YES=1

put() {
  mkdir -p "$(dirname "$1")"
  printf '%s' "$2" >"$1"
}
old=$FAKE_ROOT/old
new=$FAKE_ROOT/new
put "$old/vols/zot_zotdata/_data/blob" images
put "$old/vols/pdns_db/_data/db" zones
put "$old/vols/metabase_pgdata/_data/pg" dashboards
put "$old/vols/metadata.db" bolt
put "$old/opt/vaultwarden/data/db.sqlite3" secrets
put "$old/opt/containerd/state" skipme
put "$old/opt/dns/docker-compose.yml" old-ip
printf 'traefik\nzot\nvaultwarden\n' >"$old/running"
put "$new/vols/zot_zotdata/_data/fresh" x
put "$new/vols/pdns_db/_data/fresh" x
put "$new/vols/extra_vol/_data/keep" keepme
put "$new/opt/dns/docker-compose.yml" new-ip
printf 'traefik\npdns\n' >"$new/running"

passed=0
failed=0
ok() {
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: $what"
  fi
}
no() {
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then
    failed=$((failed + 1))
    echo "FAIL: $what"
  else
    passed=$((passed + 1))
  fi
}
has() { grep -qF -- "$1" "$2"; }
lacks() { ! grep -qF -- "$1" "$2"; }

MAIN_IP=10.0.0.1 "$scripts/backup-vps.sh" >"$T/backup.out" 2>&1 || cat "$T/backup.out"
latest=$BACKUP_DIR/latest
ok "backup is marked complete" test -f "$latest/COMPLETE"
ok "record names the old host" has HOST_IP=10.0.0.1 "$latest/record.env"
ok "record names the OVH service" has SERVICE_NAME=svc-old.vps.test "$latest/record.env"
ok "old containers are stopped" test ! -s "$old/running"
ok "container list recorded" has vaultwarden "$latest/containers.txt"
ok "opt archive holds vaultwarden data" has vaultwarden/data/db.sqlite3 "$latest/opt.list"
ok "opt archive skips containerd" lacks containerd "$latest/opt.list"
ok "volume archive skips metadata.db" lacks metadata.db "$latest/volumes.list"
ok "volume archive holds zot" has zot_zotdata/_data/blob "$latest/volumes.list"
ok "checksums verify" bash -c "cd '$latest' && sha256sum --quiet -c SHA256SUMS"
ok "backup directory is private" test "$(stat -L -c %a "$latest")" = 700

printf 'traefik\nzot\nvaultwarden\n' >"$old/running"
no "restore refuses the backed-up host" env MAIN_IP=10.0.0.1 "$scripts/restore-vps.sh"
ok "restore refusal leaves the old host untouched" test -s "$old/running"

MAIN_IP=10.0.0.2 "$scripts/restore-vps.sh" >"$T/restore.out" 2>&1 || cat "$T/restore.out"
ok "zot data restored" test "$(cat "$new/vols/zot_zotdata/_data/blob")" = images
ok "fresh zot file wiped" test ! -e "$new/vols/zot_zotdata/_data/fresh"
ok "pdns data restored" test "$(cat "$new/vols/pdns_db/_data/db")" = zones
ok "fresh pdns file wiped" test ! -e "$new/vols/pdns_db/_data/fresh"
ok "unrelated volume untouched" test "$(cat "$new/vols/extra_vol/_data/keep")" = keepme
ok "volume without a target is not created" test ! -e "$new/vols/metabase_pgdata"
ok "missing volume is reported" has "NOT restored" "$T/restore.out"
ok "missing volume is named" has metabase_pgdata "$T/restore.out"
ok "opt data restored" test "$(cat "$new/opt/vaultwarden/data/db.sqlite3")" = secrets
ok "opt templates overwritten for the next playbook run" test "$(cat "$new/opt/dns/docker-compose.yml")" = old-ip
ok "containerd not restored" test ! -e "$new/opt/containerd"
ok "target containers stay stopped" test ! -s "$new/running"

MAIN_IP=10.0.0.1 "$scripts/resume-old.sh" >/dev/null 2>&1 || true
ok "resume-old restarts the recorded containers" test "$(sort "$old/running" | tr '\n' ' ')" = "traefik vaultwarden zot "

printf 'traefik\nzot\n' >"$old/running"
no "failed backup exits non-zero" env MAIN_IP=10.0.0.1 BACKUP_DIR="$T/failed" REMOTE_OPT_ROOT=/fakeroot/missing "$scripts/backup-vps.sh"
ok "failed backup restarts what it stopped" test "$(sort "$old/running" | tr '\n' ' ')" = "traefik zot "
no "failed backup is never marked complete" bash -c "ls '$T'/failed/*/COMPLETE"

cp -a "$BACKUP_DIR" "$T/tampered"
echo x >>"$T/tampered/latest/opt.tar.gz"
no "restore refuses a tampered backup" env BACKUP_DIR="$T/tampered" MAIN_IP=10.0.0.2 "$scripts/restore-vps.sh"
no "retire refuses without a completed backup" env BACKUP_DIR="$T/empty" "$scripts/retire-old.sh"

export FAKE_TF_LOG=$T/terraform.log
: >"$FAKE_TF_LOG"
no "retire refuses the managed server" env FAKE_TF_SERVICE=svc-old.vps.test FAKE_TF_IP=10.0.0.1 "$scripts/retire-old.sh"
no "retire warns and stops without a replacement" env VAULT_FILE="$T/vault.yml" "$scripts/retire-old.sh" <<<"wrong"
ok "retire did not terminate anything" test ! -s "$FAKE_TF_LOG"
printf 'vault_main_vps_ip: "10.0.0.2"\n' >"$T/vault-new.yml"
(cd "$root" && ansible-vault encrypt "$T/vault-new.yml" >/dev/null 2>&1)
ok "retire runs once the replacement is live" env FAKE_TF_SERVICE=svc-new.vps.test FAKE_TF_IP=10.0.0.2 VAULT_FILE="$T/vault-new.yml" "$scripts/retire-old.sh"
ok "retire imports the old service into the throwaway root" has "import -input=false ovh_vps.old svc-old.vps.test" "$FAKE_TF_LOG"
ok "retire destroys it" has "destroy" "$FAKE_TF_LOG"
: >"$FAKE_TF_LOG"
ok "retire proceeds on the typed service name" env VAULT_FILE="$T/vault-new.yml" "$scripts/retire-old.sh" <<<"svc-old.vps.test"
ok "typed confirmation led to a termination" has "destroy" "$FAKE_TF_LOG"

stock=$T/stock.json
echo '{"datacenters":[{"datacenter":"BHS","linuxStatus":"available","windowsStatus":"out-of-stock"},{"datacenter":"SGP","linuxStatus":"out-of-stock","windowsStatus":"out-of-stock"}]}' >"$stock"
tfvars=$T/terraform.tfvars
printf 'plan_code = "vps-2027-model3"\ndatacenter = "BHS"\nos = "Ubuntu 26.04"\n' >"$tfvars"
ok "stock guard passes when available" env STOCK_JSON="$stock" TFVARS="$tfvars" "$scripts/check-stock.sh"
sed -i 's/BHS/SGP/' "$tfvars"
no "stock guard fails when out of stock" env STOCK_JSON="$stock" TFVARS="$tfvars" "$scripts/check-stock.sh"
sed -i 's/SGP/GRA/' "$tfvars"
no "stock guard fails when the datacenter is not offered" env STOCK_JSON="$stock" TFVARS="$tfvars" "$scripts/check-stock.sh"

printf 'vault_a: "1"\nvault_main_vps_ip: "10.0.0.1"\nvault_b: "x"\n' >"$T/vault.yml"
(cd "$root" && ansible-vault encrypt "$T/vault.yml" >/dev/null 2>&1)
export VAULT_FILE=$T/vault.yml
"$scripts/set-vault-var.sh" vault_main_vps_ip 10.0.0.9 >/dev/null
decrypted=$(cd "$root" && ansible-vault view "$T/vault.yml" 2>/dev/null)
ok "vault value updated" grep -qx 'vault_main_vps_ip: "10.0.0.9"' <<<"$decrypted"
ok "other vault values untouched" bash -c "grep -qx 'vault_a: \"1\"' <<<'$decrypted' && grep -qx 'vault_b: \"x\"' <<<'$decrypted'"
ok "vault stays encrypted" bash -c "head -1 '$T/vault.yml' | grep -q '^\$ANSIBLE_VAULT'"
no "vault editor rejects an unknown variable" "$scripts/set-vault-var.sh" vault_nope 10.0.0.1
no "vault editor rejects an unsafe value" "$scripts/set-vault-var.sh" vault_main_vps_ip '1.2.3.4"; evil'
ok "vault editor is idempotent" "$scripts/set-vault-var.sh" vault_main_vps_ip 10.0.0.9

echo "$passed passed, $failed failed"
[ "$failed" = 0 ]
