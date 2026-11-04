# OVH VPS with Terraform

Defines the OVHcloud VPS for the vespiridion workloads as code: plan, datacenter, OS, SSH key and billing mode live in `terraform.tfvars`, and `make up` / `make down` order and terminate the server. Run everything from this directory.

The two servers that already exist in the OVH account (the main VPS and the stopped `vps-2025-model2` one) are not managed by the main configuration and must never be imported into it: the provider forces replacement when the `plan` block differs, so an import would plan to terminate production. The one exception is `make retire`, which imports the old server into the separate throwaway `retire/` root only to terminate it.

## Layout

| Path | Purpose |
|---|---|
| `terraform.tfvars` | The server spec. Committed on purpose; it holds no secrets. |
| `main.tf`, `variables.tf`, `outputs.tf` | Root configuration: provider, subsidiary lookup, SSH key, outputs. |
| `modules/ovh_vps/` | Reusable module around `ovh_vps` with input validation and mocked tests. |
| `scripts/ovh.sh` | Read-only signed API helper (`images`, `catalog`, `get PATH`). |
| `scripts/check-destructive.sh` | Blocks `make up` when the plan terminates or reinstalls a server. |
| `scripts/check-stock.sh` | Blocks `make up` when OVH reports the plan out of stock in the configured datacenter. |
| `scripts/backup-vps.sh`, `restore-vps.sh`, `resume-old.sh` | Cold backup of the current main VPS, restore onto the new one, rollback of the old one. |
| `scripts/cutover.sh`, `set-vault-var.sh` | Point `vault_main_vps_ip` at the new server and run the playbook. |
| `scripts/retire-old.sh`, `retire/` | Terminate the old server through a throwaway Terraform root. |
| `tests/migrate.sh` | Tests for the scripts above against fake hosts (part of `make test`). |
| `backend_override.tf.example` | Opt-in Cloudflare R2 state backend. |

## Commands

| Command | Effect |
|---|---|
| `make plan` | Read-only preview. |
| `make key` | Lists any right the API key lacks and the days left before it expires. |
| `make stock` | Says whether the configured datacenter has stock for the plan, and lists the ones that do. |
| `make up` | Checks the key and the stock, plans, runs the destructive-change guard, asks for `yes`, applies, writes `.generated/inventory.yml`. |
| `make down` | Checks the key, runs `terraform destroy` (asks for `yes`), removes the generated inventory. |
| `make status` / `make ssh` / `make ping` | Outputs, shell on the server, Ansible reachability. |
| `make catalog` / `make images` | Plan codes with prices; OS image UUIDs offered by a running VPS. |
| `make fmt` / `make validate` / `make test` | Formatting, validation, module and script tests (no API calls). |
| `make backup` | Cold backup of the current main VPS into `.backups/` (stops its containers). |
| `make migrate` | `cutover`, `restore` and `converge` in order. |
| `make cutover` / `make restore` / `make converge` | The three migration steps on their own. |
| `make jenkins` | Re-runs `jenkins-playbook.yml` so Jenkins deploys to the new server (restarts Jenkins). |
| `make resume-old` | Restarts the containers the last backup stopped on the old server. |
| `make retire` | Terminates the old server recorded by the last backup. |

Credentials are the four `OVH_*` variables in the repo's `local.env`; the Makefile exports only those.

## API key

The key (`OVH_*` in `local.env`, `vault_ovh_*` in the vault) has a fixed validity and its rights cannot be edited. After it expires Terraform can neither plan nor destroy, and a running server keeps billing until a new key exists. Rotate by creating a key with the same rules and updating both places.

The rules it needs are listed in `scripts/check-key.sh`, which `make up` and `make down` run first. A missing cart or order right would otherwise surface halfway through an order. The order flow also needs a default payment method on the account.

## What costs money or data

- `make up` places a real order. With the committed spec that is `vps-2027-model3` at 14.50 USD/month under `default` pricing. The `upfront6` and `upfront12` modes look like prepaid terms from their catalog names; that has not been verified.
- Editing `plan_code`, `datacenter`, `os`, `duration` or `pricing_mode` changes the `plan` block, which the provider treats as replace: terminate and order a new server with a new IP.
- Editing `image_id` or the SSH key reinstalls the server in place and wipes its disk.
- `check-destructive.sh` stops both cases unless `ALLOW_DESTRUCTIVE=1` is set.
- The provider saves state right after the order, before it reinstalls the OS. If that step fails (for example a wrong `image_id`), a paid server exists and is marked tainted, and the next plan wants to replace it. The guard stops that. The expected recovery, read from the provider source and not yet tried: `terraform untaint module.server.ovh_vps.this`, then `make images SERVICE=<new service name>`, put the right UUID in `image_id`, then `ALLOW_DESTRUCTIVE=1 make up`, which reinstalls in place.
- The pinned `image_id` was read from the live Singapore VPS-3 2027 server. Whether the same UUID is valid in Beauharnois is unverified, because no running server there could be queried. After the first `make up`, `make images SERVICE=<new service name>` shows what that server offers.
- Only Beauharnois (BHS, Quebec) is in the Americas. OVH offers no Latin America location for VPS, and the catalog query for the `US` subsidiary is rejected for this account. `make stock` showed that on 2026-11-04 only BHS had `vps-2027-model3` available; the rest, Singapore included, were out of stock.
- `make down` requests termination, then waits up to 30 minutes for the token OVH emails and confirms it. Whether billing stops at once is unverified: the older stopped VPS has `deleteAtExpiration: true` and ran until its expiry date, which suggests termination takes effect at the end of the paid period. A down/up cycle inside one month may therefore bill twice.
- Every rebuild gets a new IP.

## State

State is local (`terraform.tfstate`, gitignored). Losing it orphans a paid server. To keep it in R2, copy `backend_override.tf.example` to `backend_override.tf`, fill in the bucket and account id, then run `terraform init -migrate-state`. The Makefile maps `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from `local.env` to the variables the S3 backend reads.

## Handing the server to Ansible

`make up` writes `.generated/inventory.yml` with one host, `vespiridion`, using the `ubuntu` user, for ad-hoc use with `make ping`. The name cannot be `vps` or `jenkins`: `host_vars/vps.yml` would override the address, and `playbook.yml` would run `cloudflare_dns` and `dns` with the production IP. The real playbook runs against `vps`, whose address comes from `vault_main_vps_ip`; `make cutover` is the only thing here that changes it.

## Replacing the production server

The order that cannot strand production is: `make up`, `make backup`, `make migrate`, merge to `main`, `make jenkins`, verify, `make retire`. Singapore is out of stock, so there is no way back to an identical server once the old one is terminated. `make retire` still works first if you insist: it warns and asks for the old service name.

1. `make up` orders the replacement. The first run is also the first test of the `image_id` in Beauharnois.
2. `make backup` stops every container on the current server and copies all Docker volumes and `/opt` into `.backups/<timestamp>/`, then verifies the archives and checksums. Production is down from here until step 3 finishes. The directory holds the Vaultwarden database and TLS private keys, so it is mode 700 and gitignored. If the backup fails, it restarts what it stopped.
3. `make migrate` runs three steps you can also run alone:
   - `make cutover` waits for SSH, writes the new address into `vault_main_vps_ip`, and runs `playbook.yml`. It refuses without a backup of the current server unless `FRESH=1`. The playbook's `cloudflare_dns` role re-points the `ns1` glue record in Cloudflare at the new address and restarts Traefik so ACME retries.
   - `make restore` stops the containers on the new server, replaces the contents of every volume that exists on both servers, and extracts `/opt`. It refuses to run against the host that was backed up, and lists any backed-up volume the new server does not have.
   - `make converge` runs the playbook a second time, which re-renders every templated file and starts the stacks from the restored data (Zot comes back with its images, so the pulls succeed), then runs `tests/health-check.yml`.
4. Put the new `vault.yml` and the role changes on `main` through a branch or pull request, then run `make jenkins` with no build running. It restarts Jenkins so `VPS_HOST` points at the new server.
5. Check the services, then `make retire`. It terminates the old server through Terraform's own delete flow and prints the service's expiry and `deleteAtExpiration` afterwards, which shows whether termination is immediate.

Before and during this, `main` is the hazard:

- No push to `main`, and no `panel-secrets` edit, from `make backup` until step 4 is merged. `vps-deploy` runs `main`'s code and `main`'s `vault.yml`. While `main` holds the old address, it deploys to the old server and `cloudflare_dns` points `ns1` back at it.
- The Metabase and LLM changes must reach `main` before any push does, or `vps-deploy` runs the old roles and starts both again.
- `vault.yml` is encrypted whole, so it cannot be merged. A `panel-secrets` commit landing in the meantime means redoing one side by hand.

Rollback, before `make retire`:

- `make resume-old` starts exactly the containers the backup stopped.
- If the cutover already ran, also run `scripts/set-vault-var.sh vault_main_vps_ip <HOST_IP from .backups/latest/record.env>` and `ansible-playbook playbook.yml` from the repo root, and `make jenkins` again if it ran.
- After `make retire` there is no rollback. Whether OVH keeps the server until the end of the paid period is unverified.

Dates and limits:

- The current server was created on 2026-11-03, renews automatically on 2026-12-03, and the API key expires on 2026-12-04.
- None of these scripts has run against a real server. They are tested against fake hosts only (`make test`); the first real run is the first test of the SSH, `sudo`, Docker and tar behavior on OVH's Ubuntu image.
- Services that are not running on the current server (miplata, categorizer, decabot, brujula, huella) are not restored either. Their images are not in Zot until Jenkins or a manual push builds them.

## Disabled services

`metabase_enabled` and `llm_inference_enabled` in `group_vars/all.yml` are `false`. While off, the roles stop and remove the containers (volumes and the models directory stay), and Alloy, the alert rules and the health check skip them. To bring one back, set its flag to `true` and run `ansible-playbook playbook.yml --tags metabase` (or `llm_inference,monitoring`). The categorizer calls `llama-server`, so anything that needs the LLM fails while it is off.

After a migration the Metabase data exists only inside `.backups/<timestamp>/volumes.tar.gz` (the target has no such volume while Metabase is off). To restore it, enable Metabase, run its tag once so the volume exists, stop the stack, and extract just that member: `tar -xzpf volumes.tar.gz -C /var/lib/docker/volumes ./metabase_metabase_pgdata` on the server. Do not run `make restore` again, because it would overwrite every other volume with the old data.
