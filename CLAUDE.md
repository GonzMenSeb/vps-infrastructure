# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Ansible Infrastructure-as-Code for two Ubuntu VPS hosts defined in `inventory.yml`:

- **`vps`** — the public web host (all user-facing services behind Traefik + Let's Encrypt).
- **`jenkins`** — a separate CI/CD host that builds app images and deploys back to `vps`.

Entry points: `playbook.yml` (main VPS) and `jenkins-playbook.yml` (CI host). Each plays a flat list of roles from `roles/` against a single host. There are **no role dependencies or cross-role imports** — execution order is exactly the order in the playbook's `roles:` list, so reordering it can break network/dependency assumptions (e.g. `traefik` must run before any role that joins the `proxy` Docker network). Every role in `playbook.yml` carries a tag matching its name, so `--tags <role>` re-runs one service; **tags do not make the order safe to ignore**, and a tag-scoped run skips whatever earlier roles set up (which is why the `decabot` role repeats miplata's Zot `docker_login`).

## Common commands

All commands assume `.vault_pass` exists at the repo root (gitignored) and that you run ansible **from the repo root** — `ansible.cfg` now sets `vault_password_file = .vault_pass` as a relative path, so from anywhere else it prompts. CI is unaffected: every Jenkins stage passes its own `--vault-password-file` (or `ANSIBLE_VAULT_PASSWORD_FILE`), which overrides the config; it logs a harmless `.vault_pass was not found` line and exits 0.

**Ad-hoc `ansible` still needs `-e @vault.yml`**, and that is not something the config can fix — `vars_files` is a play-level directive, so an ad-hoc module run never loads `vault.yml` and `ansible_host` fails with *"'vault_main_vps_ip' is undefined"*:

```bash
ansible vps -e @vault.yml -m shell -a "docker ps"          # works
ansible vps -m shell -a "docker ps"                        # 'vault_main_vps_ip' is undefined
```

Moving `vault.yml` to `group_vars/all/vault.yml` would auto-load it for ad-hoc runs too, at the cost of changing vars precedence repo-wide. Not done. Never commit `.vault_pass` or an unencrypted `vault.yml`.

```bash
# Install required Galaxy collections (only community.docker is required)
ansible-galaxy collection install -r requirements.yml

# Deploy main VPS
ansible-playbook playbook.yml

# Deploy Jenkins VPS only
ansible-playbook jenkins-playbook.yml

# Dry run (no changes) — the same thing Jenkins runs before real deploy
ansible-playbook --check --diff playbook.yml

# Lint (same config Jenkins uses; see .ansible-lint)
ansible-lint playbook.yml

# Syntax-only check
ansible-playbook --syntax-check playbook.yml

# Target one role on one host (useful when iterating)
ansible-playbook playbook.yml --tags <tag>         # only if tags are set
ansible-playbook playbook.yml --limit vps --start-at-task "<task name>"

# Health checks (idempotent; run these after every deploy)
ansible-playbook tests/health-check.yml
ansible-playbook tests/jenkins-health-check.yml

# Edit encrypted secrets
ansible-vault edit vault.yml
ansible-vault view vault.yml

# First-time vault bootstrap
cp vault.yml.example vault.yml && ansible-vault encrypt vault.yml
```

CI (Jenkinsfile) runs: `galaxy install → ansible-lint → --syntax-check → --check --diff → deploy → health-check`. Vault password and SSH key are injected from Jenkins credentials (`ansible-vault-pass`, `vps-ssh-key`) — never write them to disk outside the build workspace.

## Architecture: how the pieces fit

**Configuration layering** (standard Ansible, worth noting the specifics here):

- `inventory.yml` — two hosts, `ansible_host` values come from `vault.yml` so the repo is safe to publish.
- `group_vars/all.yml` — everything non-secret and shared: domain/subdomain patterns, image pins, Docker network list, Traefik/Grafana/Jenkins/Zot hostnames, UFW rules, fail2ban tuning. **This is the first file to read when you need to know what image version or hostname a service uses.**
- `host_vars/{vps,jenkins}.yml` — per-host overrides. The Jenkins host overrides `ssh_allowed_users` (root vs. ubuntu), its UFW rule set (no DNS ports), and the Traefik dashboard hostname.
- `vault.yml` — AES256-encrypted. Holds secrets **and** identifying info (IPs, domain, ACME email, GitHub user).

**Traefik owns 80/443, and two things have taken it away before. Check both first when nothing on the box is reachable.**

1. **A host-installed web server winning the boot race.** The `caddy` deb was left on the main VPS from before the Traefik migration with its systemd unit **enabled**. On the 2026-07-09 reboot it grabbed 80/443, Traefik exited 128, and the entire public plane — grafana, miplata, metabase, zot, categorizer, vault, dns — stayed down for **19 days** with nothing alerting. The `traefik` role now stops, disables and **masks** `caddy`, `caddy-api` and `nginx` (`traefik_contending_services`) before it brings the stack up; masked rather than disabled because disabling still permits socket/dependency activation. Nothing is uninstalled and `/etc/caddy` is untouched, so it is reversible. **Do not remove that task**, and never `systemctl unmask caddy` on this host.
2. **A container that lost its network endpoints.** After that incident `docker start traefik` brought the container up *attached to no networks at all* — so it could not resolve `docker-proxy:2375` and its declared `ports:` were never published, while `docker ps` cheerfully reported `Up`. `docker_compose_v2` with `state: present` will not heal this, because the compose config hash still matches. The fix is a forced recreate: `cd /opt/traefik && docker compose down && docker compose up -d`. **Diagnose with `docker inspect traefik` and look for an empty `NetworkSettings.Networks` — an `Up` status proves nothing.**

**Service topology on the main VPS.** Traefik owns 80/443 and terminates TLS via ACME (HTTP-01). Every other service is a Docker Compose stack joined to the shared `proxy` network and exposed only through Traefik labels. Two Docker networks are pre-created (`group_vars/all.yml: docker_networks`): `proxy` and `miplata_db` (isolates Postgres/Redis from the reverse-proxy plane).

**What Miplata is (the app behind the role).** Miplata is a personal-finance / spending-analysis web app ("where is my money going?"). The source lives in a separate repo (`git@github.com:GonzMenSeb/miplata.git`) as a pnpm + turbo monorepo: `apps/api` (NestJS 11 + Prisma + BullMQ + JWT auth), `apps/web` (frontend served by nginx on port 80), and `packages/{db,parsers,shared}` — the `parsers` package handles uploaded bank-statement files, which is why the compose stack bind-mounts `/opt/miplata/uploads` into the API. The API also depends on `@anthropic-ai/claude-agent-sdk`, so AI-assisted transaction categorization is part of the product. Out-of-app analytics happen via Metabase querying Postgres through the read-only `metabase_ro` role that this Ansible role provisions.

**Miplata deploy pipeline (important, easy to misread).** The Ansible `miplata` role does *not* build images — it only provisions directories, `.env`, `docker-compose.yml`, a Postgres read-only user, and a DNS record. Images are built by a separate Jenkins job (`miplata-deploy`) that pushes to the self-hosted Zot registry at `zot.web.<domain>`. On a fresh VPS those images don't exist yet, so `roles/miplata/tasks/main.yml` intentionally tolerates a failed `docker compose pull` (`failed_when: false`) and guards `up` / SQL provisioning with `when: miplata_pull.rc == 0`. The health-check playbook mirrors the same guard. This is deliberate — don't "fix" it by making the pull strict.

**What DecaBot is (the app behind the `decabot` role).** DecaBot is the Los Prompteros AgentSprint entry — a conversational agent that turns a described sporting expedition into a real, size-resolved, in-stock Decathlon cart via Decathlon's public UCP/MCP endpoint. Source is a separate repo (`git@github.com:GonzMenSeb/Los-Prompteros-Project.git`), Python 3.12 + Reflex 0.9.7 + `gemini-3.6-flash`. Read that repo's `AGENTS.md` before touching anything — it carries a load-bearing-facts registry of live-verified behaviour that must not be "fixed".

Three things about this role are easy to misread:

- **One container, one port, one router.** Reflex needs two ports in dev, but in `--env prod` it mounts the compiled frontend onto the backend's own ASGI app, so `8000` serves the page *and* the `/_event` websocket. There is no path-based split and no second router — resist adding one.
- **The image is domain-agnostic on purpose.** Its baked `api_url` is `http://localhost:8000`; the compiled bundle rewrites any localhost-family host to whatever origin actually served the page and upgrades `ws`→`wss`. **Do not "fix" it to `decabot_host`** — that would need one image per domain and buys nothing.
- **Access control is the app's own password gate, not a Traefik middleware.** `vault_decabot_password` → `DECABOT_PASSWORD` in `/opt/decabot/.env`, enforced in Python inside every handler that spends a Gemini call. **An empty `DECABOT_PASSWORD` disables the gate**, so never let that template render blank. Rotating it needs only a role re-run, no rebuild.

**There is no Jenkins job for DecaBot** — unlike `miplata-deploy` and `categorizer-deploy`, the image is built and pushed by hand from the app repo (see its `docs/DEPLOY.md`). Adding a `decabot-deploy` job is the obvious next step; until it exists, don't write docs that assume it. **Zot accepts OCI manifests only** — a plain `docker push` uploads every layer and then fails `manifest invalid` (`415`) at the manifest step, so pushes need `docker buildx ... --output type=image,oci-mediatypes=true,push=true`. As with miplata and categorizer, the role tolerates a failed pull on a fresh VPS; don't make it strict.

**DNS.** PowerDNS runs on the main VPS and is authoritative for the project domain. Roles that need an A record (like `miplata`) add it via `docker exec pdns pdnsutil replace-rrset <zone> <name> A 3600 <ip>` — note that `pdnsutil` takes the short `name` (relative to the zone), not the FQDN.

**Observability.** Prometheus + Loki + Grafana + Alloy + cAdvisor + blackbox-exporter all run as containers on the main VPS (`monitoring` role). The Jenkins host runs only `observability_agent` (Alloy + node_exporter) and *pushes* metrics/logs over the internet to `prom-push.<web_subdomain>` and `loki-push.<web_subdomain>`, which Traefik exposes with bearer-token auth (`vault_observability_push_token`). `node_exporter` is installed on the host, not in a container, so `base` role adds a UFW rule allowing Docker bridge subnets (172.16.0.0/12) to reach `:9100` — do not widen that rule.

**Jenkins container.** The `jenkins` role builds a local image (`jenkins-ansible:latest`) from `roles/jenkins/files/Dockerfile` + `plugins.txt`, then runs it via Compose. It grafts the host's `docker` group GID into the container at build/run time (`getent group docker` → `jenkins_host_docker_gid`) so the Jenkins user can talk to the host Docker socket. Jenkins config is fully declarative via JCasC (`roles/jenkins/templates/casc.yml.j2`); mutating state through the Jenkins UI will be overwritten on the next `ansible-playbook jenkins-playbook.yml`.

## Conventions and gotchas

- **Every service lives under `/opt/<service>/`** on its host. Compose files, `.env`, and any bind-mounted state all live there. The default is set in each role's `defaults/main.yml` (e.g. `miplata_dir: /opt/miplata`).
- **`.env` files are rendered from `templates/env.j2`** via the Ansible `template` module with `mode: "0640"` and group-readable by `ssh_allowed_users`. Don't `copy:` env files — they must be templated so vault vars resolve.
- **Docker Compose v2 is the expected invocation** (`community.docker.docker_compose_v2`, `docker compose pull`). Don't fall back to the legacy `docker_compose` module.
- **`ansible-lint` profile is `min`** with several rules skipped (`command-instead-of-module`, `no-changed-when`, etc.) — intentional. Don't silently re-enable them in role changes.
- **Fact caching is on** (`ansible.cfg`: jsonfile in `.ansible_facts_cache/`, 1h TTL). If you add a task that depends on a fresh fact you just changed on the host (e.g. a new group membership), use `meta: clear_facts` or `gather_facts: true` explicitly.
- **Ubuntu user differs per host**: `ubuntu` on main VPS, `root` on Jenkins — templates that bake in a user should read `ssh_allowed_users`, not hard-code.
- `docs/` is gitignored (planning notes with identifying info are kept local-only). `vault.yml.example` is the canonical template for onboarding.
