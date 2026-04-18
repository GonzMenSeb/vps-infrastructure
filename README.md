# vps-infrastructure

Ansible-based Infrastructure-as-Code for a two-VPS setup:

- **Main VPS** — public web services behind Traefik + Let's Encrypt.
- **Jenkins VPS** — dedicated CI/CD host that deploys back to the main VPS.

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
| `metabase` | BI dashboard on a read-only replica |
| `monitoring` | Prometheus, Loki, Grafana, Alloy, cAdvisor, blackbox-exporter |

**Jenkins VPS**

| Role | Purpose |
|---|---|
| `base`, `docker`, `traefik` | Same hardened baseline |
| `jenkins` | Jenkins LTS with Configuration-as-Code, deploy keys, pipelines |
| `observability_agent` | Alloy + node_exporter pushing to main VPS |

## Requirements

- Ansible 2.15+
- A vault password file at `.vault_pass` (gitignored)
- SSH access to both hosts
- Required collections: `ansible-galaxy collection install -r requirements.yml`

## Usage

```bash
# First-time setup: copy the vault example and fill in your values
cp vault.yml.example vault.yml
ansible-vault encrypt vault.yml

# Full deploy
ansible-playbook playbook.yml

# Jenkins host only
ansible-playbook jenkins-playbook.yml

# Dry run
ansible-playbook --check --diff playbook.yml

# Post-deploy health checks
ansible-playbook tests/health-check.yml
```

## Layout

```
.
├── inventory.yml                 # Hosts (vps, jenkins) — values from vault
├── playbook.yml                  # Main VPS deploy
├── jenkins-playbook.yml          # Jenkins VPS deploy
├── group_vars/all.yml            # Shared vars (domain, subdomains, image pins)
├── host_vars/{vps,jenkins}.yml   # Per-host overrides
├── vault.yml                     # AES256-encrypted secrets + identifying info
├── vault.yml.example             # Template for first-time setup
├── roles/                        # One role per service
├── tests/health-check.yml        # Post-deploy asserts
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
written to disk beyond the build workspace.

## License

MIT — see [LICENSE](LICENSE).
