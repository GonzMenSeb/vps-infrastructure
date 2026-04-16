# Observability — Phase 2 (Local Coverage) Implementation Plan

**Goal:** Turn the Phase 1 empty stack into a fully-instrumented main VPS: Alloy discovers and tails every container's logs (via Docker SD), ingests journald, and scrapes metrics from node_exporter, cAdvisor, Traefik, Zot, postgres-exporter, redis-exporter, miplata-api, and blackbox-exporter probing all public endpoints.

**Architecture:** Alloy joins `observability` + `proxy` networks to reach every service. Miplata's exporters dual-home (`miplata_internal` + `observability`). cAdvisor + blackbox live on `observability`. Traefik and Zot enable their built-in `/metrics` endpoints. Postgres exposes a read-only `exporter` role with `pg_monitor` grant; its password lives in vault.

**Tech Stack:**
- Grafana Alloy v1.15.1 (Docker SD, journal source, multiple scrapes + writes)
- cAdvisor `gcr.io/cadvisor/cadvisor:v0.52.2`
- postgres-exporter `prometheuscommunity/postgres-exporter:v0.15.0`
- redis-exporter `oliver006/redis_exporter:v1.62.0`
- blackbox-exporter `prom/blackbox-exporter:v0.26.0`

---

## File structure

**Created:**
- `roles/monitoring/templates/blackbox.yml.j2` — blackbox probe modules (http_any_ok accepting 200/301/302/401)

**Rewritten:**
- `roles/monitoring/templates/alloy-config.alloy.j2` — substantive config replacing Phase 1 stub
- `roles/monitoring/templates/docker-compose.yml.j2` — add cAdvisor + blackbox-exporter services; Alloy joins `proxy` + gets `host.docker.internal` extra host + mounts docker socket + `/var/log/journal`

**Modified:**
- `roles/traefik/templates/traefik.yml.j2` — enable Prometheus metrics entrypoint on :8082
- `roles/traefik/templates/docker-compose.yml.j2` — expose :8082 internally on the proxy network
- `roles/zot/templates/config.json.j2` — enable `metrics.enable: true`
- `roles/miplata/templates/docker-compose.yml.j2` — add postgres-exporter + redis-exporter; miplata-api joins `observability` network
- `roles/miplata/tasks/main.yml` — create postgres `exporter` role with `pg_monitor` grant (idempotent via DO block)
- `group_vars/all.yml` — add `cadvisor_image`, `postgres_exporter_image`, `redis_exporter_image`, `blackbox_exporter_image`
- `vault.yml` — add `vault_miplata_db_exporter_password`
- `vault.yml.example` — mirror placeholder
- `tests/health-check.yml` — assert new containers + Prometheus targets up

**Touched networks (via templates):**
- `observability` — Alloy, Prometheus, Loki, Grafana, cAdvisor, blackbox, postgres-exporter, redis-exporter, miplata-api
- `proxy` — Traefik, Zot, miplata-web, Alloy (new member)
- `miplata_internal` — postgres, redis, miplata-api, postgres-exporter, redis-exporter

---

## Tasks

### Task 1: Add vault secret and var updates

**Files:** `vault.yml`, `vault.yml.example`, `group_vars/all.yml`

- Generate password: `openssl rand -hex 24`
- Add to vault.yml: `vault_miplata_db_exporter_password: "<generated>"`
- Add to vault.yml.example: `vault_miplata_db_exporter_password: "CHANGE_ME_HEX"`
- Add to group_vars/all.yml under Monitoring section:

```yaml
cadvisor_image: "gcr.io/cadvisor/cadvisor:v0.52.2"
postgres_exporter_image: "prometheuscommunity/postgres-exporter:v0.15.0"
redis_exporter_image: "oliver006/redis_exporter:v1.62.0"
blackbox_exporter_image: "prom/blackbox-exporter:v0.26.0"
```

- Commit: `feat(monitoring): Phase 2 vault secret and exporter image pins`

### Task 2: Enable Traefik Prometheus metrics

**Files:** `roles/traefik/templates/traefik.yml.j2`, `roles/traefik/templates/docker-compose.yml.j2`

`traefik.yml.j2` — add after `certificatesResolvers` block:

```yaml
entryPoints:
  web:
    address: ":80"
    ...
  websecure:
    address: ":443"
  metrics:
    address: ":8082"

metrics:
  prometheus:
    entryPoint: metrics
    addEntryPointsLabels: true
    addServicesLabels: true
    addRoutersLabels: true
```

`docker-compose.yml.j2` — no new port mapping needed (metrics is internal-only on proxy network; containers joining proxy can reach `traefik:8082`).

- Commit: `feat(traefik): enable Prometheus metrics on internal :8082 entrypoint`

### Task 3: Enable Zot metrics

**Files:** `roles/zot/templates/config.json.j2`

Add at top level (next to `"http"`):

```json
"extensions": {
  "metrics": {
    "enable": true,
    "prometheus": {
      "path": "/metrics"
    }
  }
}
```

- Commit: `feat(zot): enable built-in Prometheus metrics endpoint`

### Task 4: Add blackbox config

**Files:** `roles/monitoring/templates/blackbox.yml.j2` (new)

```yaml
modules:
  http_any_ok:
    prober: http
    timeout: 5s
    http:
      preferred_ip_protocol: "ip4"
      valid_status_codes: [200, 301, 302, 401]
      fail_if_not_ssl: true
      tls_config:
        insecure_skip_verify: false
  tcp_connect:
    prober: tcp
    timeout: 5s
```

- Commit: `feat(monitoring): blackbox probe modules (http_any_ok, tcp_connect)`

### Task 5: Rewrite Alloy config

**Files:** `roles/monitoring/templates/alloy-config.alloy.j2` (rewrite)

New content includes: Docker SD discovery + relabel, loki.source.docker with JSON-parse process stage, loki.source.journal, prometheus.scrape jobs for alloy-self/node_exporter/cadvisor/traefik/zot/postgres_exporter/redis_exporter/miplata_api, blackbox scrape job with relabel. Final remote_write to local Prom and Loki.

(Full file contents rendered in the execution step.)

- Commit: `feat(monitoring): Alloy Phase 2 config with Docker SD, journald, full scrape`

### Task 6: Rewrite monitoring docker-compose

**Files:** `roles/monitoring/templates/docker-compose.yml.j2`

Changes vs Phase 1:
- Add `cadvisor` service on `observability` network
- Add `blackbox-exporter` service on `observability` with config mount
- `alloy` service now joins `observability` + `proxy`, mounts `/var/run/docker.sock:ro` + `/var/log/journal:ro`, adds `extra_hosts: ["host.docker.internal:host-gateway"]`

- Commit: `feat(monitoring): add cAdvisor + blackbox + wire Alloy for Docker SD and host reach`

### Task 7: Add postgres-exporter + redis-exporter to miplata compose; miplata-api joins observability

**Files:** `roles/miplata/templates/docker-compose.yml.j2`

Changes:
- Add `observability` as external network at top
- `api` service: add `observability` to its networks list
- New `postgres-exporter` service on `internal` + `observability` with DSN env
- New `redis-exporter` service on `internal` + `observability` with REDIS_ADDR env

- Commit: `feat(miplata): postgres/redis exporter sidecars; api joins observability`

### Task 8: Provision postgres exporter role

**Files:** `roles/miplata/tasks/main.yml`

Add after the compose-up task:

```yaml
- name: Provision postgres exporter role
  shell: |
    docker exec -i miplata-postgres psql -v ON_ERROR_STOP=1 \
      -U {{ miplata_db_user }} -d {{ miplata_db_name }} <<'SQL'
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'exporter') THEN
        CREATE USER exporter WITH PASSWORD '{{ vault_miplata_db_exporter_password }}';
      END IF;
    END
    $do$;
    ALTER USER exporter WITH PASSWORD '{{ vault_miplata_db_exporter_password }}';
    GRANT pg_monitor TO exporter;
    SQL
  changed_when: false
  no_log: true
  register: exporter_provision
  until: exporter_provision.rc == 0
  retries: 5
  delay: 3
  when: miplata_image_check.stdout | length > 0
```

- Commit: `feat(miplata): provision read-only postgres exporter role`

### Task 9: Extend health-check

**Files:** `tests/health-check.yml`

Add after Alloy readiness:

```yaml
    - name: Verify cAdvisor is running
      assert:
        that: "'cadvisor' in running_containers.stdout_lines"

    - name: Verify blackbox-exporter is running
      assert:
        that: "'blackbox-exporter' in running_containers.stdout_lines"

    - name: Verify postgres-exporter is running
      assert:
        that: "'postgres-exporter' in running_containers.stdout_lines"
      when: miplata_image_check.stdout | length > 0

    - name: Verify redis-exporter is running
      assert:
        that: "'redis-exporter' in running_containers.stdout_lines"
      when: miplata_image_check.stdout | length > 0
```

After the TLS bearer-auth assertions, add a scrape-target query:

```yaml
    - name: Wait for all Phase 2 scrape targets to be up
      uri:
        url: http://127.0.0.1:9090/api/v1/query?query=up
        return_content: true
      register: up_query
      until: >
        (up_query.json.data.result | selectattr('metric.job', 'equalto', 'cadvisor') | list | length > 0) and
        (up_query.json.data.result | selectattr('metric.job', 'equalto', 'traefik') | list | length > 0)
      retries: 10
      delay: 6
```

Note: bind Prometheus to 127.0.0.1:9090 too so the health-check can reach it. Add `ports: ["127.0.0.1:9090:9090"]` to prometheus service in compose.

- Commit: `test(health-check): assert Phase 2 containers and scrape targets`

### Task 10: Apply + verify

- `ansible-lint playbook.yml`
- `ansible-playbook --check --diff --limit vps --vault-password-file .vault_pass playbook.yml`
- `ansible-playbook --limit vps --vault-password-file .vault_pass playbook.yml`
- `ansible-playbook --limit vps --vault-password-file .vault_pass tests/health-check.yml`
- Verify in Grafana Explore: `up` query returns ≥8 jobs all at 1.
- Verify a log query works: `{compose_service="traefik"}` returns recent lines.
