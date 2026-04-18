# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Ansible Infrastructure-as-Code for two Ubuntu VPS hosts defined in `inventory.yml`:

- **`vps`** — the public web host (all user-facing services behind Traefik + Let's Encrypt).
- **`jenkins`** — a separate CI/CD host that builds app images and deploys back to `vps`.

Entry points: `playbook.yml` (main VPS) and `jenkins-playbook.yml` (CI host). Each plays a flat list of roles from `roles/` against a single host. There are **no role dependencies or cross-role imports** — execution order is exactly the order in the playbook's `roles:` list, so reordering it can break network/dependency assumptions (e.g. `traefik` must run before any role that joins the `proxy` Docker network).

## Common commands

All commands assume `.vault_pass` exists at the repo root (gitignored; it's auto-picked up via `ansible.cfg`'s default). Never commit `.vault_pass` or an unencrypted `vault.yml`.

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

**Service topology on the main VPS.** Traefik owns 80/443 and terminates TLS via ACME (HTTP-01). Every other service is a Docker Compose stack joined to the shared `proxy` network and exposed only through Traefik labels. Two Docker networks are pre-created (`group_vars/all.yml: docker_networks`): `proxy` and `miplata_db` (isolates Postgres/Redis from the reverse-proxy plane).

**Miplata deploy pipeline (important, easy to misread).** The Ansible `miplata` role does *not* build images — it only provisions directories, `.env`, `docker-compose.yml`, a Postgres read-only user, and a DNS record. Images are built by a separate Jenkins job (`miplata-deploy`) that pushes to the self-hosted Zot registry at `registry.web.<domain>`. On a fresh VPS those images don't exist yet, so `roles/miplata/tasks/main.yml` intentionally tolerates a failed `docker compose pull` (`failed_when: false`) and guards `up` / SQL provisioning with `when: miplata_pull.rc == 0`. The health-check playbook mirrors the same guard. This is deliberate — don't "fix" it by making the pull strict.

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
