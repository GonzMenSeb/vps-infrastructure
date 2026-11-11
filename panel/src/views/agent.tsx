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
        <Chip tone={drifted > 0 ? "bad" : "ok"}>
          {vm.inPlace} of {total} settings in place
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
  if (vm.settings.length === 0) {
    return (
      <div class="body empty">
        <p>{vm.host} has not reported any setting yet.</p>
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
                {s.name}
                {s.known ? null : (
                  <>
                    {" "}
                    <span class="muted">unknown setting</span>
                  </>
                )}
              </td>
              <td>
                <Chip tone={s.ok ? "ok" : "bad"}>{s.ok ? "In place" : "Drifted"}</Chip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
