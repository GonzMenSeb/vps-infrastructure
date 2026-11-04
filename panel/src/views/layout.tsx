import type { Child } from "hono/jsx";
import { HOSTS } from "./model";

export interface Up {
  running: number;
  total: number;
  building?: number;
}

export const upNote = (up: Up) => `${HOSTS.length} hosts · ${up.running}/${up.total} services up`;

export interface LayoutProps {
  title: string;
  login?: string;
  csrf?: string;
  current?: string;
  up?: Up;
  refresh?: boolean;
  children?: Child;
}

const NAV = [
  { id: "overview", label: "Overview", href: "/", count: null },
  { id: "hosts", label: "Hosts", href: "/hosts/vps", count: null },
  { id: "services", label: "Services", href: "/services", count: "services" },
  { id: "jobs", label: "Jobs", href: "/jobs", count: "jobs" },
  { id: "logs", label: "Logs", href: "/logs", count: null },
  { id: "databases", label: "Databases", href: "/databases", count: null },
  { id: "registry", label: "Registry", href: "/registry", count: null },
  { id: "dns", label: "DNS", href: "/dns", count: null },
] as const;

export const railState = (up: Up): Record<string, string> => ({
  note: upNote(up),
  services: String(up.total),
  jobs: up.building ? String(up.building) : "",
});

const INTERVALS: [string, string][] = [
  ["5", "Every 5 s"],
  ["15", "Every 15 s"],
  ["60", "Every 1 min"],
  ["180", "Every 3 min"],
  ["0", "Off"],
];

function RefreshBar() {
  return (
    <div class="top">
      <div class="refresh" data-controller="refresh">
        <span class="lamp pulse" data-refresh-target="lamp"></span>
        <span class="status" data-refresh-target="label" aria-live="polite">
          Updated just now
        </span>
        <button type="button" class="btn sm" data-action="refresh#now" title="Update now" aria-label="Update now">
          ⟳
        </button>
        <select data-refresh-target="select" data-action="refresh#change" aria-label="Update interval">
          {INTERVALS.map(([v, l]) => (
            <option value={v} selected={v === "15"}>
              {l}
            </option>
          ))}
        </select>
        <i class="rbar" data-refresh-target="bar"></i>
      </div>
    </div>
  );
}

export function Layout({ title, login, csrf, current, up, refresh, children }: LayoutProps) {
  const rail = up ? railState(up) : null;
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <title>{title} · Vespiridion</title>
        <link rel="icon" href="data:," />
        <link rel="stylesheet" href="/public/app.css" />
        <script src="/public/theme.js"></script>
        <script src="/public/turbo.js" defer></script>
        <script src="/public/stimulus.js" defer></script>
        <script src="/public/controllers/refresh.js" defer></script>
        <script src="/public/controllers/usage.js" defer></script>
        <script src="/public/controllers/console.js" defer></script>
        <script src="/public/controllers/logs.js" defer></script>
        <script src="/public/controllers/secret.js" defer></script>
        <script src="/public/app.js" defer></script>
      </head>
      <body>
        {login ? (
          <div class="app">
            <nav class="rail" aria-label="Primary">
              <div class="brand">
                Vespiridion<small data-rail="note">{rail?.note ?? "Admin panel"}</small>
              </div>
              {NAV.map((n) => (
                <a class="nav" href={n.href} aria-current={n.id === current ? "page" : undefined}>
                  {n.label}
                  {n.count ? (
                    <span class="count" data-rail={n.count}>
                      {rail?.[n.count] ?? ""}
                    </span>
                  ) : null}
                </a>
              ))}
              <div class="rail-foot">
                <span class="who">
                  Signed in as <b>{login}</b>
                </span>
                <button type="button" class="theme" data-theme-toggle>
                  Toggle theme
                </button>
                <form method="post" action="/logout">

                  <input type="hidden" name="_csrf" value={csrf ?? ""} />
                  <button type="submit">Sign out</button>
                </form>
              </div>
            </nav>
            <main>
              {refresh ? <RefreshBar /> : null}
              <div class="page">{children}</div>
            </main>
          </div>
        ) : (
          <main class="solo">{children}</main>
        )}
      </body>
    </html>
  );
}
