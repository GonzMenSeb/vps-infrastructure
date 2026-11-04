import { Layout } from "./layout";
import { LiveFrame, SourceEmpty, SourceNote, StateChip, fmtCpu, fmtMem } from "./components";
import { hasData, shortImage, type ServicesVM } from "./model";
import type { Chrome } from "./overview";

export function ServicesFrame({ vm }: { vm: ServicesVM }) {
  return (
    <LiveFrame up={vm.up}>
      <section class="panel" aria-label="Services">
        <header>
          <h2>Services</h2>
          <SourceNote status={vm.sources.docker} />
          {vm.sources.prom.state === "stale" ? <SourceNote status={vm.sources.prom} named={true} /> : null}

        </header>
        {hasData(vm.sources.docker) ? null : <SourceEmpty status={vm.sources.docker} what="container state" />}
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Host</th>
                <th>State</th>
                <th>Running</th>
                <th class="num">Memory</th>
                <th class="num">CPU</th>
                <th>Protection</th>
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((s) => (
                <tr>
                  <td>
                    <a class="rowlink" href={`/services/${encodeURIComponent(s.id)}`}>
                      <b>{s.name}</b>
                    </a>
                    {s.hostname ? <div class="muted mono">{s.hostname}</div> : null}
                  </td>
                  <td>{s.host}</td>
                  <td>
                    <StateChip state={s.state} />
                  </td>
                  <td class="mono" title={s.image ?? undefined}>
                    {s.image ? shortImage(s.image) : "—"}
                    {s.image && !s.imageFromDocker ? <div class="muted small">from the manifest</div> : null}
                  </td>
                  <td class="num mono">{fmtMem(s.memBytes)}</td>
                  <td class="num mono" title={s.cpuBasis === "host" ? "Share of the host's CPU" : "100% is one core"}>
                    {fmtCpu(s.cpuPct)}
                  </td>
                  <td class="sec nowrap" title={s.protection.detail ?? undefined}>
                    {s.protection.label}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasData(vm.sources.prom) ? null : <SourceEmpty status={vm.sources.prom} what="memory and CPU" />}
      </section>
    </LiveFrame>
  );
}

export function ServicesPage({ chrome, vm }: { chrome: Chrome; vm: ServicesVM }) {
  return (
    <Layout title="Services" login={chrome.login} csrf={chrome.csrf} current="services" up={vm.up} refresh={true}>
      <h1>Services</h1>
      <p class="lede">Everything deployed by the playbooks. Open one to see its image, configuration and resources.</p>
      <ServicesFrame vm={vm} />
    </Layout>
  );
}
