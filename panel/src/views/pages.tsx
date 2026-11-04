import { Layout, Mark } from "./layout";
import type { Chrome } from "./overview";

export function LoginPage({ error, dev }: { error?: string; dev?: boolean }) {
  return (
    <Layout title="Sign in">
      <section class="panel login">
        <div class="markrow">
          <Mark size={48} label="Vespiridion" />
        </div>
        <header>
          <h2>Sign in</h2>
        </header>
        <div class="body">
          {error ? <div class="alert bad">{error}</div> : null}
          <p class="lede">Access is restricted to the owner's GitHub account.</p>
          <a class="btn primary" href="/auth/github" data-turbo="false">
            Continue with GitHub
          </a>
          {dev ? (
            <p class="hint mt">
              <a href="/auth/dev" data-turbo="false">
                Development sign-in
              </a>{" "}
              (DEV_AUTH_BYPASS is on)
            </p>
          ) : null}
        </div>
      </section>
    </Layout>
  );
}

export function NotFoundPage({ chrome, what }: { chrome: Chrome; what: string }) {
  return (
    <Layout title="Not found" login={chrome.login} csrf={chrome.csrf}>
      <h1>Not found</h1>
      <p class="lede">{what}</p>
      <p>
        <a href="/">Back to the overview</a>
      </p>
    </Layout>
  );
}

export const loginHtml = (error?: string, dev?: boolean) => <LoginPage error={error} dev={dev} />;
