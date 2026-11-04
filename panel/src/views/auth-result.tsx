import { Layout } from "./layout";
import type { Chrome } from "./overview";

export interface AuthResultProps {
  chrome: Chrome;
  title: string;
  message: string;
  backHref: string;
  serviceName: string | null;
  ok: boolean;
  once?: { label: string; value: string };
}

export function AuthResultPage({ chrome, title, message, backHref, serviceName, ok, once }: AuthResultProps) {
  return (
    <Layout title={title} login={chrome.login} csrf={chrome.csrf} current="services" noCache>
      <div class="crumb">
        <a href="/services">Services</a> / {serviceName ?? "Auth"}
      </div>
      <section class="panel" aria-label={title}>
        <header>
          <h2>{title}</h2>
        </header>
        <div class="body">
          <p class={ok ? "sec" : "warn-text"} role={ok ? "status" : "alert"}>
            {message}
          </p>
          {once ? (
            <div class="once" data-controller="once" data-once-seconds-value="60">
              <div class="small sec">{once.label}</div>
              <div class="pwcell">
                <code class="mono reveal" data-once-target="value">
                  {once.value}
                </code>
                <button type="button" class="btn sm" data-action="once#copy">
                  Copy
                </button>
                <span class="small muted" data-once-target="note" role="status" aria-live="polite"></span>
              </div>
            </div>
          ) : null}
          <p class="mt">
            <a class="btn" href={backHref}>
              Back to the Auth tab
            </a>
          </p>
        </div>
      </section>
    </Layout>
  );
}
