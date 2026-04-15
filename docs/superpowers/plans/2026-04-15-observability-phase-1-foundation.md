# Observability — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a publicly-reachable, OAuth-gated Grafana on the main VPS backed by Prometheus (with remote_write receiver), Loki (14-day retention), and a stub Alloy — plus bearer-auth-protected `loki-push` and `prom-push` Traefik routes ready for Jenkins-VPS push traffic in Phase 3.

**Architecture:** Rewrite of `roles/monitoring/`. Four containers (Prometheus, Loki, Grafana, Alloy) on a new `observability` Docker bridge network, with Traefik publishing Grafana (OAuth) and the two push endpoints (bearer) via the existing `proxy` network. Promtail is replaced by Alloy; Phase 1 ships a minimal Alloy config that only scrapes itself (Phase 2 adds real scrape jobs and Docker log discovery).

**Tech Stack:**
- Ansible 2.x, `community.docker.docker_compose_v2`
- Docker Compose v2
- Prometheus `v3.11.2`, Grafana `12.4.3`, Loki `3.6.10`, Alloy `v1.15.1`, node_exporter `v1.9.0` (unchanged)
- Traefik `v3.4` with plugin `github.com/Aetherinox/traefik-api-token-middleware v0.1.4` for bearer-token auth on push endpoints
- PowerDNS (`pdnsutil`) for DNS records
- GitHub OAuth for Grafana login

---

## File structure

**Created:**
- `roles/monitoring/templates/loki-config.yml.j2` — Loki server config (schema v13, 14d retention, compactor)
- `roles/monitoring/templates/alloy-config.alloy.j2` — minimal Alloy config (self-scrape + remote_write to local Prom)
- `roles/monitoring/templates/grafana.ini.j2` — Grafana main config (root_url, security, GitHub OAuth, `role_attribute_path`)
- `roles/monitoring/templates/grafana-provisioning-datasources.yml.j2` — Prometheus + Loki datasources (UID-pinned)

**Rewritten:**
- `roles/monitoring/templates/prometheus.yml.j2` — drops stale Jenkins/Miplata scrape comments; adds `external_labels.cluster`
- `roles/monitoring/templates/docker-compose.yml.j2` — 4 services, two networks, Traefik labels, bearer-auth middleware declared via labels, Alloy replaces Promtail
- `roles/monitoring/tasks/main.yml` — templates the new files, removes the promtail `copy:` task, removes stale promtail file, adds Alloy readiness wait

**Modified (other roles):**
- `roles/traefik/templates/traefik.yml.j2` — add `experimental.plugins.apitokenmiddleware` block

**Modified (repo root / config):**
- `vault.yml` — add 4 new entries (`ansible-vault edit`)
- `vault.yml.example` — mirror the 4 new entries
- `group_vars/all.yml` — add `alloy_image`, `grafana_host`, `loki_push_host`, `prom_push_host`, `loki_retention`, `observability_network`, `grafana_github_admin_login`; remove `promtail_image`
- `tests/health-check.yml` — new assertions for 4 containers + Grafana TLS + push-endpoint bearer behavior

**Deleted:**
- `roles/monitoring/files/promtail.yml` (Alloy replaces Promtail)

**Manual (one-time, not in git):**
- GitHub OAuth App registration
- DNS records for `grafana`, `loki-push`, `prom-push` under `web.vespiridion.org`

---

## Task 1: Manual prerequisites — GitHub OAuth App + DNS records

**Files:** None (manual, but must complete before Task 11 apply).

- [ ] **Step 1: Register GitHub OAuth App**

Open https://github.com/settings/developers → OAuth Apps → "New OAuth App". Fill in:
- Application name: `Vespiridion Grafana`
- Homepage URL: `https://grafana.web.vespiridion.org`
- Authorization callback URL: `https://grafana.web.vespiridion.org/login/github`

Click "Register application". On the next page, copy the **Client ID**. Click "Generate a new client secret", copy the **Client secret** (only shown once).

Record these three values locally; they will be pasted into `vault.yml` in Task 2:
- `CLIENT_ID=<from GitHub>`
- `CLIENT_SECRET=<from GitHub>`
- Generate `PUSH_TOKEN=$(openssl rand -hex 32)`
- Generate `GRAFANA_SECRET_KEY=$(openssl rand -hex 32)`

- [ ] **Step 2: Add DNS records via pdnsutil**

Run:

```bash
ssh ubuntu@148.113.172.15 '
  sudo docker exec pdns pdnsutil replace-rrset web.vespiridion.org grafana A 300 148.113.172.15
  sudo docker exec pdns pdnsutil replace-rrset web.vespiridion.org loki-push A 300 148.113.172.15
  sudo docker exec pdns pdnsutil replace-rrset web.vespiridion.org prom-push A 300 148.113.172.15
  sudo docker exec pdns pdnsutil increase-serial web.vespiridion.org
  sudo docker exec pdns pdnsutil list-zone web.vespiridion.org | grep -E "^(grafana|loki-push|prom-push)\."
'
```

Expected output (last line is 3 records, one per subdomain):

```
grafana.web.vespiridion.org.   300 IN A   148.113.172.15
loki-push.web.vespiridion.org. 300 IN A   148.113.172.15
prom-push.web.vespiridion.org. 300 IN A   148.113.172.15
```

- [ ] **Step 3: Verify DNS resolves from your machine**

Run:

```bash
for h in grafana loki-push prom-push; do
  dig +short "$h.web.vespiridion.org"
done
```

Expected: each line prints `148.113.172.15`. If empty, wait 60s (zone transfer lag) and retry.

- [ ] **Step 4: No commit** — this task is environmental, not code.

---

## Task 2: Vault secrets and group_vars

**Files:**
- Modify: `vault.yml` (via `ansible-vault edit`)
- Modify: `vault.yml.example`
- Modify: `group_vars/all.yml`

- [ ] **Step 1: Add entries to `vault.yml`**

Run:

```bash
ansible-vault edit vault.yml --vault-password-file .vault_pass
```

Append these lines at the end of the file (replace placeholders with the values from Task 1):

```yaml

# Observability (Phase 1)
vault_observability_push_token: "<PUSH_TOKEN from Task 1>"
vault_grafana_oauth_client_id: "<CLIENT_ID from Task 1>"
vault_grafana_oauth_client_secret: "<CLIENT_SECRET from Task 1>"
vault_grafana_secret_key: "<GRAFANA_SECRET_KEY from Task 1>"
```

Save and exit. The file is re-encrypted automatically.

- [ ] **Step 2: Mirror placeholders in `vault.yml.example`**

Edit `vault.yml.example`. Append under the existing `# Grafana` comment block:

```yaml

# Observability (Phase 1)
vault_observability_push_token: "CHANGE_ME_32_BYTE_HEX"
vault_grafana_oauth_client_id: "CHANGE_ME_GITHUB_OAUTH_CLIENT_ID"
vault_grafana_oauth_client_secret: "CHANGE_ME_GITHUB_OAUTH_CLIENT_SECRET"
vault_grafana_secret_key: "CHANGE_ME_32_BYTE_HEX"
```

- [ ] **Step 3: Update `group_vars/all.yml`**

Replace the existing `# Monitoring` block (lines 44–49) with:

```yaml
# Monitoring
prometheus_image: "prom/prometheus:v3.11.2"
grafana_image: "grafana/grafana:12.4.3"
loki_image: "grafana/loki:3.6.10"
alloy_image: "grafana/alloy:v1.15.1"
prometheus_retention: "30d"
loki_retention: "336h"  # 14 days

grafana_host: "grafana.{{ web_subdomain }}"
loki_push_host: "loki-push.{{ web_subdomain }}"
prom_push_host: "prom-push.{{ web_subdomain }}"
grafana_github_admin_login: "GonzMenSeb"
observability_network: "observability"
```

Note: the `promtail_image` line is intentionally removed. Alloy replaces Promtail.

- [ ] **Step 4: Verify encoding**

Run:

```bash
ansible-vault view vault.yml --vault-password-file .vault_pass | grep -c vault_observability_push_token
```

Expected: `1` (entry exists and decrypts).

- [ ] **Step 5: Commit**

```bash
git add vault.yml vault.yml.example group_vars/all.yml
git commit -m "feat(monitoring): add vault secrets and vars for Phase 1 observability"
```

---

## Task 3: Register Traefik API token middleware plugin

**Files:**
- Modify: `roles/traefik/templates/traefik.yml.j2`

- [ ] **Step 1: Edit `roles/traefik/templates/traefik.yml.j2`**

Replace the current file with:

```yaml
api:
  dashboard: true

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entrypoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "tcp://docker-proxy:2375"
    exposedByDefault: false
    network: proxy

certificatesResolvers:
  letsencrypt:
    acme:
      email: {{ acme_email }}
      storage: /acme.json
      httpChallenge:
        entryPoint: web

experimental:
  plugins:
    apitokenmiddleware:
      moduleName: "github.com/Aetherinox/traefik-api-token-middleware"
      version: "v0.1.4"

log:
  level: INFO
```

(The only change is the `experimental.plugins.apitokenmiddleware` block appended before `log:`.)

- [ ] **Step 2: Dry-run then apply the playbook on the main VPS**

The roles in `playbook.yml` are not tagged, so we run the full playbook and let idempotency handle untouched roles. First, dry run:

```bash
ansible-playbook playbook.yml \
  --vault-password-file .vault_pass \
  --check --diff --limit vps
```

Expected: the diff shows only the `traefik.yml` template update and a `restart traefik` handler scheduled. If other roles show unexpected changes, halt and investigate.

Apply once the diff is clean:

```bash
ansible-playbook playbook.yml \
  --vault-password-file .vault_pass \
  --limit vps
```

Expected: `failed=0`, with the `restart traefik` handler firing once.

- [ ] **Step 3: Verify plugin is loaded by Traefik**

Run:

```bash
ssh ubuntu@148.113.172.15 'sudo docker logs traefik 2>&1 | tail -50 | grep -i plugin'
```

Expected: at least one line containing `apitokenmiddleware` indicating the plugin was downloaded and loaded (examples: `Starting plugin "apitokenmiddleware"`, `Plugin apitokenmiddleware loaded`). If you see `failed to download plugin`, halt — the fallback plan is to replace the plugin with a `forwardAuth` middleware pointed at a small nginx sidecar (see the design doc, §Data flow).

- [ ] **Step 4: Verify Traefik is still serving existing hosts**

Run:

```bash
curl -sI https://vault.web.vespiridion.org/alive | head -1
curl -sI https://dns.web.vespiridion.org       | head -1
```

Expected: `HTTP/2 200` for vault, `HTTP/2 200` or `302` for dns.

- [ ] **Step 5: Commit**

```bash
git add roles/traefik/templates/traefik.yml.j2
git commit -m "feat(traefik): register api-token-middleware plugin for observability push auth"
```

---

## Task 4: Loki configuration template

**Files:**
- Create: `roles/monitoring/templates/loki-config.yml.j2`

- [ ] **Step 1: Create the file**

Write to `roles/monitoring/templates/loki-config.yml.j2`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100
  log_level: info

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: {{ loki_retention }}
  allow_structured_metadata: true
  max_query_series: 2000

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  retention_delete_delay: 2h
  retention_delete_worker_count: 150
  delete_request_store: filesystem

analytics:
  reporting_enabled: false
```

- [ ] **Step 2: Commit**

```bash
git add roles/monitoring/templates/loki-config.yml.j2
git commit -m "feat(monitoring): Loki config with v13 schema and 14d retention"
```

---

## Task 5: Prometheus configuration template

**Files:**
- Modify: `roles/monitoring/templates/prometheus.yml.j2` (full rewrite)

- [ ] **Step 1: Replace the file contents**

Overwrite `roles/monitoring/templates/prometheus.yml.j2` with:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: vespiridion
    env: prod

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
        labels:
          host: vps

# Local scrape targets (node_exporter, cAdvisor, Traefik, Zot, miplata-api, etc.)
# are collected by Alloy (not declared here) and shipped via remote_write in Phase 2.
# Cross-VPS metrics from the Jenkins host arrive via remote_write on the
# `prom-push.web.vespiridion.org` endpoint in Phase 3.
```

Note: the `--web.enable-remote-write-receiver` flag lives in `docker-compose.yml.j2` (Task 8), not here.

- [ ] **Step 2: Commit**

```bash
git add roles/monitoring/templates/prometheus.yml.j2
git commit -m "feat(monitoring): Prometheus config with external labels; drop stale scrape targets"
```

---

## Task 6: Grafana configuration + datasource provisioning

**Files:**
- Create: `roles/monitoring/templates/grafana.ini.j2`
- Create: `roles/monitoring/templates/grafana-provisioning-datasources.yml.j2`

- [ ] **Step 1: Create `grafana.ini.j2`**

Write to `roles/monitoring/templates/grafana.ini.j2`:

```ini
[server]
root_url = https://{{ grafana_host }}
serve_from_sub_path = false

[security]
admin_user = admin
admin_password = {{ vault_grafana_admin_password }}
secret_key = {{ vault_grafana_secret_key }}
cookie_secure = true
cookie_samesite = lax

[users]
allow_sign_up = false
auto_assign_org_role = Viewer

[auth]
disable_login_form = false
oauth_auto_login = false

[auth.github]
enabled = true
allow_sign_up = true
client_id = {{ vault_grafana_oauth_client_id }}
client_secret = {{ vault_grafana_oauth_client_secret }}
scopes = read:user user:email
auth_url = https://github.com/login/oauth/authorize
token_url = https://github.com/login/oauth/access_token
api_url = https://api.github.com/user
role_attribute_path = login == '{{ grafana_github_admin_login }}' && 'Admin' || ''
role_attribute_strict = true

[analytics]
reporting_enabled = false
check_for_updates = false
```

- [ ] **Step 2: Create `grafana-provisioning-datasources.yml.j2`**

Write to `roles/monitoring/templates/grafana-provisioning-datasources.yml.j2`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      timeInterval: 15s

  - name: Loki
    type: loki
    uid: loki
    access: proxy
    url: http://loki:3100
    editable: false
    jsonData:
      maxLines: 1000
```

- [ ] **Step 3: Commit**

```bash
git add roles/monitoring/templates/grafana.ini.j2 \
        roles/monitoring/templates/grafana-provisioning-datasources.yml.j2
git commit -m "feat(monitoring): Grafana config with GitHub OAuth and provisioned datasources"
```

---

## Task 7: Alloy minimal configuration

**Files:**
- Create: `roles/monitoring/templates/alloy-config.alloy.j2`

- [ ] **Step 1: Create the file**

Write to `roles/monitoring/templates/alloy-config.alloy.j2`:

```alloy
// Phase 1: minimal Alloy config. Scrape configs (Docker SD, node_exporter,
// cAdvisor, Traefik, Zot, exporters, miplata-api) are added in Phase 2.
//
// Alloy exposes its own metrics on :12345 and the /-/ready endpoint, which
// the Ansible role waits on during apply (see tasks/main.yml).

logging {
  level  = "info"
  format = "logfmt"
}

// Scrape Alloy's own metrics so we can observe the collector itself.
prometheus.scrape "alloy_self" {
  targets         = [{"__address__" = "localhost:12345", "job" = "alloy", "host" = "vps"}]
  forward_to      = [prometheus.remote_write.local.receiver]
  scrape_interval = "15s"
}

// Write everything to the local Prometheus over the observability network.
prometheus.remote_write "local" {
  endpoint {
    url = "http://prometheus:9090/api/v1/write"
  }
  external_labels = {
    env = "prod",
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add roles/monitoring/templates/alloy-config.alloy.j2
git commit -m "feat(monitoring): minimal Alloy config (self-scrape + remote_write to local Prom)"
```

---

## Task 8: Docker Compose template (4 services, 2 networks, Traefik labels, bearer middleware)

**Files:**
- Modify: `roles/monitoring/templates/docker-compose.yml.j2` (full rewrite)

- [ ] **Step 1: Replace the file contents**

Overwrite `roles/monitoring/templates/docker-compose.yml.j2` with:

```yaml
networks:
  proxy:
    external: true
  {{ observability_network }}:
    driver: bridge
    name: {{ observability_network }}

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
  alloy_data:

services:
  prometheus:
    image: {{ prometheus_image }}
    container_name: prometheus
    restart: unless-stopped
    networks: [{{ observability_network }}, proxy]
    volumes:
      - prometheus_data:/prometheus
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time={{ prometheus_retention }}'
      - '--web.enable-lifecycle'
      - '--web.enable-remote-write-receiver'
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.promwrite.rule=Host(`{{ prom_push_host }}`)"
      - "traefik.http.routers.promwrite.entrypoints=websecure"
      - "traefik.http.routers.promwrite.tls.certresolver=letsencrypt"
      - "traefik.http.routers.promwrite.middlewares=obs-bearer@docker"
      - "traefik.http.services.promwrite.loadbalancer.server.port=9090"

  loki:
    image: {{ loki_image }}
    container_name: loki
    restart: unless-stopped
    networks: [{{ observability_network }}, proxy]
    volumes:
      - loki_data:/loki
      - ./loki-config.yml:/etc/loki/local-config.yaml:ro
    command: ["-config.file=/etc/loki/local-config.yaml"]
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.lokipush.rule=Host(`{{ loki_push_host }}`)"
      - "traefik.http.routers.lokipush.entrypoints=websecure"
      - "traefik.http.routers.lokipush.tls.certresolver=letsencrypt"
      - "traefik.http.routers.lokipush.middlewares=obs-bearer@docker"
      - "traefik.http.services.lokipush.loadbalancer.server.port=3100"
      # Bearer-auth middleware declaration (referenced by both push routers above).
      - "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.bearerHeader=true"
      - "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.bearerHeaderName=Authorization"
      - "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.removeHeadersOnSuccess=false"
      - "traefik.http.middlewares.obs-bearer.plugin.apitokenmiddleware.tokens[0]={{ vault_observability_push_token }}"

  grafana:
    image: {{ grafana_image }}
    container_name: grafana
    restart: unless-stopped
    networks: [{{ observability_network }}, proxy]
    depends_on: [prometheus, loki]
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana.ini:/etc/grafana/grafana.ini:ro
      - ./grafana-provisioning/datasources.yml:/etc/grafana/provisioning/datasources/datasources.yml:ro
    environment:
      - GF_PATHS_CONFIG=/etc/grafana/grafana.ini
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.grafana.rule=Host(`{{ grafana_host }}`)"
      - "traefik.http.routers.grafana.entrypoints=websecure"
      - "traefik.http.routers.grafana.tls.certresolver=letsencrypt"
      - "traefik.http.services.grafana.loadbalancer.server.port=3000"

  alloy:
    image: {{ alloy_image }}
    container_name: alloy
    restart: unless-stopped
    networks: [{{ observability_network }}]
    depends_on: [prometheus]
    ports:
      - "127.0.0.1:12345:12345"
    volumes:
      - alloy_data:/var/lib/alloy/data
      - ./alloy-config.alloy:/etc/alloy/config.alloy:ro
    command:
      - run
      - --server.http.listen-addr=0.0.0.0:12345
      - --storage.path=/var/lib/alloy/data
      - /etc/alloy/config.alloy
```

Note: the `obs-bearer` middleware is declared via labels on the `loki` service (arbitrary choice — Traefik merges labels across all containers). Routers reference it as `obs-bearer@docker`.

- [ ] **Step 2: Commit**

```bash
git add roles/monitoring/templates/docker-compose.yml.j2
git commit -m "feat(monitoring): docker-compose with 4 services, Traefik routes, bearer-auth"
```

---

## Task 9: Monitoring role tasks, defaults, handlers; drop promtail

**Files:**
- Modify: `roles/monitoring/tasks/main.yml` (rewrite)
- Delete: `roles/monitoring/files/promtail.yml`
- Handlers and defaults unchanged (they already cover the new layout)

- [ ] **Step 1: Replace `roles/monitoring/tasks/main.yml`**

Overwrite with:

```yaml
---
- name: Create monitoring directory
  file:
    path: "{{ monitoring_dir }}"
    state: directory
    mode: "0755"

- name: Create Grafana provisioning subdirectory
  file:
    path: "{{ monitoring_dir }}/grafana-provisioning"
    state: directory
    mode: "0755"

- name: Copy Prometheus config
  template:
    src: prometheus.yml.j2
    dest: "{{ monitoring_dir }}/prometheus.yml"
    mode: "0644"
  notify: restart monitoring

- name: Copy Loki config
  template:
    src: loki-config.yml.j2
    dest: "{{ monitoring_dir }}/loki-config.yml"
    mode: "0644"
  notify: restart monitoring

- name: Copy Alloy config
  template:
    src: alloy-config.alloy.j2
    dest: "{{ monitoring_dir }}/alloy-config.alloy"
    mode: "0644"
  notify: restart monitoring

- name: Copy Grafana config
  template:
    src: grafana.ini.j2
    dest: "{{ monitoring_dir }}/grafana.ini"
    mode: "0640"
  notify: restart monitoring

- name: Copy Grafana datasource provisioning
  template:
    src: grafana-provisioning-datasources.yml.j2
    dest: "{{ monitoring_dir }}/grafana-provisioning/datasources.yml"
    mode: "0644"
  notify: restart monitoring

- name: Remove deprecated Promtail config (replaced by Alloy)
  file:
    path: "{{ monitoring_dir }}/promtail.yml"
    state: absent

- name: Copy docker-compose file
  template:
    src: docker-compose.yml.j2
    dest: "{{ monitoring_dir }}/docker-compose.yml"
    mode: "0644"

- name: Start monitoring stack
  community.docker.docker_compose_v2:
    project_src: "{{ monitoring_dir }}"
    state: present
    pull: missing

- name: Wait for Alloy readiness
  uri:
    url: http://127.0.0.1:12345/-/ready
    status_code: 200
  register: alloy_ready
  retries: 10
  delay: 3
  until: alloy_ready.status == 200

# node_exporter (runs on the host, not in Docker)
- name: Check if node_exporter binary exists
  stat:
    path: /usr/local/bin/node_exporter
  register: node_exporter_bin

- name: Download node_exporter
  get_url:
    url: "https://github.com/prometheus/node_exporter/releases/download/v1.9.0/node_exporter-1.9.0.linux-amd64.tar.gz"
    dest: /tmp/node_exporter.tar.gz
  when: not node_exporter_bin.stat.exists

- name: Extract node_exporter
  unarchive:
    src: /tmp/node_exporter.tar.gz
    dest: /tmp/
    remote_src: true
  when: not node_exporter_bin.stat.exists

- name: Install node_exporter binary
  copy:
    src: /tmp/node_exporter-1.9.0.linux-amd64/node_exporter
    dest: /usr/local/bin/node_exporter
    mode: "0755"
    remote_src: true
  when: not node_exporter_bin.stat.exists

- name: Create node_exporter user
  user:
    name: node_exporter
    system: true
    shell: /usr/sbin/nologin
    create_home: false

- name: Install node_exporter systemd service
  copy:
    src: node_exporter.service
    dest: /etc/systemd/system/node_exporter.service
    mode: "0644"
  notify: restart node_exporter

- name: Enable node_exporter
  systemd:
    name: node_exporter
    enabled: true
    state: started
    daemon_reload: true
```

- [ ] **Step 2: Delete the obsolete Promtail file**

```bash
git rm roles/monitoring/files/promtail.yml
```

- [ ] **Step 3: Commit**

```bash
git add roles/monitoring/tasks/main.yml
git commit -m "feat(monitoring): rewrite tasks for Phase 1 stack; drop promtail"
```

---

## Task 10: Extend `tests/health-check.yml` with Phase 1 assertions

**Files:**
- Modify: `tests/health-check.yml`

- [ ] **Step 1: Add container and endpoint assertions**

In `tests/health-check.yml`, after the existing `Verify Zot registry is running` assertion (around line 73) and before the `# Miplata containers` comment block, insert:

```yaml

    # ── Observability stack (Phase 1) ──
    - name: Verify Prometheus is running
      assert:
        that: "'prometheus' in running_containers.stdout_lines"
        fail_msg: "Prometheus container is not running"

    - name: Verify Loki is running
      assert:
        that: "'loki' in running_containers.stdout_lines"
        fail_msg: "Loki container is not running"

    - name: Verify Grafana is running
      assert:
        that: "'grafana' in running_containers.stdout_lines"
        fail_msg: "Grafana container is not running"

    - name: Verify Alloy is running
      assert:
        that: "'alloy' in running_containers.stdout_lines"
        fail_msg: "Alloy container is not running"

    - name: Verify Alloy is ready
      uri:
        url: http://127.0.0.1:12345/-/ready
        status_code: 200
        timeout: 5
```

- [ ] **Step 2: Add TLS + auth assertions**

After the existing `Verify Miplata responds over TLS` block (around line 163), insert:

```yaml

    # ── Observability TLS + auth ──
    - name: Verify Grafana responds over TLS (login page)
      uri:
        url: "https://{{ grafana_host }}/login"
        status_code: 200
        validate_certs: true
        timeout: 10
      delegate_to: localhost
      become: false

    - name: Verify Grafana health endpoint
      uri:
        url: "https://{{ grafana_host }}/api/health"
        status_code: 200
        validate_certs: true
        timeout: 10
      delegate_to: localhost
      become: false

    - name: Verify loki-push rejects requests without bearer token
      uri:
        url: "https://{{ loki_push_host }}/ready"
        status_code: [401, 403]
        validate_certs: true
        timeout: 10
      delegate_to: localhost
      become: false

    - name: Verify loki-push accepts requests with bearer token
      uri:
        url: "https://{{ loki_push_host }}/ready"
        status_code: 200
        validate_certs: true
        headers:
          Authorization: "Bearer {{ vault_observability_push_token }}"
        timeout: 10
      delegate_to: localhost
      become: false

    - name: Verify prom-push rejects requests without bearer token
      uri:
        url: "https://{{ prom_push_host }}/-/ready"
        status_code: [401, 403]
        validate_certs: true
        timeout: 10
      delegate_to: localhost
      become: false

    - name: Verify prom-push accepts requests with bearer token
      uri:
        url: "https://{{ prom_push_host }}/-/ready"
        status_code: 200
        validate_certs: true
        headers:
          Authorization: "Bearer {{ vault_observability_push_token }}"
        timeout: 10
      delegate_to: localhost
      become: false
```

- [ ] **Step 3: Commit**

```bash
git add tests/health-check.yml
git commit -m "test(health-check): assert observability stack containers, TLS, and bearer auth"
```

---

## Task 11: Apply and verify end-to-end

**Files:** none (this is a deploy + test task).

- [ ] **Step 1: Ansible lint + syntax check (local)**

Run:

```bash
ansible-lint playbook.yml
ansible-playbook --syntax-check --vault-password-file .vault_pass playbook.yml
```

Expected: both commands exit 0. Fix any lint/syntax errors before proceeding.

- [ ] **Step 2: Dry run**

Run:

```bash
ansible-playbook --check --diff \
  --vault-password-file .vault_pass \
  --limit vps \
  playbook.yml
```

Expected: the diff shows only the monitoring role's new templates being created and `docker-compose.yml` being replaced. No unexpected changes in other roles. If other diffs appear, investigate before applying.

- [ ] **Step 3: Apply**

Run:

```bash
ansible-playbook \
  --vault-password-file .vault_pass \
  --limit vps \
  playbook.yml
```

Expected: play completes with `failed=0`. The "Wait for Alloy readiness" step may take 1–2 iterations; that's normal.

- [ ] **Step 4: Run the health-check playbook**

Run:

```bash
ansible-playbook \
  --vault-password-file .vault_pass \
  --limit vps \
  tests/health-check.yml
```

Expected: all assertions pass, including the new observability ones. Output ends with `All 1 health checks passed for vps`.

- [ ] **Step 5: Manual browser smoke test**

Open `https://grafana.web.vespiridion.org` in a **private/incognito window**. Expected flow:
1. Grafana login page loads over HTTPS with a valid Let's Encrypt certificate.
2. "Sign in with GitHub" button is visible (alongside the admin login form as break-glass).
3. Clicking it redirects to `github.com/login/oauth/authorize` → after granting, you're redirected back and logged in as an **Admin**-role user (since `login == 'GonzMenSeb'`).
4. Navigate to Configuration → Data sources: both **Prometheus** and **Loki** are listed with a green "working" check.
5. Navigate to Explore → select **Prometheus** → run `up` → at least one series returns (`up{job="alloy"}` or `up{job="prometheus"}`).

If any of the above fails, do NOT commit — investigate. Common failures:
- Cert not issued yet → wait 60s, retry (Let's Encrypt HTTP-01 challenge)
- OAuth redirect mismatch → check Task 1 Step 1 callback URL exactly matches `https://grafana.web.vespiridion.org/login/github`
- `role_attribute_strict = true` denies login for any other GitHub user; that's expected

- [ ] **Step 6: Verify Alloy is reporting to Prometheus**

From your workstation:

```bash
ssh ubuntu@148.113.172.15 '
  docker exec prometheus wget -qO- "http://localhost:9090/api/v1/query?query=up" |
    python3 -m json.tool
'
```

Expected: JSON containing at least two results — `{job="prometheus"}` and `{job="alloy"}` — both with `value` ending in `"1"`.

- [ ] **Step 7: Push to origin for Jenkins CI**

The worktree branch is `worktree-observability`. Push and open a PR:

```bash
git push -u origin worktree-observability
gh pr create \
  --title "feat(monitoring): Phase 1 foundation (Alloy, OAuth Grafana, bearer push endpoints)" \
  --body "$(cat <<'EOF'
## Summary
- Rewrites `roles/monitoring/` to replace Promtail with Grafana Alloy v1.15.1 and route Grafana publicly via Traefik with GitHub OAuth.
- Enables Prometheus `--web.enable-remote-write-receiver` and adds bearer-auth-protected `loki-push.web.` and `prom-push.web.` endpoints (ready for Jenkins VPS push traffic in Phase 3).
- Loki: v13 TSDB schema with 14-day retention via compactor.
- Extends `tests/health-check.yml` with 4 container assertions, Grafana TLS/health, and bearer-auth behavior (401 without, 200 with).

Follows the design in `docs/superpowers/specs/2026-04-15-observability-stack-design.md` (Phase 1 only; Phases 2–5 are separate PRs).

## Test plan
- [x] `ansible-lint playbook.yml` clean
- [x] `ansible-playbook --check --diff` diff limited to monitoring role
- [x] `ansible-playbook playbook.yml` applies cleanly
- [x] `ansible-playbook tests/health-check.yml` green
- [x] Grafana OAuth flow works end-to-end in a private browser window
- [x] `up{job="alloy"} == 1` in Prometheus
EOF
)"
```

Expected: PR URL printed. The Jenkins pipeline will re-run lint + syntax + dry-run + deploy + health-check automatically on push.

- [ ] **Step 8: No additional commit** — all code changes have been committed in prior tasks.

---

## Self-review notes

**Spec coverage** (checked against `docs/superpowers/specs/2026-04-15-observability-stack-design.md` Phase 1 row):
- Rewrite `roles/monitoring/` (Alloy, Prom remote_write receiver, Loki v13+14d, Grafana OAuth + datasources) → Tasks 4–9
- Traefik routes for `grafana.`, `loki-push.`, `prom-push.` → Task 8 labels + Task 1 DNS
- Traefik plugin bearer middleware → Task 3 (plugin) + Task 8 (middleware labels)
- Vault entries → Task 2
- Health-check extensions → Task 10
- Apply + verify → Task 11

**Out of Phase 1 scope** (confirmed not implemented here):
- Docker container log discovery in Alloy (Phase 2)
- node_exporter scrape config in Alloy beyond self-scrape (Phase 2)
- cAdvisor, exporters, blackbox (Phase 2)
- Jenkins VPS `observability_agent` role (Phase 3)
- Dashboards (Phase 4)
- miplata app instrumentation (Phase 5)

**Known risks / fallbacks documented above:**
- Traefik plugin download failure at apply time → Task 3 Step 3 notes the forwardAuth+nginx fallback
- OAuth first-apply before the GitHub app exists → Task 1 makes app registration a prerequisite to Task 2 so this can't occur
- DNS propagation delay → Task 1 Step 3 includes a dig-based wait
