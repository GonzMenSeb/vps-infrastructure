import { Chip } from "./components";
import type { AuthRowVM, AuthTabVM, PendingVM } from "./auth-model";

const MASK = "••••••••••";

function PendingBlock({ p }: { p: PendingVM }) {
  const tone = p.state === "applied" ? "ok" : p.state === "pending" ? "info" : p.state === "unchanged" ? "" : "bad";
  return (
    <div class="acct-state" role="status">
      <Chip tone={tone} pulse={p.state === "pending"}>
        {p.state === "pending" ? "Pending" : p.text}
      </Chip>
      {p.state === "pending" ? <span class="sec">{p.text}</span> : null}
      {p.message ? <span class="sec">{p.message}</span> : null}
      {p.editHref ? <a href={p.editHref}>Edit build</a> : null}
      {p.deployHref ? <a href={p.deployHref}>Deploy build</a> : null}
      <span class="muted">{p.ageText}</span>
    </div>
  );
}

function Value({ row, vm }: { row: AuthRowVM; vm: AuthTabVM }) {
  const s = vm.secrets;
  if (row.revealable) {
    return (
      <div
        class="pwcell"
        data-controller="secret"
        data-secret-url-value={row.revealUrl}
        data-secret-seconds-value={s?.revealSeconds ?? 20}
      >
        <span class="mono masked" data-secret-target="mask">
          {MASK}
        </span>
        <code class="mono reveal" data-secret-target="value" hidden></code>
        <button type="button" class="btn sm" data-secret-target="show" data-action="secret#show" disabled={s ? !s.fresh : false}>
          Show
        </button>
        <button type="button" class="btn sm" data-secret-target="hide" data-action="secret#hide" hidden>
          Hide
        </button>
        <button type="button" class="btn sm" data-secret-target="copy" data-action="secret#copy" hidden>
          Copy
        </button>
        <span class="small muted" data-secret-target="note" role="status" aria-live="polite"></span>
      </div>
    );
  }
  return (
    <div class="pwcell">
      <span class="mono masked">{MASK}</span>
      <span class="small muted">
        {row.source === "hash" ? "Only a hash is stored, so it cannot be shown." : "Kept in vault.yml, which the panel cannot read."}
      </span>
    </div>
  );
}

function EditForm({ row, vm }: { row: AuthRowVM; vm: AuthTabVM }) {
  const disabled = !vm.secrets?.enabled || !vm.secrets.fresh;
  const hashed = row.source === "hash";
  return (
    <details class="acct-edit" data-k={`edit:${row.id}`}>
      <summary class="btn sm">{hashed ? "Set password" : "Change"}</summary>
      <form
        method="post"
        action={row.editUrl}
        class="editform"
        data-controller="csrf-field confirm secret-gen"
        data-action="submit->confirm#ask"
        data-confirm-title-value={row.edit.title}
        data-confirm-body-value={row.edit.body}
        data-confirm-request-value={row.edit.request}
        data-confirm-ok-value={row.edit.ok}
        data-confirm-danger-value="false"
      >
        <input type="hidden" name="_csrf" value="" />
        <label class="small sec" for={`v-${row.id}`}>
          {hashed ? "New password" : "New value"} ({row.minLength > 1 ? `${row.minLength}-` : "1-"}
          {row.maxLength} characters, printable ASCII)
        </label>
        <div class="pwcell">
          <input
            id={`v-${row.id}`}
            class="mono"
            type="text"
            name="value"
            required
            minlength={row.minLength}
            maxlength={row.maxLength}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            data-secret-gen-target="input"
            disabled={disabled}
          />
          <button type="button" class="btn sm" data-action="secret-gen#fill" disabled={disabled}>
            Generate
          </button>
          <button type="submit" class="btn sm primary" disabled={disabled}>
            Save
          </button>
        </div>
      </form>
    </details>
  );
}

function RotateForm({ row, vm }: { row: AuthRowVM; vm: AuthTabVM }) {
  const disabled = !vm.secrets?.enabled || !vm.secrets.fresh;
  return (
    <form
      method="post"
      action={row.rotateUrl}
      class="inline acct-rotate"
      data-turbo="false"
      data-controller="csrf-field confirm"
      data-action="submit->confirm#ask"
      data-confirm-title-value={row.rotate.title}
      data-confirm-body-value={row.rotate.body}
      data-confirm-request-value={row.rotate.request}
      data-confirm-ok-value={row.rotate.ok}
      data-confirm-danger-value="false"
    >
      <input type="hidden" name="_csrf" value="" />
      <button type="submit" class="btn sm" disabled={disabled}>
        Rotate
      </button>
    </form>
  );
}

function Row({ row, vm }: { row: AuthRowVM; vm: AuthTabVM }) {
  const busy = row.pending?.state === "pending";
  return (
    <div class="acct-wrap">
      <div class="acct">
        <div class="who">
          <b class="mono">{row.label}</b>
          {row.sub && row.sub !== row.label ? <div class="small muted mono">{row.sub}</div> : null}
          {row.alsoUsedBy.length ? <div class="small muted">Also used by {row.alsoUsedBy.join(", ")}</div> : null}
        </div>
        <Value row={row} vm={vm} />
        {row.editable ? (
          busy ? (
            <span class="muted small acct-lock">Locked while pending</span>
          ) : (
            <>
              <EditForm row={row} vm={vm} />
              {row.rotatable ? <RotateForm row={row} vm={vm} /> : null}
            </>
          )
        ) : (
          <span class="small muted acct-lock">Read-only</span>
        )}
      </div>
      {!row.editable && row.readOnlyReason ? <p class="hint acct-why">{row.readOnlyReason}</p> : null}
      {row.note && row.editable ? <p class="hint acct-why">{row.note}</p> : null}
      {row.pending ? <PendingBlock p={row.pending} /> : null}
    </div>
  );
}

export function AuthTab({ vm }: { vm: AuthTabVM }) {
  const s = vm.secrets;
  return (
    <section class="panel" aria-label="Auth">
      <header>
        <h2>Auth</h2>
        <span class="sub">{vm.kindText}</span>
      </header>
      <div class="body">
        <dl class="kv">
          <dt>Gate at Traefik</dt>
          <dd>{vm.gateText}</dd>
        </dl>
        {s && !s.enabled ? <p class="hint warn-text mt">{s.disabledReason ?? "Editing is not available."}</p> : null}
        {s?.enabled && !s.fresh ? (
          <div class="alert info mt">
            <span>ⓘ</span>
            <span>
              Your sign-in is older than {s.reauthMinutes} minutes. <a href={s.reauthHref}>Sign in again</a> to show or change a secret.
            </span>
          </div>
        ) : null}
      </div>
      {vm.noSecrets ? (
        <div class="body muted">The manifest lists no secrets for this service.</div>
      ) : (
        <div class="acct-list">
          {vm.rows.map((row) => (
            <Row row={row} vm={vm} />
          ))}
        </div>
      )}
      <div class="body">
        <p class="hint">
          Showing a value reads it from the service's .env and hides it again after {s?.revealSeconds ?? 20} seconds. A change is written to the repo by {s?.job ?? "panel-secrets"} and
          applied by {s?.applyJob ?? "vps-deploy"}, so it takes a few minutes and the service restarts when it lands. Every show and change is recorded without the value.
        </p>
      </div>
    </section>
  );
}
