import type { ServiceActionsVM, ServiceFormVM, ToggleVM } from "./service-actions-model";

export function ServiceForm({ f, small = false }: { f: ServiceFormVM; small?: boolean }) {
  return (
    <form
      method="post"
      action={f.action}
      class="inline"
      data-controller="confirm"
      data-action="submit->confirm#ask"
      data-confirm-title-value={f.title}
      data-confirm-body-value={f.body}
      data-confirm-request-value={f.request}
      data-confirm-ok-value={f.ok}
      data-confirm-danger-value={f.danger ? "true" : "false"}
    >
      <input type="hidden" name="_csrf" value={f.csrf} />
      {Object.entries(f.fields).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      <button type="submit" class={`btn${small ? " sm" : ""}${f.danger && !f.plain ? " danger" : ""}${f.primary ? " primary" : ""}`}>
        {f.label}
      </button>
    </form>
  );
}

export function SwitchControl({ t }: { t: ToggleVM }) {
  if (t.kind === "form") return <ServiceForm f={t.form} />;
  return (
    <button type="button" class="btn" disabled title={t.reason}>
      {t.label}
    </button>
  );
}

export function ActionBanner({ a, core }: { a: ServiceActionsVM | null; core: boolean }) {
  if (!a) return null;
  return (
    <>
      {a.flash ? (
        <div class={`alert ${a.flash.ok ? "info" : "bad"} mt`} role="status">
          <span>{a.flash.ok ? "✓" : "!"}</span>
          <span>{a.flash.text}</span>
        </div>
      ) : null}
      {a.dryRun ? (
        <div class="alert mt" role="status">
          <span>ⓘ</span>
          <span>Dry run is on. Switch and rollback requests are recorded in the audit log but nothing is executed.</span>
        </div>
      ) : null}
      {a.toggle?.kind === "disabled" && !core ? <p class="hint mt">{a.toggle.label} is unavailable: {a.toggle.reason}.</p> : null}
      {a.note ? <p class="hint mt">{a.note}</p> : null}
    </>
  );
}

export function RollbackRow({ a }: { a: ServiceActionsVM | null }) {
  if (!a) {
    return (
      <div class="rollback">
        <span class="muted">Service actions are not configured on this panel.</span>
      </div>
    );
  }
  const r = a.rollback;
  if (!r) {
    return (
      <div class="rollback">
        <span class="muted">This service runs on a host the panel cannot reach, so it has no rollback here.</span>
      </div>
    );
  }
  if (r.kind === "unavailable") {
    return (
      <div class="rollback">
        <span class="muted">{r.reason}</span>
      </div>
    );
  }
  const version = (label: string, v: typeof r.current, revision: string | null) => (
    <>
      <div class="muted small">{label}</div>
      <div>
        <b class="mono">{v.tag}</b>
        {v.aliases.length ? <span class="muted mono"> +{v.aliases.join(", ")}</span> : null}{" "}
        <span class="muted" title={v.ageTitle || undefined}>
          {v.ageText}
        </span>
      </div>
      <div class="small muted mono">
        {v.digestShort}…{revision ? ` · revision ${revision}` : ""}
      </div>
    </>
  );
  return (
    <>
      <div class="rollback">
        <div class="grow">
          {version("Running", r.current, r.current.revision)}
          <div class="mt" />
          {version("Previous version", r.previous, null)}
        </div>
        {r.form ? (
          <ServiceForm f={r.form} />
        ) : (
          <button type="button" class="btn" disabled title={r.blocked ?? undefined}>
            Roll back to {r.previous.tag}
          </button>
        )}
      </div>
      {r.notice ? <p class="hint mt">{r.notice}</p> : null}
    </>
  );
}
