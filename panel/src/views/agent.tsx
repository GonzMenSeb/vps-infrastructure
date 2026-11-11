import type { Child } from "hono/jsx";
import { Chip, SourceNote } from "./components";
import type { AgentVM } from "./agent-model";

function StatusLine({ vm }: { vm: AgentVM }) {
  const total = vm.settings.length;
  const drifted = total - vm.inPlace;
  const { reboot, report } = vm;
  return (
    <div class="body agent-status">
      {total === 0 ? (
        <Chip tone="">No settings reported</Chip>
      ) : (
        <Chip tone={!report.reporting ? (drifted > 0 ? "warn" : "") : drifted > 0 ? "bad" : "ok"}>
          {vm.inPlace} of {total} settings in place{report.reporting ? "" : " · last known"}
        </Chip>
      )}
      {reboot.pending ? (
        <Chip tone="warn">
          Reboot pending
          {reboot.running ? ` · running ${reboot.running}` : ""}
          {reboot.newest ? ` · newest ${reboot.newest}` : ""}
        </Chip>
      ) : reboot.known ? (
        <Chip tone="ok">No reboot pending</Chip>
      ) : null}
      <Chip tone={report.reporting ? "ok" : "warn"}>{report.text}</Chip>
    </div>
  );
}

function Settings({ vm }: { vm: AgentVM }) {
  const live = vm.report.reporting;
  if (vm.settings.length === 0) {
    return (
      <div class="body empty">
        <p>{vm.host} is not reporting any setting right now.</p>
      </div>
    );
  }
  return (
    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {vm.settings.map((s) => (
            <tr>
              <td>
                {s.known ? (
                  s.name
                ) : (
                  <>
                    <bdi>{s.name}</bdi> <span class="muted">unknown setting</span>
                  </>
                )}
              </td>
              <td>
                <Chip tone={live ? (s.ok ? "ok" : "bad") : s.ok ? "" : "warn"}>
                  {s.ok ? "In place" : "Drifted"}
                  {live ? "" : " · last known"}
                </Chip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {vm.settingsDropped > 0 ? <p class="muted">{vm.settingsDropped} more settings are reported and not shown.</p> : null}
    </div>
  );
}

export function AgentSection({ vm, charts }: { vm: AgentVM; charts: Child }) {
  return (
    <section class="panel" aria-label="Agent host">
      <header>
        <h2>Agent host</h2>
        <span class="muted">What the agent_host role set up on {vm.host}</span>
        <SourceNote status={vm.status} />
      </header>
      <StatusLine vm={vm} />
      <div class="agent-split">
        <Settings vm={vm} />
        <div class="body">
          <h3>Right now</h3>
          <dl class="kv">{vm.stats.flatMap((s) => [<dt>{s.label}</dt>, <dd class="mono">{s.value}</dd>])}</dl>
        </div>
      </div>
      {charts}
    </section>
  );
}
