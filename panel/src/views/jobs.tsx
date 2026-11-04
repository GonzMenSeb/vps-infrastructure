import { Layout } from "./layout";
import { Chip, LiveFrame, SourceEmpty, SourceNote, Track } from "./components";
import { hasData, type ActionVM, type BuildRowVM, type ConsoleVM, type JobRowVM, type JobsVM, type ResultChip } from "./model";
import type { Chrome } from "./overview";

export function ResultChipView({ r }: { r: ResultChip }) {
  return (
    <Chip tone={r.tone} pulse={r.label === "Running"} title={r.title ?? undefined}>
      {r.label}
    </Chip>
  );
}

export function ActionForm({ a, small = true }: { a: ActionVM; small?: boolean }) {
  return (
    <form
      method="post"
      action={a.action}
      class="inline"
      data-controller="confirm"
      data-action="submit->confirm#ask"
      data-confirm-title-value={a.title}
      data-confirm-body-value={a.body}
      data-confirm-request-value={a.request}
      data-confirm-ok-value={a.ok}
      data-confirm-danger-value={a.danger ? "true" : "false"}
    >
      <input type="hidden" name="_csrf" value={a.csrf} />
      <button type="submit" class={`btn${small ? " sm" : ""}${a.danger ? " danger" : ""}`}>
        {a.label}
      </button>
    </form>
  );
}

function BuildName({ b }: { b: BuildRowVM }) {
  return (
    <a class="rowlink" href={b.consoleHref}>
      <b>{b.job}</b> <span class="muted mono">#{b.number}</span>
    </a>
  );
}

function Running({ vm }: { vm: JobsVM }) {
  const { busy, total } = vm.executors;
  return (
    <section class="panel" aria-label="Running">
      <header>
        <h2>Running</h2>
        <span class="sub">{total !== null ? `${busy} of ${total} executors busy` : `${busy} running`}</span>
      </header>
      {vm.running.length ? (
        <table>
          <tbody>
            {vm.running.map((b) => (
              <tr>
                <td>
                  <BuildName b={b} />
                  {b.cause ? <div class="muted">{b.cause}</div> : null}
                </td>
                <td class="progress">
                  {b.progressPct !== null ? (
                    <span title={`About ${b.progressPct}% of the usual run time`}>
                      <Track pct={b.progressPct} c="cpu" />
                    </span>
                  ) : (
                    <span class="muted">No estimate</span>
                  )}
                </td>
                <td class="num mono">{b.tookText}</td>
                <td class="num act">{b.stop ? <ActionForm a={b.stop} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="body muted">Nothing is running.</div>
      )}
    </section>
  );
}

function Waiting({ vm }: { vm: JobsVM }) {
  return (
    <section class="panel" aria-label="Waiting">
      <header>
        <h2>Waiting</h2>
      </header>
      {vm.queue.length ? (
        <table>
          <tbody>
            {vm.queue.map((q) => (
              <tr>
                <td>
                  <b>{q.job}</b>
                </td>
                <td class="sec">{q.why}</td>
                <td class="num mono">{q.waitedText ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="body muted">The queue is empty.</div>
      )}
    </section>
  );
}

function JobRow({ j }: { j: JobRowVM }) {
  return (
    <tr>
      <td>
        <b class="mono">{j.name}</b>
        {j.serviceId ? (
          <div class="small">
            <a href={`/services/${encodeURIComponent(j.serviceId)}?tab=builds`}>{j.serviceName}</a>
          </div>
        ) : null}
      </td>
      <td>
        {j.running ? <Chip tone="info" pulse={true}>Running{j.running > 1 ? ` ×${j.running}` : ""}</Chip> : j.last ? <ResultChipView r={j.last.result} /> : <span class="muted">No runs</span>}
        {j.queued ? <span class="muted"> · {j.queued} waiting</span> : null}
      </td>
      <td class="sec hide-sm">{j.last ? `#${j.last.number} · ${j.last.startedText}` : ""}</td>
      <td class="num act">{j.run ? <ActionForm a={j.run} /> : null}</td>
    </tr>
  );
}

function Jobs({ vm }: { vm: JobsVM }) {
  return (
    <section class="panel" aria-label="Jobs">
      <header>
        <h2>Jobs</h2>
        {vm.host ? <span class="sub mono">{vm.host}</span> : null}
      </header>
      {vm.jobs.length ? (
        <div class="tablewrap">
          <table>
            <tbody>{vm.jobs.map((j) => <JobRow j={j} />)}</tbody>
          </table>
        </div>
      ) : (
        <div class="body muted">Jenkins lists no jobs.</div>
      )}
      {vm.missing.length ? (
        <div class="body">
          <p class="hint">
            The manifest names {vm.missing.length === 1 ? "a job" : "jobs"} Jenkins does not have yet:{" "}
            <span class="mono">{vm.missing.join(", ")}</span>
          </p>
        </div>
      ) : null}
      {vm.actionsEnabled ? null : (
        <div class="body">
          <p class="hint">Jenkins credentials are not configured, so runs cannot be started or stopped from here.</p>
        </div>
      )}
    </section>
  );
}

function History({ vm }: { vm: JobsVM }) {
  return (
    <section class="panel" aria-label="History">
      <header>
        <h2>History</h2>
        <span class="sub">{vm.history.length} recent runs</span>
      </header>
      {vm.history.length ? (
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Result</th>
                <th>Started</th>
                <th class="num">Took</th>
                <th class="hide-sm">Triggered by</th>
                <th class="hide-sm"></th>
              </tr>
            </thead>
            <tbody>
              {vm.history.map((b) => (
                <tr>
                  <td>
                    <BuildName b={b} />
                  </td>
                  <td>
                    <ResultChipView r={b.result} />
                  </td>
                  <td class="nowrap" title={b.startedTitle}>{b.startedText}</td>
                  <td class="num mono">{b.tookText}</td>
                  <td class="sec hide-sm">{b.cause ?? ""}</td>
                  <td class="act hide-sm">
                    {b.jenkinsHref ? (
                      <a href={b.jenkinsHref} target="_blank" rel="noopener noreferrer" aria-label={`Open ${b.job} #${b.number} in Jenkins`}>
                        Jenkins ↗
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="body muted">Jenkins reports no finished runs.</div>
      )}
      {vm.historyMore ? (
        <div class="body">
          <a href={vm.historyMore}>Show more runs</a>
        </div>
      ) : null}
    </section>
  );
}

export function ConsolePanel({ c, note }: { c: ConsoleVM | null; note: string | null }) {
  if (!c) {
    return (
      <section class="panel" aria-label="Console">
        <header>
          <h2>Console</h2>
        </header>
        <div class="body muted">{note ?? "Select a run to read its console."}</div>
      </section>
    );
  }
  return (
    <section
      class="panel"
      aria-label="Console"
      data-controller="console"
      data-console-src-value={c.src}
      data-console-running-value={c.running ? "true" : "false"}
    >
      <header>
        <h2>Console</h2>
        <span class="sub mono">
          {c.job} #{c.number}
        </span>
        {c.result ? <ResultChipView r={c.result} /> : null}
        <span class="sub">
          <span class="muted" data-console-target="state" role="status"></span>{" "}
          <button type="button" class="btn sm" data-console-target="follow" data-action="console#toggle" aria-pressed="true">
            Stop following
          </button>
          {c.jenkinsHref ? (
            <>
              {" "}
              <a class="btn sm" href={c.jenkinsHref} target="_blank" rel="noopener noreferrer">
                Jenkins ↗
              </a>
            </>
          ) : null}
        </span>
      </header>
      <pre class="log" data-console-target="pane" role="log" aria-live="off" tabindex={0}></pre>
    </section>
  );
}

export function JobsFrame({ vm }: { vm: JobsVM }) {
  const ok = hasData(vm.status);
  return (
    <LiveFrame up={vm.up}>
      <h1>Jobs</h1>
      <p class="lede">What Jenkins is doing, what is waiting, and what finished. Select a run to read its console.</p>
      <div class="bar">
        <SourceNote status={vm.status} />
      </div>
      {vm.flash ? (
        <div class={`alert ${vm.flash.ok ? "info" : "bad"}`} role="status">
          <span>{vm.flash.ok ? "✓" : "!"}</span>
          <span>{vm.flash.text}</span>
        </div>
      ) : null}
      {ok ? (
        <div class="stack">
          <div class="grid2">
            <Running vm={vm} />
            <Waiting vm={vm} />
          </div>
          <Jobs vm={vm} />
          <div class="grid2-1 console-first">
            <History vm={vm} />
            <ConsolePanel c={vm.console} note={vm.consoleNote} />
          </div>
        </div>
      ) : (
        <section class="panel" aria-label="Jenkins">
          <SourceEmpty status={vm.status} what="Jenkins runs" />
        </section>
      )}
    </LiveFrame>
  );
}

export function JobsPage({ chrome, vm }: { chrome: Chrome; vm: JobsVM }) {
  return (
    <Layout title="Jobs" login={chrome.login} csrf={chrome.csrf} current="jobs" up={vm.up} refresh={true}>
      <JobsFrame vm={vm} />
    </Layout>
  );
}
