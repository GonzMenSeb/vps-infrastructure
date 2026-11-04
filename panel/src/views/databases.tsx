import { Layout } from "./layout";
import { Chip, LiveFrame, SourceNote } from "./components";
import type { DbCardVM, DatabasesVM, ServiceDatabasesVM } from "./databases-model";
import { hasData } from "./model";
import type { Chrome } from "./overview";

export function DbCard({ c, withService }: { c: DbCardVM; withService: boolean }) {
  return (
    <section class="panel" aria-label={`${c.engine} ${c.container}`}>
      <header>
        <h2>{c.engine}</h2>
        <Chip tone={c.health.tone} title={c.health.detail ?? undefined}>
          {c.health.label}
        </Chip>
        {c.sourceStatus ? <SourceNote status={c.sourceStatus} /> : null}
        <span class="sub">
          {withService ? (
            <a href={`/services/${encodeURIComponent(c.serviceId)}`}>{c.serviceName}</a>
          ) : (
            <span class="mono">{c.container}</span>
          )}
        </span>
      </header>
      <div class="body">
        {c.metrics.length ? (
          <div class="metrics">
            {c.metrics.map((m) => (
              <div class="metric" title={m.title ?? undefined}>
                <div class="label">{m.label}</div>
                <div class="val">
                  {m.value}
                  {m.unit ? <small>{m.unit}</small> : null}
                </div>
                {m.sub ? <div class="hint">{m.sub}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {c.health.detail ? <p class={`hint${c.metrics.length ? " mt" : ""}`}>{c.health.detail}</p> : null}
        {c.note ? <p class={`hint${c.metrics.length || c.health.detail ? " mt" : ""}`}>{c.note}</p> : null}
        <dl class="kv mt">
          <dt>Container</dt>
          <dd class="mono">{c.container}</dd>
          <dt>Numbers from</dt>
          <dd>{c.source === "prometheus" ? "Prometheus exporter" : c.source === "powerdns" ? "PowerDNS statistics API" : "Nothing yet; container state only"}</dd>
        </dl>
      </div>
    </section>
  );
}

export function DatabaseTab({ vm }: { vm: ServiceDatabasesVM | null }) {
  if (!vm || vm.cards.length === 0) {
    return (
      <section class="panel" aria-label="Database">
        <header>
          <h2>Database</h2>
        </header>
        <div class="body muted">The manifest lists no database for this service.</div>
      </section>
    );
  }
  return (
    <div class="stack">
      {vm.cards.map((c) => (
        <DbCard c={c} withService={false} />
      ))}
    </div>
  );
}

export function DatabasesFrame({ vm }: { vm: DatabasesVM }) {
  return (
    <LiveFrame up={vm.up}>
      <h1>Databases</h1>
      <p class="lede">Health of every database behind a service. Numbers come from the exporters Prometheus already scrapes; a database without an exporter shows its container state only.</p>
      {hasData(vm.docker) ? null : (
        <div class="bar">
          <SourceNote status={vm.docker} named={true} />
        </div>
      )}
      {vm.cards.length ? (
        <div class="stack">
          {vm.cards.map((c) => (
            <DbCard c={c} withService={true} />
          ))}
        </div>
      ) : (
        <section class="panel" aria-label="Databases">
          <div class="body muted">The manifest lists no databases.</div>
        </section>
      )}
    </LiveFrame>
  );
}

export function DatabasesPage({ chrome, vm }: { chrome: Chrome; vm: DatabasesVM }) {
  return (
    <Layout title="Databases" login={chrome.login} csrf={chrome.csrf} current="databases" up={vm.up} refresh={true}>
      <DatabasesFrame vm={vm} />
    </Layout>
  );
}
