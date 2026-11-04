import { Layout } from "./layout";
import { ActionForm, ResultChipView } from "./jobs";
import { Chip, LiveFrame, Meter, Placeholder, SourceEmpty, SourceNote, StateChip, fmtCpu, fmtMem } from "./components";
import { DOCKER_HOST, fmtBytes, fmtRate, hasData, shortImage, type ContainerRow, type ServiceVM } from "./model";
import type { Chrome } from "./overview";
import { ActionBanner, RollbackRow, SwitchControl } from "./service-actions";

const NA = "—";

export const serviceHref = (id: string, tab = "summary") =>
  `/services/${encodeURIComponent(id)}${tab === "summary" ? "" : `?tab=${encodeURIComponent(tab)}`}`;

function containerChip(r: ContainerRow, onDocker: boolean, dockerOk: boolean) {
  if (!onDocker) return r.metricsSeen ? <Chip tone="info">Reporting</Chip> : <Chip>Unknown</Chip>;
  if (!dockerOk) return <Chip>Unknown</Chip>;
  if (!r.found) return <Chip>Missing</Chip>;
  if (r.state === "restarting") return <Chip tone="bad" pulse={true}>Restarting</Chip>;
  if (r.state === "dead") return <Chip tone="bad">Dead</Chip>;
  if (r.health === "unhealthy") return <Chip tone="bad">Unhealthy</Chip>;
  if (r.state !== "running") return <Chip>{r.state ? r.state[0]!.toUpperCase() + r.state.slice(1) : "Unknown"}</Chip>;
  if (r.health === "starting") return <Chip tone="warn">Starting</Chip>;
  return <Chip tone="ok">{r.health === "healthy" ? "Up · healthy" : "Up"}</Chip>;
}

function Summary({ vm }: { vm: ServiceVM }) {
  const s = vm.summary;
  const svc = vm.service;
  const onDocker = svc.host === DOCKER_HOST;
  const dockerOk = hasData(vm.sources.docker);
  const primary = vm.containers.find((c) => c.found);
  const memPct = s.memBytes !== null && vm.hostMemTotal ? (s.memBytes / vm.hostMemTotal) * 100 : null;
  return (
    <div class="grid2-1">
      <div class="stack">
        <section class="panel" aria-label="Running image">
          <header>
            <h2>Running image</h2>
            {onDocker ? <SourceNote status={vm.sources.docker} /> : null}
          </header>
          <div class="body">
            <dl class="kv">
              <dt>Image</dt>
              <dd class="mono">{primary?.image ?? (svc.images[0] ? `${svc.images[0]} (from the manifest)` : NA)}</dd>
              {primary?.imageId ? (
                <>
                  <dt>Image ID</dt>
                  <dd class="mono">{primary.imageId.slice(0, 19)}…</dd>
                </>
              ) : null}
              <dt>Revision</dt>
              <dd class={vm.revision ? "mono" : "muted"}>{vm.revision ?? "Not collected yet"}</dd>
              <dt>Status</dt>
              <dd>{primary?.status ?? (onDocker ? (dockerOk ? "No container" : "Unknown") : "Read-only host")}</dd>
            </dl>
            <RollbackRow a={vm.actions} />
          </div>
        </section>
        <section class="panel" aria-label="Containers">
          <header>
            <h2>Containers</h2>
          </header>
          <div class="tablewrap">
            <table>
              <tbody>
                {vm.containers.map((c) => (
                  <tr>
                    <td class="mono">{c.name}</td>
                    <td>{containerChip(c, onDocker, dockerOk)}</td>
                    <td class="mono muted" title={c.image ?? undefined}>
                      {c.image ? shortImage(c.image) : ""}
                    </td>
                    <td class="sec small">{c.status ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <section class="panel" aria-label="Resources">
        <header>
          <h2>Resources</h2>
          <SourceNote status={vm.sources.prom} />
        </header>
        {hasData(vm.sources.prom) ? (
          s.memBytes === null && s.cpuPct === null ? (
            <div class="body muted">
              No container of {svc.name} reports metrics on {svc.host}.
              {s.diskBytes !== null ? ` It holds ${fmtBytes(s.diskBytes)} of disk.` : ""}
            </div>
          ) : (
            <div class="body">
              <div class="meters">
                <Meter
                  label="Memory"
                  text={`${fmtMem(s.memBytes)}${vm.hostMemTotal ? ` of ${fmtBytes(vm.hostMemTotal)} host` : ""}`}
                  pct={memPct ?? 0}
                  c="mem"
                />
                <Meter
                  label="CPU"
                  text={`${fmtCpu(s.cpuPct)} of ${s.cpuBasis === "host" && s.cores ? `${s.cores} cores` : "one core"}`}
                  pct={s.cpuPct ?? 0}
                  c="cpu"
                />
              </div>
              <dl class="kv mt">
                <dt>Network</dt>
                <dd class="mono">
                  ↓ {s.rxBps !== null ? fmtRate(s.rxBps) : NA} · ↑ {s.txBps !== null ? fmtRate(s.txBps) : NA}
                </dd>
                <dt>Disk</dt>
                <dd class="mono">
                  {s.diskBytes !== null ? fmtBytes(s.diskBytes) : onDocker ? (hasData(vm.sources.df) ? NA : "Waiting for Docker disk usage") : "Not collected on this host"}
                </dd>
                <dt>Share of host RAM</dt>
                <dd class="mono">{memPct !== null ? `${memPct.toFixed(1)}%` : NA}</dd>
              </dl>
            </div>
          )
        ) : (
          <SourceEmpty status={vm.sources.prom} what="resources" />
        )}
      </section>
    </div>
  );
}

function Config({ vm }: { vm: ServiceVM }) {
  const svc = vm.service;
  const onDocker = svc.host === DOCKER_HOST;
  const apply = `ansible-playbook ${svc.playbook}${svc.tags.length ? ` --tags ${svc.tags.join(",")}` : ""}`;
  const p = vm.summary.protection;
  return (
    <div class="grid2">
      <section class="panel" aria-label="Ansible">
        <header>
          <h2>Ansible</h2>
          <span class="sub mono">{svc.playbook}</span>
        </header>
        <div class="body">
          <dl class="kv">
            <dt>Role</dt>
            <dd class="mono">roles/{svc.role}</dd>
            <dt>Apply only this</dt>
            <dd>
              <pre class="code">{apply}</pre>
              {svc.tags.length ? null : <p class="hint">This role has no tag, so it runs with the whole playbook.</p>}
            </dd>
            <dt>Host</dt>
            <dd>{svc.host}</dd>
            <dt>Directory</dt>
            <dd class="mono">{svc.dir}</dd>
            <dt>Jenkins job</dt>
            <dd class={svc.jenkins_job ? "mono" : "muted"}>{svc.jenkins_job ?? "None"}</dd>
            <dt>Base service</dt>
            <dd>{svc.core ? "Yes" : "No"}</dd>
          </dl>
          <h3 class="mt">From the services manifest</h3>
          <div class="labels">
            {svc.hostname ? (
              <div>
                <span>hostname</span>
                <span>{svc.hostname}</span>
              </div>
            ) : null}
            {svc.containers.map((c) => (
              <div>
                <span>container</span>
                <span>{c}</span>
              </div>
            ))}
            {svc.images.map((i) => (
              <div>
                <span>image</span>
                <span>{i}</span>
              </div>
            ))}
            {svc.db.map((d) => (
              <div>
                <span>{d.kind}</span>
                <span>{d.container}</span>
              </div>
            ))}
          </div>
          <h3 class="mt">Secrets</h3>
          {svc.auth.vault_vars.length || svc.auth.env_keys.length ? (
            <div class="labels">
              {svc.auth.vault_vars.map((v) => (
                <div>
                  <span>vault</span>
                  <span>{v}</span>
                </div>
              ))}
              {svc.auth.env_keys.map((k) => (
                <div>
                  <span>.env</span>
                  <span>{k}</span>
                </div>
              ))}
            </div>
          ) : (
            <p class="hint">The manifest lists no secrets for this service.</p>
          )}
          <p class="hint mt">Only names are shown. Revealing values arrives in Phase 6.</p>
        </div>
      </section>
      <section class="panel" aria-label="Traefik">
        <header>
          <h2>Traefik</h2>
          {onDocker ? <SourceNote status={vm.sources.docker} extra="container labels" /> : null}
        </header>
        <div class="body">
          {!onDocker ? (
            <p class="muted">
              {svc.name} runs on the {svc.host} host. The panel cannot read that host's Docker labels, so its router is not shown.
            </p>
          ) : !hasData(vm.sources.docker) ? (
            <SourceEmpty status={vm.sources.docker} what="the Traefik routers" />
          ) : vm.routers.length === 0 ? (
            <p class="muted">
              {svc.hostname
                ? vm.containers.some((c) => c.found)
                  ? `No container of ${svc.name} carries a Traefik router.`
                  : `No container of ${svc.name} exists, so there are no labels to read.`
                : "This service has no public route."}
            </p>
          ) : (
            vm.routers.map((r) => (
              <dl class="kv">
                <dt>Router</dt>
                <dd class="mono">
                  {r.name}@docker <span class="muted">on {r.container}</span>
                </dd>
                <dt>Rule</dt>
                <dd class="mono">{r.rule ?? NA}</dd>
                <dt>Entrypoints</dt>
                <dd class="mono">{r.entrypoints ?? "default"}</dd>
                <dt>TLS</dt>
                <dd>
                  {r.certresolver ? (
                    <>
                      <span class="mono">{r.certresolver}</span> resolver
                    </>
                  ) : (
                    "No certificate resolver"
                  )}
                  {vm.tlsDaysLeft !== null ? (
                    <>
                      {" "}
                      <Chip tone={vm.tlsDaysLeft < 14 ? "bad" : vm.tlsDaysLeft < 30 ? "warn" : "ok"} lamp={false}>
                        {vm.tlsDaysLeft} days left
                      </Chip>
                    </>
                  ) : (
                    <span class="muted"> · expiry not collected yet</span>
                  )}
                </dd>
                <dt>Middlewares</dt>
                <dd class="mono">
                  {r.middlewares.length
                    ? r.middlewares.map((m) => `${m.ref}${m.kind ? ` (${m.kind})` : ""}`).join(", ")
                    : "none"}
                </dd>
                <dt>Backend port</dt>
                <dd class="mono">{r.port ?? "detected by Traefik"}</dd>
              </dl>
            ))
          )}
          <dl class="kv">
            <dt>Protection</dt>
            <dd>
              <b>{p.label}</b>
              {p.detail ? <div class="hint">{p.detail}</div> : null}
            </dd>
          </dl>
          {vm.labels.length ? (
            <>
              <h3 class="mt">Container labels</h3>
              <div class="labels">
                {vm.labels.map((l) => (
                  <div>
                    <span>{l.key}</span>
                    {l.hidden ? <span class="muted nowrap">hidden</span> : <span>{l.value}</span>}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Auth({ vm }: { vm: ServiceVM }) {
  const a = vm.service.auth;
  const kind: Record<typeof a.kind, string> = {
    "basic-auth-hash": "Traefik basic-auth (only the hash is stored)",
    env: "Secrets rendered into .env",
    vault: "Secrets kept in vault.yml",
    none: "No secrets",
  };
  return (
    <section class="panel" aria-label="Auth">
      <header>
        <h2>Auth</h2>
      </header>
      <Placeholder phase={6}>Revealing and editing logins and secrets arrives in Phase 6, through the panel-secrets Jenkins job.</Placeholder>
      <div class="body">
        <dl class="kv">
          <dt>Manifest kind</dt>
          <dd>{kind[a.kind]}</dd>
          <dt>Gate at Traefik</dt>
          <dd>{vm.summary.protection.label}</dd>
        </dl>
      </div>
    </section>
  );
}

function Builds({ vm }: { vm: ServiceVM }) {
  const b = vm.builds;
  const job = vm.service.jenkins_job;
  return (
    <section class="panel" aria-label="Builds">
      <header>
        <h2>Builds</h2>
        {job ? <span class="sub mono">{job}</span> : null}
        {b ? <SourceNote status={b.status} /> : null}
        {b?.run ? <ActionForm a={b.run} /> : null}
      </header>
      {!job || !b ? (
        <div class="body muted">The manifest lists no Jenkins job for this service.</div>
      ) : !hasData(b.status) ? (
        <SourceEmpty status={b.status} what={`runs of ${job}`} />
      ) : !b.inJenkins ? (
        <div class="body muted">Jenkins has no job called {job} yet.</div>
      ) : b.rows.length ? (
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Result</th>
                <th>Started</th>
                <th class="num">Took</th>
                <th>Triggered by</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr>
                  <td>
                    <a class="rowlink" href={r.consoleHref}>
                      <b class="mono">#{r.number}</b>
                    </a>
                  </td>
                  <td>
                    <ResultChipView r={r.result} />
                  </td>
                  <td title={r.startedTitle}>{r.startedText}</td>
                  <td class="num mono">{r.tookText}</td>
                  <td class="sec">{r.cause ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="body muted">{job} has not run yet.</div>
      )}
      {b?.allHref ? (
        <div class="body">
          <a href={b.allHref}>All runs of {job}</a>
          {b.queued ? <span class="muted"> · {b.queued} waiting</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function Database({ vm }: { vm: ServiceVM }) {
  return (
    <section class="panel" aria-label="Database">
      <header>
        <h2>Database</h2>
      </header>
      <Placeholder phase={4}>Database health from the Postgres and Redis exporters arrives in Phase 4.</Placeholder>
      <div class="tablewrap">
        <table>
          <tbody>
            {vm.service.db.map((d) => {
              const c = vm.containers.find((x) => x.name === d.container);
              return (
                <tr>
                  <td class="mono">{d.container}</td>
                  <td>{d.kind}</td>
                  <td>{c ? containerChip(c, vm.service.host === DOCKER_HOST, hasData(vm.sources.docker)) : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const TABS = { summary: Summary, config: Config, auth: Auth, builds: Builds, db: Database };

export function ServiceFrame({ vm }: { vm: ServiceVM }) {
  const s = vm.summary;
  const svc = vm.service;
  const Tab = TABS[vm.tab];
  return (
    <LiveFrame up={vm.up}>
      <div class="crumb">
        <a href="/services">Services</a> / {svc.name}
      </div>
      <div class="svc-head">
        <div>
          <h1>
            {svc.name} <StateChip state={s.state} />
          </h1>
          <div class="sec">
            {svc.hostname ? (
              <>
                <a class="mono" href={`https://${svc.hostname}`} target="_blank" rel="noopener noreferrer">
                  https://{svc.hostname}
                </a>{" "}
                ·{" "}
              </>
            ) : null}
            on {svc.host} · <span class="mono">{svc.dir}</span>
          </div>
        </div>
        {vm.logsHref || vm.actions?.toggle ? (
          <div class="acts">
            {vm.logsHref ? (
              <a class="btn" href={vm.logsHref}>
                View logs
              </a>
            ) : null}
            {vm.actions?.toggle ? <SwitchControl t={vm.actions.toggle} /> : null}
          </div>
        ) : null}
      </div>
      {svc.core ? (
        <div class="alert info mt">
          <span>ⓘ</span>
          <span>{svc.name} is part of the base layer. The panel will not offer to switch it off.</span>
        </div>
      ) : null}
      {s.readOnly ? (
        <div class="alert info mt">
          <span>ⓘ</span>
          <span>
            {svc.name} runs on the {svc.host} host. The panel cannot reach that host's Docker, so this page is read-only.
          </span>
        </div>
      ) : null}
      <ActionBanner a={vm.actions} core={svc.core} />
      <nav class="tabs" aria-label={`${svc.name} sections`}>
        {vm.tabs.map((t) => (
          <a href={serviceHref(svc.id, t.id)} aria-current={t.id === vm.tab ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <Tab vm={vm} />
    </LiveFrame>
  );
}

export function ServicePage({ chrome, vm }: { chrome: Chrome; vm: ServiceVM }) {
  return (
    <Layout title={vm.service.name} login={chrome.login} csrf={chrome.csrf} current="services" up={vm.up} refresh={true}>
      <ServiceFrame vm={vm} />
    </Layout>
  );
}
