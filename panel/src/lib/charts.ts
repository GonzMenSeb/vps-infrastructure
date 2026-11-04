export interface ChartSeries {
  name: string;
  c: string;
  data: readonly number[];
}

export interface ChartOptions {
  title: string;
  series: readonly ChartSeries[];
  fmt: (v: number) => string;
  xLabels: readonly string[];
  fixedMax?: number;
  legend?: boolean;
  from?: number;
}

export function niceMax(m: number): number {
  const v = Number.isFinite(m) && m > 0 ? m : 0;
  for (let p = -2; p < 8; p++) {
    for (const k of [1, 2, 2.5, 5]) {
      const c = k * 10 ** p * 4;
      if (c >= v) return c;
    }
  }
  return v;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function hourLabels(endMs: number, spanMs = 24 * 3600_000, count = 5, timeZone = "UTC"): string[] {
  const f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return Array.from({ length: count }, (_, k) => f.format(new Date(endMs - spanMs + (k / (count - 1)) * spanMs)));
}

const W = 340;
const H = 190;
const L = 50;
const R = 12;
const T = 10;
const B = 26;
const pw = W - L - R;
const ph = H - T - B;

const num = (v: number) => (Number.isFinite(v) ? v : 0);

export function chart(o: ChartOptions): string {
  const { title, series, fmt, xLabels, legend } = o;
  const n = series[0]?.data.length ?? 0;
  const t = esc(title);
  if (n === 0) return `<div class="chart"><div class="t">${t}</div><p class="empty">No data</p></div>`;
  const f = Math.min(Math.max(Math.floor(o.from ?? 0), 0), n - 1);
  const all = series.flatMap((s) => s.data.slice(f).map(num));
  const max = o.fixedMax || niceMax(Math.max(...all) * 1.05);
  const X = (i: number) => L + (i / Math.max(n - 1, 1)) * pw;
  const Y = (v: number) => T + ph - (num(v) / max) * ph;
  let g = "";
  for (let k = 0; k <= 4; k++) {
    const y = T + ph * (1 - k / 4);
    g += `<line class="${k ? "grid" : "base"}" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${esc(fmt((max * k) / 4))}</text>`;
  }
  const last = xLabels.length - 1;
  xLabels.forEach((l, k) => {
    const anchor = k === 0 ? "start" : k === last ? "end" : "middle";
    g += `<text x="${L + (k / Math.max(last, 1)) * pw}" y="${H - 6}" text-anchor="${anchor}">${esc(l)}</text>`;
  });
  series.forEach((s, j) => {
    const c = esc(s.c);
    const d = s.data
      .slice(f)
      .map((v, k) => `${k ? "L" : "M"}${X(f + k).toFixed(1)} ${Y(v).toFixed(1)}`)
      .join("");
    if (j === 0) {
      g += `<path d="${d}L${X(n - 1).toFixed(1)} ${T + ph}L${X(f).toFixed(1)} ${T + ph}Z" fill="var(--${c})" opacity=".13"/>`;
    }
    const lastV = s.data[s.data.length - 1] ?? 0;
    g += `<path d="${d}" fill="none" stroke="var(--${c})" stroke-width="1.4" stroke-linejoin="round"/><circle cx="${X(s.data.length - 1).toFixed(1)}" cy="${Y(lastV).toFixed(1)}" r="3.2" fill="var(--${c})"/>`;
  });
  const stat = (a: readonly number[]) => {
    const v = a.slice(f).map(num);
    return { now: v[v.length - 1] ?? 0, avg: v.reduce((x, y) => x + y, 0) / (v.length || 1), min: Math.min(...v), max: Math.max(...v) };
  };
  const legendHtml = legend
    ? `<div class="legend">${series.map((s) => `<span class="c-${esc(s.c)}"><i></i>${esc(s.name)}</span>`).join("")}</div>`
    : "";
  const rows = series
    .map((s) => {
      const z = stat(s.data);
      return `<tr><td>${esc(s.name)}</td><td>${esc(fmt(z.now))}</td><td>${esc(fmt(z.avg))}</td><td>${esc(fmt(z.min))}</td><td>${esc(fmt(z.max))}</td></tr>`;
    })
    .join("");
  return `<div class="chart"><div class="t">${t}</div>${legendHtml}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t}, last 24 hours">${g}</svg><details data-k="${t}"><summary>Show the numbers</summary><table><thead><tr><th></th><th>Now</th><th>Avg</th><th>Min</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table></details></div>`;
}
