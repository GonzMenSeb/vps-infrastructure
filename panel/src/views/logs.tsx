import { Layout } from "./layout";
import { Chip, SourceNote } from "./components";
import { logChoice, type LogsVM } from "./model";
import type { Chrome } from "./overview";

export function LogsBody({ vm }: { vm: LogsVM }) {
  return (
    <>
      <h1>Logs</h1>
      <p class="lede">Live output from the containers that ship their logs to Loki. New lines arrive at the bottom.</p>
      {vm.status ? (
        <div class="bar">
          <SourceNote status={vm.status} />
        </div>
      ) : null}
      {vm.selectedKnown ? null : (
        <div class="alert">
          <span>ⓘ</span>
          <span>That container is not in the list of containers that ship logs, so all containers are shown.</span>
        </div>
      )}
      {vm.configured ? (
        <section
          class="panel"
          aria-label="Container logs"
          data-controller="logs"
          data-logs-stream-value={vm.streamPath}
          data-logs-cap-value={String(vm.lineCap)}
          data-logs-pause-cap-value={String(vm.pauseCap)}
          data-logs-tz-value={vm.timeZone}
        >
          <header>
            <h2>Container logs</h2>
            <span data-logs-target="state" role="status">
              <Chip tone="" lamp={true}>
                Connecting
              </Chip>
            </span>
            <span class="sub logtools">
              <span class="muted" data-logs-target="count"></span>
              <span class="warn-text" data-logs-target="dropped" hidden></span>
              <select data-logs-target="src" data-action="logs#change" aria-label="Container">
                <option value="all" selected={vm.selected === "all"}>
                  All containers ({vm.total})
                </option>
                {vm.groups.map((g) => (
                  <optgroup label={g.host}>
                    {g.containers.map((c) => {
                      const v = logChoice(g.host, c);
                      return (
                        <option value={v} selected={v === vm.selected}>
                          {c}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
              <button type="button" class="btn sm" data-logs-target="pause" data-action="logs#toggle" aria-pressed="false">
                Pause
              </button>
              <button type="button" class="btn sm" data-action="logs#clear">
                Clear
              </button>
            </span>
          </header>
          <div class="log big" data-logs-target="pane" role="log" aria-live="off" tabindex={0}></div>
        </section>
      ) : (
        <section class="panel" aria-label="Container logs">
          <div class="body empty">
            <p>Loki is not configured, so container logs cannot be shown.</p>
          </div>
        </section>
      )}
    </>
  );
}

export function LogsPage({ chrome, vm }: { chrome: Chrome; vm: LogsVM }) {
  return (
    <Layout title="Logs" login={chrome.login} csrf={chrome.csrf} current="logs" up={vm.up} refresh={false}>
      <LogsBody vm={vm} />
    </Layout>
  );
}
