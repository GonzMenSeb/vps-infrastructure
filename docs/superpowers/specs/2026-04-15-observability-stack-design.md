# Observability Stack Design

**Status:** Approved (2026-04-15)
**Scope:** Infrastructure repo (`vps-infrastructure`) + separate app PR in `GonzMenSeb/miplata`

## Goals

Three goals drive every trade-off in this design:

1. **Dev debugging for miplata.** Deep visibility into the NestJS API: request rates, latency histograms per route, DB/cache timings, structured logs keyed by request ID so a single request can be traced end-to-end.
2. **At-a-glance health dashboard.** A polished overview board answering "is everything up and healthy?" covering both VPSs and all exposed services.
3. **Well-engineered showcase.** Provisioning-as-code, dashboards in git, bounded label cardinality, pinned versions, clean commits that tell a story.

Explicit non-goals: production SRE alerting/paging, high availability, off-box backups of metric/log data.

## Current state

The repo already has `roles/monitoring/` running Prometheus, Grafana, Loki, and Promtail on the main VPS, plus a host-level `node_exporter` systemd unit. The stack runs but is effectively unusable:

- No Traefik routing — Grafana/Prometheus/Loki bind on host ports 9090/3000/3100 with no TLS and no auth beyond Grafana's built-in.
- Stale scrape targets — Prometheus tries to scrape Jenkins at `host.docker.internal:8080`, but Jenkins moved to a separate VPS (178.105.0.118) in the April migration.
- No Docker container logs — Promtail only tails `/var/log/*.log` on the host, so miplata, Traefik, Zot, Vaultwarden, and Jenkins stdout/stderr never reach Loki.
- No cross-VPS coverage — the Jenkins VPS has zero instrumentation.
- No provisioned datasources or dashboards — fresh Grafana is empty Grafana.
- No metrics for Traefik, Zot, miplata, Postgres, Redis, or Jenkins itself.

## Architecture

Storage is centralized on the main VPS; collection is per-host. One agent (Grafana Alloy) runs on each VPS and handles both metrics and logs.

```
                      ┌────────────────────────────────────────────────────┐
                      │              MAIN VPS (148.113.172.15)             │
                      │                                                    │
  Internet ──TLS──►   │  Traefik ──┬──► grafana.web.  ──► Grafana          │
  (GitHub OAuth)      │            │   (OAuth-gated)                       │
                      │            ├──► loki-push.web. ──► Loki            │
  Jenkins VPS ──TLS──►│            │   (bearer-auth)                       │
  (Alloy push)        │            └──► prom-push.web. ──► Prometheus      │
                      │                 (bearer-auth)   (remote_write recv)│
                      │                                                    │
                      │  Alloy (local) ──scrapes──► node_exp, cAdvisor,    │
                      │                             Traefik, Zot,          │
                      │                             postgres-exp, redis-exp│
                      │                             miplata-api /metrics   │
                      │                             blackbox-exp probes    │
                      │                  ──tails──► Docker container logs  │
                      │                             (docker_sd_configs)    │
                      │                    ──►      local Prometheus+Loki  │
                      │                                                    │
                      │  Docker networks:                                  │
                      │   • proxy (Traefik ↔ grafana/loki-push/prom-push)  │
                      │   • observability (Prom ↔ Loki ↔ Grafana ↔ Alloy)  │
                      │   • miplata_internal joined by Alloy + exporters   │
                      └────────────────────────────────────────────────────┘

                      ┌────────────────────────────────────────────────────┐
                      │          JENKINS VPS (178.105.0.118)               │
                      │                                                    │
                      │  Alloy (local) ──scrapes──► node_exp, cAdvisor,    │
                      │                             Traefik, Jenkins       │
                      │                             (/prometheus plugin)   │
                      │                  ──tails──► Docker container logs  │
                      │                    ──HTTPS+bearer──►  loki-push /  │
                      │                                        prom-push   │
                      │                                       on main VPS  │
                      └────────────────────────────────────────────────────┘
```

### Four key architectural decisions

1. **Prometheus is both scraper and remote_write receiver.** Flag `--web.enable-remote-write-receiver` is enabled (stable since Prometheus 2.54). Local Alloy on the main VPS also uses remote_write to push into local Prometheus — keeping the ingest path symmetric with the Jenkins VPS so there is one path to reason about.
2. **Grafana is the only publicly reachable UI.** Loki and Prometheus are never exposed directly; they are queried exclusively through Grafana datasources using Grafana's proxy mode. One auth boundary.
3. **Push endpoints have bearer-token auth.** `loki-push.web.vespiridion.org` and `prom-push.web.vespiridion.org` are protected by a Traefik plugin middleware that validates `Authorization: Bearer <token>`. Token stored in `vault.yml`. This applies only to the cross-VPS path.
4. **Unified agent (Alloy) on every host.** Replaces Promtail. Both hosts run the same collector binary with different outputs: main VPS writes locally, Jenkins VPS pushes to the public endpoints.

## Components

### A. Main VPS — `roles/monitoring/` (rewrite of existing role)

| Component | Image | Purpose |
|---|---|---|
| Prometheus | `prom/prometheus:v3.11.2` | TSDB + scraper + remote_write receiver. Retention 30d. No UI exposed. |
| Loki | `grafana/loki:3.6.10` | Log storage. `filesystem` storage, compactor enabled, `retention_period: 336h` (14d), schema v13 with TSDB index. |
| Grafana | `grafana/grafana:12.4.3` | UI, provisioned datasources and dashboards, GitHub OAuth. |
| Alloy | `grafana/alloy:<pinned>` | Local collector; Docker SD + journald source + scrape targets below. Version pinned at implementation (expected `v1.5.x`). |
| cAdvisor | `gcr.io/cadvisor/cadvisor:v0.52.2` | Per-container CPU/mem/net/disk. |
| node_exporter | systemd binary `v1.9.0` | Host metrics. Kept as-is from current role. |
| postgres-exporter | `prometheuscommunity/postgres-exporter:v0.15.0` | miplata DB metrics. Joins `miplata_internal` network. |
| redis-exporter | `oliver006/redis_exporter:v1.62.0` | miplata Redis metrics. |
| blackbox-exporter | `prom/blackbox-exporter:v0.26.0` | HTTP/TCP probes against public endpoints. |

### B. Jenkins VPS — `roles/observability_agent/` (new role)

| Component | Image | Purpose |
|---|---|---|
| Alloy | Same pin as main VPS | Pushes metrics + logs to `prom-push.web.` and `loki-push.web.` with bearer token. |
| node_exporter | Same `v1.9.0` binary + systemd unit | Host metrics. Same pattern as main VPS. |
| cAdvisor | Same | Container metrics. |

`jenkins-playbook.yml` gains `observability_agent` as the last role after `docker`.

### C. Cross-cutting touch-ups in existing roles

| Role | Change | Why |
|---|---|---|
| `traefik` (both hosts) | Enable Prometheus metrics in `traefik.yml.j2` (`metrics.prometheus.entryPoint: metrics`), add `metrics` entryPoint on `:8082` bound to the `proxy` network, enable JSON access logs to stdout. | Alloy scrapes metrics and parses access logs. |
| `zot` | Enable `"metrics": {"enable": true, "prometheus": {"path": "/metrics"}}` in `config.json.j2`. | Zot built-in OpenMetrics. |
| `miplata` | Add postgres-exporter and redis-exporter as compose services on `miplata_internal`; add `api` service to the `observability` network so Alloy reaches `:3000/metrics`; create read-only Postgres `exporter_user`. | Enables DB/cache/app scraping. |
| `jenkins` | Install `prometheus` Jenkins plugin via CasC; enable `/prometheus` endpoint (no auth; reachable only inside `proxy` network). | Queue, executor, build metrics. |
| `base` | No structural change; Alloy's `loki.source.journal` component reads journald for ssh/fail2ban/UFW logs. | System logs into Loki. |

### D. Grafana provisioned content (`roles/monitoring/files/`)

- `datasources/prometheus.yml`, `datasources/loki.yml` — UID-pinned so dashboards reference stable IDs.
- `dashboards/provider.yml` — folder structure.
- Dashboards as JSON in `dashboards/`:
  - `overview.json` — service up/down table, HTTP 4xx/5xx on Traefik, disk/CPU/RAM per host, recent error log panel.
  - `host-detail.json` — node_exporter drill-down, templated by host.
  - `containers.json` — cAdvisor view, templated by host + container.
  - `miplata-api.json` — RED metrics per route, p50/p95/p99 latency, request-log panel joined by `request_id`.
  - `miplata-data.json` — Postgres (connections, slow queries, cache hit ratio, deadlocks) and Redis (memory, ops/sec, keyspace).
  - `traefik.json` — routers/services health, TLS cert expiry, request rate per host.
  - `jenkins.json` — build queue, executor utilization, job success/failure rate.
  - `logs-explorer.json` — Loki-centric board with log volume histogram and curated filter buttons.

### E. Miplata app PR (separate repo `GonzMenSeb/miplata`)

| Change | Files | Details |
|---|---|---|
| `/metrics` endpoint | `apps/api/src/main.ts`, new `apps/api/src/metrics.module.ts` | `@willsoto/nestjs-prometheus`; default Node process metrics + custom RED histograms per route via a global interceptor. |
| JSON structured logs | `apps/api/src/main.ts` | Replace default Nest logger with `nestjs-pino`; emit JSON with `request_id`, `user_id`, `route`, `status`, `latency_ms`. |
| Request ID middleware | `apps/api/src/middleware/request-id.middleware.ts` | Honors inbound `x-request-id` or generates a ULID; propagates to pino context. |
| Health endpoint | `apps/api/src/health.controller.ts` | Verify existing controller; add `@nestjs/terminus` checks for Postgres + Redis so blackbox probes are meaningful. |
| Compose network join | `docker-compose.yml.j2` in infra repo's `miplata` role | `api` service joins `observability` network (one-line change). |

The miplata repo state is not yet read — the PR plan begins by reading it, and any assumption here is validated before writing code.

## Data flow

### Metrics

- Main VPS: local Alloy scrapes all local targets at 15s intervals and remote_writes to local Prometheus over the `observability` Docker network.
- Jenkins VPS: local Alloy scrapes Jenkins-side targets and remote_writes to `https://prom-push.web.vespiridion.org` with bearer token.
- Labels applied to every sample: `host` (`vps` or `jenkins`), `instance`, `job`, `env: prod`. Container-scraped metrics additionally get `container`, `compose_service`, `image`.
- Prometheus external_labels add `cluster: vespiridion` for future federation.
- Remote_write batches in 1-second windows with WAL buffering on disk; an outage of the main VPS up to ~2 hours results in no metric loss on the Jenkins side.

### Logs

- Docker container logs: Alloy `discovery.docker` + `loki.source.docker` component tails all containers' JSON log files on the host; `loki.process` parses JSON and promotes a bounded set of fields to labels.
- journald: Alloy `loki.source.journal` picks up sshd, fail2ban, UFW, systemd unit logs.
- Traefik access logs: captured as stdout by docker_sd — pipeline parses JSON and extracts `status`, `method`, `host`, `path` as log fields (not labels).
- Jenkins VPS: Alloy pushes logs to `https://loki-push.web.vespiridion.org` with bearer token.

**Label cardinality discipline.** Labels are bounded: `host`, `container`, `compose_service`, `level`, `namespace` (one of `infra`, `miplata`, `ci`). Unbounded fields (`request_id`, `user_id`, `trace_id`, `path`, `status_code`, `latency_ms`) are kept in log bodies as structured fields, queried with `| json | status_code >= 500` in LogQL rather than as label selectors.

### Query path (user opens Grafana)

```
Browser ──HTTPS──► Traefik(main) ──OAuth middleware──► Grafana
                         │
                         │ (OAuth redirect to GitHub, callback back)
                         ▼
                     Grafana session cookie
                         │
                         ▼
                  Datasource proxy mode:
                   Prometheus: http://prometheus:9090  (docker network)
                   Loki:       http://loki:3100        (docker network)
```

OAuth scope: `read:user user:email`. Since `GonzMenSeb` is a personal GitHub account (not an org), login is restricted via Grafana's `role_attribute_path` with a JMES expression of the form `login == 'GonzMenSeb' && 'Admin' || ''` — users matching the expression get `Admin`, everyone else gets an empty role and is denied. Local `admin` account retained as break-glass. Datasources use Grafana's proxy mode so Prometheus and Loki never face the browser directly.

Dashboard auto-refresh: 30s default, 5s on the miplata-api deep-dive board.

### Push-endpoint auth

Traefik plugin middleware validates `Authorization: Bearer <token>` against `vault_observability_push_token`. The specific plugin is chosen at implementation time after reviewing plugins.traefik.io for active maintenance; if no suitable plugin is available, fallback is a `forwardAuth` middleware pointed at a small nginx container with a `location /verify` that returns 401 unless the bearer header matches.

## Error handling and failure modes

| What fails | What still works | What we lose | Mitigation |
|---|---|---|---|
| Grafana down | Collection, storage, all apps | UI only | `restart: unless-stopped`; Prometheus+Loki keep ingesting. |
| Prometheus down | Grafana, Loki, Alloy (buffers) | New metric queries | Alloy WAL buffers up to ~2h on disk; catches up on recovery. |
| Loki down | Grafana, Prometheus, Alloy (buffers) | New log queries | Same Alloy WAL buffering. |
| Alloy on main VPS dies | Cross-VPS push path intact | Local container logs/metrics gap | `restart: unless-stopped`; Prometheus sees `up{job="alloy"}` go to 0 (main Alloy scrapes itself). |
| Alloy on Jenkins dies | Main VPS observability intact | Jenkins-side gap | `restart: unless-stopped`; detected by staleness of pushed samples (`absent_over_time(up{host="jenkins"}[5m])`) on the overview dashboard. Blackbox probe of `jenkins.web.vespiridion.org` provides an independent VPS-level liveness signal. |
| Traefik plugin breaks | Internal stack fine | Jenkins push blocked | Fallback to `forwardAuth` + nginx documented in role README. |
| GitHub OAuth outage | Admin local login works | New SSO logins | Vault-stored admin password as break-glass; login form not hidden. |
| Disk fills on main VPS | Nothing | Everything | Retention caps (30d metrics, 14d logs), cAdvisor storage-driver limits, filesystem-free panel on overview with thresholds. |
| Bearer token leaks | n/a | Attacker can push junk | Rotation documented; token only accepted at push endpoints, not local ingest. |
| miplata `/metrics` exposed publicly | n/a | PII risk | Endpoint reachable only via `observability` Docker network; no Traefik label. |

### Apply-time handling

- `community.docker.docker_compose_v2` failures halt the play; no auto-rollback (matches existing repo convention).
- Alloy config syntax errors cause a restart loop detected by a post-task `uri: url=http://localhost:12345/-/ready` check with `retries: 10 delay: 3`. The play fails if Alloy never becomes ready.
- OAuth credentials missing on first apply: Grafana starts without the OAuth provider; admin login still works. Documented as: log in as admin, register GitHub OAuth app, add client id/secret to vault, re-apply.
- Jenkins push endpoint unreachable at apply time: Alloy buffers to WAL and retries. The playbook does not fail.

### Deliberately not handled

- Alertmanager / paging on failures.
- High availability for any observability component.
- Off-box backup of Prometheus TSDB or Loki chunks — retention is deliberate; loss on disk failure is acceptable.

## Testing

The repo's testing pattern is one `tests/health-check.yml` Ansible playbook that runs post-deploy assertions against the real VPS. This design matches that.

### 1. Extend `tests/health-check.yml` — main VPS

- Assert new containers running: `grafana`, `prometheus`, `loki`, `alloy`, `cadvisor`, `postgres-exporter`, `redis-exporter`, `blackbox-exporter`.
- `uri https://grafana.web.vespiridion.org/api/health` → 200, valid TLS.
- `uri https://grafana.web.vespiridion.org/login` → 200 (admin fallback reachable).
- `uri https://loki-push.web.vespiridion.org/ready` with no bearer → 401.
- Same URL with `Authorization: Bearer {{ vault_observability_push_token }}` → 200.
- `uri https://prom-push.web.vespiridion.org/-/ready` with bearer → 200.
- `docker exec alloy wget -qO- localhost:12345/-/ready` → 200.
- Query Prometheus `/api/v1/targets`: assert all jobs (`alloy`, `node_exporter`, `cadvisor`, `traefik`, `zot`, `postgres_exporter`, `redis_exporter`, `blackbox`, `miplata_api`) are `up`.
- Query Loki `/loki/api/v1/labels`: assert `host`, `container`, `compose_service` present.
- Query Prometheus: `up{host="jenkins"}` over last 5m equals 1.

### 2. New `tests/jenkins-health-check.yml` — Jenkins VPS

The repo currently has no test coverage for the Jenkins VPS. This design fixes that as a side-effect.

- SSH reachable, UFW active, fail2ban running, Docker running.
- Containers: `traefik`, `jenkins`, `alloy`, `cadvisor`.
- `node_exporter` systemd unit active.
- Alloy `/-/ready` → 200.
- Alloy `/metrics` shows non-zero remote_write attempts.

### 3. Manual acceptance checklist (in PR description of Phase 4)

- [ ] Private browser window → `https://grafana.web.vespiridion.org` → GitHub OAuth flow completes, logged in as Admin.
- [ ] "Overview" dashboard shows both hosts' CPU/mem and all public probes green.
- [ ] "Miplata API" dashboard shows non-zero request rate after a few public `curl` hits.
- [ ] Grafana Explore → Loki → `{compose_service="miplata-api"} | json | status >= 500` returns filtered lines.
- [ ] Kill `miplata-api` container → blackbox probe goes red in overview within ~30s → restart → goes green.

### 4. Miplata app PR tests

- Unit test for the request-id middleware (ULID generated when header absent, pass-through when present).
- E2E test that `GET /metrics` returns Prometheus exposition format and includes the RED histograms.

### Not tested

- Dashboard JSON correctness (Grafana validates on provisioning reload; caught by the acceptance step).
- Alloy config correctness beyond `/ready` (Alloy validates at startup; container won't come up if bad).
- Metric value accuracy (trusting upstream exporters).

## Implementation phases

Five PRs. Each phase independently deployable and revertable via `git revert <merge-commit>` + re-run of the relevant playbook. No destructive migrations.

### Phase 1 — Foundation

**Scope:**
- Rewrite `roles/monitoring/`: Alloy container, Prometheus with `--web.enable-remote-write-receiver`, Loki with 14d retention and v13 TSDB schema, Grafana with GitHub OAuth + provisioned Prometheus/Loki datasources.
- Traefik routes for `grafana.web.`, `loki-push.web.`, `prom-push.web.`.
- Traefik plugin middleware for bearer-token validation on push endpoints.
- Add `vault_observability_push_token`, `vault_grafana_oauth_client_id`, `vault_grafana_oauth_client_secret` to `vault.yml`.
- Extend `tests/health-check.yml` with container, TLS, and bearer-auth assertions.

**Acceptance:**
- `ansible-playbook playbook.yml --tags monitoring` green.
- `tests/health-check.yml` green.
- Grafana loads over HTTPS, OAuth redirect works, both datasources listed in Grafana UI.

### Phase 2 — Local coverage

**Scope:**
- Alloy on main VPS: `docker_sd` for container logs, `journald` source, scrape jobs for node_exporter, cAdvisor (new container in monitoring role), Traefik metrics (enable in `roles/traefik/`), Zot metrics (enable in `roles/zot/config.json.j2`).
- Postgres-exporter and redis-exporter sidecars (new services in `roles/miplata/`).
- Read-only `exporter_user` provisioned in miplata Postgres.
- Blackbox-exporter in monitoring role with probe module config.

**Acceptance:**
- Prometheus `/api/v1/targets` shows all scrapes `up`.
- Loki `{compose_service=~".+"}` returns lines from every container.
- Blackbox probes every configured public endpoint (miplata, vault, dns-admin, traefik dashboard, zot, grafana); all green.

### Phase 3 — Cross-VPS

**Scope:**
- New `roles/observability_agent/` with Alloy + node_exporter + cAdvisor.
- Apply to Jenkins VPS via `jenkins-playbook.yml`.
- Alloy configured with remote_write to `prom-push.web.` and Loki push to `loki-push.web.` using bearer token from vault.
- Enable Jenkins `prometheus` plugin via CasC.
- New `tests/jenkins-health-check.yml`.

**Acceptance:**
- `up{host="jenkins"} == 1` in Prometheus.
- Loki shows Jenkins container logs under `host="jenkins"`.
- Both health-check playbooks green.

### Phase 4 — Dashboards + probes

**Scope:**
- 8 dashboards provisioned as JSON in `roles/monitoring/files/dashboards/`: overview, host-detail, containers, miplata-api, miplata-data, traefik, jenkins, logs-explorer.
- Folder structure via `dashboards/provider.yml`.
- Manual acceptance checklist included in PR description.

**Acceptance:**
- All 8 dashboards load without "Data source not found" errors.
- Overview shows live data from both VPSs.
- Manual acceptance checklist ticked off in PR description.

### Phase 5 — Miplata app PR (separate repo)

**Scope:**
- `@willsoto/nestjs-prometheus` integration with RED histograms per route.
- `/metrics` endpoint.
- `nestjs-pino` JSON logger.
- Request-id middleware (ULID, honors inbound header).
- `@nestjs/terminus` health endpoint with Postgres + Redis checks.
- Compose network join (one-line change in infra repo's miplata role).
- Unit tests for middleware and `/metrics`.

**Acceptance:**
- Miplata CI green.
- `curl miplata-api:3000/metrics` from Alloy container returns Prometheus exposition format.
- Miplata-api dashboard populates with RED histograms.
- Loki logs from miplata show structured fields.

### Inter-phase dependencies

- Phase 2 depends on Phase 1 (needs the remote_write receiver and push endpoints).
- Phase 3 depends on Phase 1 (needs push endpoints).
- Phase 4 depends on Phases 2 and 3 (dashboards need real data to validate).
- Phase 5 app-side changes can be developed in parallel but land meaningfully only after Phase 4.

## Out-of-scope follow-ups

- Alertmanager + alert rules (SRE goal explicitly declined).
- Restic backup of Prometheus TSDB and Loki chunks.
- Distributed tracing (Tempo + OpenTelemetry) — natural next step after pino + request-id land.
- Long-term log archival to S3/B2 for >14d retention.
