import { Layout } from "./layout";
import { Chip, HostCard, LiveFrame, SourceEmpty, SourceNote, Track, Treemap, type Tone } from "./components";
import { hasData, type OverviewVM } from "./model";


export interface Chrome {
  login: string;
  csrf: string;
}

export function OverviewFrame({ vm }: { vm: OverviewVM }) {
  return (
    <LiveFrame up={vm.up}>
      <section class="panel mb" aria-label="Request path">
        <header>
          <h2>Request path</h2>
          <SourceNote status={vm.sources.docker} />
        </header>
        <div class="path">
          <div class="node">
            <b>Internet</b>
            <span>:80 · :443</span>
          </div>
          <div class="wire"></div>
          <div class="node hub">
            <b>{vm.traefik.label}</b>
            <span>{vm.traefik.tls ?? "TLS resolver not reported"}</span>
          </div>
          <div class="wire"></div>
          {vm.path.length ? (
            <div class="svcs">
              {vm.path.map((p) => (
                <a class={`svc ${p.state}`} href={`/services/${encodeURIComponent(p.id)}`} title={p.hostname}>
                  <span class="lamp"></span>
                  <span>
                    <span class="n">{p.name}</span>
                    <span class="h">{p.short}</span>
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <p class="muted">The manifest lists no public service on this host.</p>
          )}
        </div>
      </section>
      <div class="grid2 mb">
        {vm.hosts.map((h) => (
          <HostCard vm={h} compact={true} />
        ))}
      </div>
      <div class="grid2-1">
        <div class="stack">
          <section class="panel" aria-label="Building now">
            <header>
              <h2>Building now</h2>
              <span class="sub">
                <SourceNote status={vm.building.status} /> <a href="/jobs">Jobs</a>
              </span>
            </header>
            {hasData(vm.building.status) ? (
              vm.building.rows.length ? (
                <table>
                  <tbody>
                    {vm.building.rows.map((b) => (
                      <tr>
                        <td>
                          <a class="rowlink" href={b.consoleHref}>
                            <b>{b.job}</b> <span class="muted mono">#{b.number}</span>
                          </a>
                          {b.cause ? <div class="muted">{b.cause}</div> : null}
                        </td>
                        <td class="progress">
                          {b.progressPct !== null ? <Track pct={b.progressPct} c="cpu" /> : <span class="muted">No estimate</span>}
                        </td>
                        <td class="num mono">{b.tookText}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div class="body muted">
                  Nothing is building.{vm.building.queued ? ` ${vm.building.queued} waiting in the queue.` : ""}
                </div>
              )
            ) : (
              <SourceEmpty status={vm.building.status} what="running builds" />
            )}
          </section>
          <section class="panel" aria-label="Biggest users of the main host">
            <header>
              <h2>Biggest users of the main host</h2>
              <span class="sub">
                <a href="/hosts/vps">Hosts</a>
              </span>
            </header>
            <Treemap vm={vm.treemap} />
          </section>
        </div>
        <section class="panel" aria-label="Needs attention">
          <header>
            <h2>Needs attention</h2>
          </header>
          {vm.sources.docker.state === "loading" || vm.sources.docker.state === "off" ? (
            <SourceEmpty status={vm.sources.docker} what="service health" />
          ) : null}
          {vm.attention.map((a) => (
            <div class="tag top-align">
              <Chip tone={a.tone as Tone} lamp={false}>
                {a.tag}
              </Chip>
              <div class="grow">
                <a class="att" href={a.href}>
                  {a.title}
                </a>
                <div class="sec small">{a.detail}</div>
              </div>
            </div>
          ))}
          {vm.attention.length === 0 && hasData(vm.sources.docker) ? <div class="body muted">Nothing needs attention.</div> : null}
        </section>
      </div>
    </LiveFrame>
  );
}

export function OverviewPage({ chrome, vm }: { chrome: Chrome; vm: OverviewVM }) {
  return (
    <Layout title="Overview" login={chrome.login} csrf={chrome.csrf} current="overview" up={vm.up} refresh={true}>
      <h1>Overview</h1>
      <p class="lede">Every host, every service, and whatever is building right now.</p>
      <OverviewFrame vm={vm} />
    </Layout>
  );
}
