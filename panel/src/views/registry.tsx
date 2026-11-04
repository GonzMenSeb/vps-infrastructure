import { Layout } from "./layout";
import { Chip, LiveFrame, SourceEmpty, SourceNote } from "./components";
import { ActionForm } from "./jobs";
import { hasData } from "./model";
import type { Chrome } from "./overview";
import type { RegistryVM, RepoDetailVM, TagRowVM } from "./registry-model";

function Repos({ vm }: { vm: RegistryVM }) {
  return (
    <section class="panel" aria-label="Repositories">
      <header>
        <h2>Repositories</h2>
      </header>
      {vm.repos.length ? (
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th class="num">Tags</th>
                <th class="num">Size</th>
                <th class="hide-sm">Last push</th>
              </tr>
            </thead>
            <tbody>
              {vm.repos.map((r) => (
                <tr class={r.selected ? "selected" : undefined}>
                  <td class="mono">
                    <a class="rowlink" href={r.href} aria-current={r.selected ? "true" : undefined}>
                      {r.name}
                    </a>
                    {r.error ? (
                      <div class="warn-text" title={r.error}>
                        Zot did not answer for this repository
                      </div>
                    ) : null}
                  </td>
                  <td class="num">{r.tagCount}</td>
                  <td class="num mono">{r.sizeText}</td>
                  <td class="hide-sm">{r.pushText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="body muted">Zot holds no repositories.</div>
      )}
    </section>
  );
}

function TagTableRow({ r }: { r: TagRowVM }) {
  return (
    <tr>
      <td>
        <b class="mono">{r.tag}</b>{" "}
        {r.isLatest ? (
          <Chip tone="info" lamp={false}>
            latest
          </Chip>
        ) : r.sameAsLatest ? (
          <Chip tone="ok" lamp={false} title="This tag points at the same manifest as latest">
            same as latest
          </Chip>
        ) : null}
        {r.buildCache ? (
          <Chip lamp={false} title="BuildKit layer cache, not a deployable image">
            build cache
          </Chip>
        ) : null}
        <div class="small muted" title={r.updatedTitle}>
          {r.updatedText} · {r.sizeText}
        </div>
      </td>
      <td class="mono muted nowrap" title={r.digest}>
        {r.digestShort}
      </td>
      <td class="num act">
        {r.delete ? (
          <ActionForm a={r.delete} />
        ) : r.refusal ? (
          <span class="muted small" title={r.refusal}>
            Protected
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function Tags({ d, vm }: { d: RepoDetailVM; vm: RegistryVM }) {
  return (
    <section class="panel" aria-label={`Tags of ${d.name}`}>
      <header>
        <h2 class="mono">{d.name}</h2>
        <span class="sub">
          {d.tagCount} {d.tagCount === 1 ? "tag" : "tags"} · {d.sizeText}
        </span>
      </header>
      {d.error ? (
        <div class="body muted">Zot did not answer for this repository: {d.error}</div>
      ) : d.rows.length ? (
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Digest</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <TagTableRow r={r} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="body muted">This repository has no tags.</div>
      )}
      <div class="body">
        <p class="hint">
          {d.latestShort
            ? `latest points at ${d.latestShort}. Deleting a tag deletes its manifest and every tag on it, so the manifest latest points at is never offered.`
            : "This repository has no latest tag."}
        </p>
        {vm.actionsEnabled ? null : <p class="hint mt">Registry credentials are not configured for writes, so tags cannot be deleted from here.</p>}
      </div>
    </section>
  );
}

export function RegistryFrame({ vm }: { vm: RegistryVM }) {
  const ok = hasData(vm.status);
  return (
    <LiveFrame up={vm.up}>
      <h1>Registry</h1>
      <p class="lede">Images stored in Zot. Deleting a tag removes its manifest; Zot reclaims the disk space on its own schedule.</p>
      <div class="bar">
        {ok ? (
          <Chip tone="info" lamp={false}>
            {vm.totalText}
          </Chip>
        ) : null}
        <span class="grow"></span>
        <SourceNote status={vm.status} />
      </div>
      {vm.flash ? (
        <div class={`alert ${vm.flash.ok ? "info" : "bad"}`} role="status">
          <span>{vm.flash.ok ? "✓" : "!"}</span>
          <span>{vm.flash.text}</span>
        </div>
      ) : null}
      {ok ? (
        <>
          {vm.gcText ? (
            <div class="alert info" data-gc>
              <span>ⓘ</span>
              <span>{vm.gcText}</span>
            </div>
          ) : null}
          {vm.selectedNote ? <p class="hint">{vm.selectedNote}</p> : null}
          <div class="grid2-1">
            <Repos vm={vm} />
            {vm.selected ? (
              <Tags d={vm.selected} vm={vm} />
            ) : (
              <section class="panel" aria-label="Tags">
                <div class="body muted">Pick a repository to see its tags.</div>
              </section>
            )}
          </div>
        </>
      ) : (
        <section class="panel" aria-label="Zot">
          <SourceEmpty status={vm.status} what="the registry contents" />
        </section>
      )}
    </LiveFrame>
  );
}

export function RegistryPage({ chrome, vm }: { chrome: Chrome; vm: RegistryVM }) {
  return (
    <Layout title="Registry" login={chrome.login} csrf={chrome.csrf} current="registry" up={vm.up} refresh={true}>
      <RegistryFrame vm={vm} />
    </Layout>
  );
}
