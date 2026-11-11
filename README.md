# vps-infrastructure

Ansible-based Infrastructure-as-Code for two VPS hosts and a personal agent host:

- **Main VPS** — public web services behind Traefik + Let's Encrypt.
- **Jenkins VPS** — dedicated CI/CD host that deploys back to the main VPS.
- **w1** — personal agent host (Claude Code sessions), applied by hand.

All identifying values (IPs, domain, admin email, credentials) are stored in an
encrypted `vault.yml`. Nothing sensitive lives in plaintext in this repo.

## What it deploys

**Main VPS**

| Role | Purpose |
|---|---|
| `base` | UFW, fail2ban, SSH hardening |
| `docker` | Docker Engine + daemon config |
| `traefik` | Reverse proxy, automatic TLS, dashboard |
| `dns` | PowerDNS authoritative + admin UI |
| `vaultwarden` | Self-hosted password manager |
| `zot` | OCI container registry for CI artifacts |
| `miplata` | App stack (Postgres + Redis + API + Web) |
| `metabase` | BI dashboard on a read-only replica (switched off, `metabase_enabled`) |
| `decabot` | DecaBot expedition concierge (Reflex, single-port, in-app password gate) |
| `monitoring` | Prometheus, Loki, Grafana, Alloy, cAdvisor, blackbox-exporter |

**Jenkins VPS**

| Role | Purpose |
|---|---|
| `base`, `docker`, `traefik` | Same hardened baseline |
| `jenkins` | Jenkins LTS with Configuration-as-Code, deploy keys, pipelines |
| `observability_agent` | Alloy + node_exporter pushing to main VPS |

## Requirements

- Ansible 2.15+
- A vault password file at `.vault_pass` (gitignored; `ansible.cfg` picks it up automatically, so run ansible from the repo root)
- SSH access to the hosts
- Required collections: `ansible-galaxy collection install -r requirements.yml`

## Usage

```bash
# First-time setup: copy the vault example and fill in your values
cp vault.yml.example vault.yml
ansible-vault encrypt vault.yml

# Full deploy
ansible-playbook playbook.yml

# One service only (every role in playbook.yml carries a tag matching its name)
ansible-playbook playbook.yml --tags decabot

# Jenkins host only
ansible-playbook jenkins-playbook.yml

# Dry run
ansible-playbook --check --diff playbook.yml

# Post-deploy health checks
ansible-playbook tests/health-check.yml

# w1 (by hand, staged; see w1-agent-host-runbook.md and CLAUDE.md)
ansible-playbook w1-playbook.yml --tags <stage> --check --diff
ansible-playbook w1-playbook.yml --tags agent_host --check --diff
# a plain run (no --tags) plays host_agent and every agent_host stage at once; it is not a runbook step (CLAUDE.md, agent_host rule 11)
ansible-playbook tests/w1-health-check.yml
```

## Layout

```
.
├── inventory.yml                 # Hosts (vps, jenkins, w1) — values from vault
├── playbook.yml                  # Main VPS deploy
├── jenkins-playbook.yml          # Jenkins VPS deploy
├── w1-playbook.yml               # w1 agent host (by hand)
├── w1-reboot-playbook.yml        # w1 guarded reboot (by hand)
├── group_vars/all.yml            # Shared vars (domain, subdomains, image pins)
├── host_vars/{vps,jenkins}.yml   # Per-host overrides
├── vault.yml                     # AES256-encrypted secrets + identifying info
├── vault.yml.example             # Template for first-time setup
├── roles/                        # One role per service
├── tests/                        # Post-deploy asserts and the w1 gate, lab and benchmark
└── Jenkinsfile                   # CI pipeline run by Jenkins
```

## CI

Jenkins watches this repo. Pushing to `main` triggers:

1. `ansible-galaxy collection install`
2. `ansible-lint`
3. `ansible-playbook --syntax-check`
4. `ansible-playbook --check --diff` (dry run)
5. `ansible-playbook playbook.yml` (deploy)
6. `ansible-playbook tests/health-check.yml`

Vault password and SSH keys are injected from Jenkins credentials — never
written to disk beyond the build workspace. w1 is not deployed by CI.

## License

MIT — see [LICENSE](LICENSE).
