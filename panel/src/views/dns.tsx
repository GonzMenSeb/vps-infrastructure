import { Layout } from "./layout";
import { Chip, LiveFrame, SourceEmpty, SourceNote } from "./components";
import { DNS_APPLY_PATH, DNS_PATH, type DnsFormVM, type DnsReviewVM, type DnsRowVM, type DnsVM } from "./dns-model";
import { hasData } from "./model";
import type { Chrome } from "./overview";

function Hidden({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function ReviewPanel({ r, zone }: { r: DnsReviewVM; zone: string }) {
  return (
    <section class="panel mb" aria-label="Review change" data-refresh-hold>
      <header>
        <h2>Review change</h2>
        <span class="sub mono">{r.title}</span>
      </header>
      <div class="body review">
        {r.ownerNote ? (
          <div class="alert" role="alert">
            <span>!</span>
            <span>{r.ownerNote}</span>
          </div>
        ) : null}
        {r.unchanged ? <p class="muted">The record already has exactly these values, so there is nothing to send.</p> : null}
        <div class="what">Exact request sent to PowerDNS in {zone}</div>
        <pre class="code" data-dns-request>
          {r.request}
        </pre>
        <form method="post" action={DNS_APPLY_PATH} class="review-form">
          <input type="hidden" name="_csrf" value={r.csrf} />
          <Hidden fields={r.fields} />
          <input type="hidden" name="hash" value={r.hash} />
          {r.needsOverwrite ? (
            <label class="check">
              <input type="checkbox" name="overwrite" value="yes" required />
              <span>I understand this record is managed by Ansible or another tool, and that this change is undone by its next run.</span>
            </label>
          ) : null}
          <div class="btns">
            <a class="btn" href={r.cancelHref}>
              Cancel
            </a>
            <button type="submit" class={`btn ${r.op === "delete" ? "danger" : "primary"}`} disabled={!r.canApply}>
              {r.op === "delete" ? "Delete record" : "Apply change"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function RecordForm({ f, vm }: { f: DnsFormVM; vm: DnsVM }) {
  const edit = f.mode === "edit";
  return (
    <form class="form-row" method="get" action={DNS_PATH} id="record-form" data-refresh-hold={edit ? "" : undefined}>
      <input type="hidden" name="zone" value={f.zone} />
      <input type="hidden" name="review" value="1" />
      <input type="hidden" name="op" value="upsert" />
      <label class="field">
        Type
        {edit ? (
          <>
            <input type="hidden" name="type" value={f.type} />
            <select disabled aria-label="Type">
              <option>{f.type}</option>
            </select>
          </>
        ) : (
          <select name="type">
            {vm.types.map((t) => (
              <option value={t} selected={t === f.type}>
                {t}
              </option>
            ))}
          </select>
        )}
      </label>
      <label class="field">
        Name
        <input name="name" value={f.name} placeholder="app" required readonly={edit} autocomplete="off" />
      </label>
      <label class="field">
        Content
        <textarea name="content" rows={2} placeholder="203.0.113.10" required autocomplete="off">
          {f.content}
        </textarea>
      </label>
      <label class="field">
        TTL
        <input name="ttl" value={f.ttl} inputmode="numeric" autocomplete="off" />
      </label>
      <div class="form-actions">
        <button class="btn primary" type="submit">
          {edit ? "Review change" : "Review record"}
        </button>
        {f.cancelHref ? (
          <a class="btn" href={f.cancelHref}>
            Cancel
          </a>
        ) : null}
      </div>
      {f.error ? (
        <div class="form-error warn-text" role="alert">
          {f.error}
        </div>
      ) : null}
    </form>
  );
}

function ContentCell({ r }: { r: DnsRowVM }) {
  return (
    <>
      {r.contents.map((c) => (
        <div class={c.disabled ? "mono muted" : "mono"}>
          {c.text}
          {c.disabled ? " (disabled)" : ""}
        </div>
      ))}
    </>
  );
}

function Records({ vm }: { vm: DnsVM }) {
  return (
    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Content</th>
            <th class="num">TTL</th>
            <th>Owner</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {vm.rows.map((r) => (
            <tr>
              <td>
                <b>{r.type}</b>
              </td>
              <td class="mono" title={r.fqdn}>
                {r.name}
              </td>
              <td>
                <ContentCell r={r} />
              </td>
              <td class="num mono">{r.ttl}</td>
              <td>
                <Chip tone={r.ownerTone} lamp={false} title={r.owner === "other" ? "No managed-by: panel comment on this record set" : r.note ?? undefined}>
                  {r.ownerLabel}
                </Chip>
              </td>
              <td class="num act">
                {r.editHref ? (
                  <a class="btn sm" href={r.editHref}>
                    Edit
                  </a>
                ) : null}{" "}
                {r.deleteHref ? (
                  <a class="btn sm danger" href={r.deleteHref}>
                    Delete
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {vm.rows.length === 0 ? <div class="body muted">{vm.filter ? `No record matches "${vm.filter}".` : "This zone has no records."}</div> : null}
    </div>
  );
}

export function DnsFrame({ vm }: { vm: DnsVM }) {
  const ok = hasData(vm.status);
  return (
    <LiveFrame up={vm.up}>
      <h1>DNS</h1>
      <p class="lede">
        Records served by PowerDNS. Records marked <b>Ansible / other</b> were not created here; Ansible writes them again on every deploy, so changing them from the panel lasts only until then.
      </p>
      <div class="bar">
        {vm.zone ? (
          <form method="get" action={DNS_PATH} class="filter">
            <input type="hidden" name="zone" value={vm.zone.id} />
            <input name="q" value={vm.filter} placeholder="Filter records" aria-label="Filter records" autocomplete="off" />
            <button class="btn sm" type="submit">
              Filter
            </button>
          </form>
        ) : null}
        {vm.zones.length > 1 ? (
          <div class="seg" role="group" aria-label="Zone">
            {vm.zones.map((z) => (
              <a href={z.href} aria-current={z.selected ? "true" : undefined}>
                {z.name}
              </a>
            ))}
          </div>
        ) : null}
        <span class="grow"></span>
        {ok && vm.zone ? (
          <Chip tone="ok" lamp={false}>
            {vm.countText}
          </Chip>
        ) : null}
        <SourceNote status={vm.status} />
      </div>
      {vm.flash ? (
        <div class={`alert ${vm.flash.ok ? "info" : "bad"}`} role="status">
          <span>{vm.flash.ok ? "✓" : "!"}</span>
          <span>{vm.flash.text}</span>
        </div>
      ) : null}
      {vm.reviewError ? (
        <div class="alert bad" role="alert">
          <span>!</span>
          <span>{vm.reviewError}</span>
        </div>
      ) : null}
      {ok && vm.zone ? (
        <>
          {vm.panelOnly ? (
            <div class="alert info">
              <span>ⓘ</span>
              <span>
                {vm.panelOnly} {vm.panelOnly === 1 ? "record set exists" : "record sets exist"} only in the panel. Add {vm.panelOnly === 1 ? "it" : "them"} to the playbook if {vm.panelOnly === 1 ? "it" : "they"} should survive a rebuild.
              </span>
            </div>
          ) : null}
          {vm.review ? <ReviewPanel r={vm.review} zone={vm.zone.bare} /> : null}
          <section class="panel" aria-label="Records">
            {vm.actionsEnabled ? <RecordForm f={vm.form} vm={vm} /> : (
              <div class="body">
                <p class="hint">The PowerDNS API key is not configured for writes here, so records are read-only.</p>
              </div>
            )}
            <Records vm={vm} />
          </section>
        </>
      ) : (
        <section class="panel" aria-label="PowerDNS">
          <SourceEmpty status={vm.status} what="the DNS records" />
        </section>
      )}
    </LiveFrame>
  );
}

export function DnsPage({ chrome, vm }: { chrome: Chrome; vm: DnsVM }) {
  return (
    <Layout title="DNS" login={chrome.login} csrf={chrome.csrf} current="dns" up={vm.up} refresh={true}>
      <DnsFrame vm={vm} />
    </Layout>
  );
}
