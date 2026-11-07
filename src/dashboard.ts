// The traffic dashboard: SQL against Cloudflare Analytics Engine, the numbers derived from it, and the HTML page.
// Used by the protected /admin route (live) and by scripts/dashboard.mjs (a local copy, or fake data to preview the layout).
// The data points are described in src/traffic.ts. Nothing personal is stored, so nothing personal is shown.

export const TABLE = 'interviewsyntax_traffic';
export const MAX_DAYS = 90;

type Row = Record<string, unknown>;
export type RawResults = Record<string, Row[] | { error: string }>;

export function queries(days: number): Record<string, string> {
  const when = `timestamp > NOW() - INTERVAL '${Math.trunc(days)}' DAY`;
  const requests = `FROM ${TABLE} WHERE blob1 = 'request' AND ${when}`;
  const track = `FROM ${TABLE} WHERE blob1 = 'track' AND ${when}`;
  return {
    statuses: `SELECT double1 AS status, SUM(_sample_interval) AS n ${requests} GROUP BY status ORDER BY n DESC LIMIT 50`,
    routes: `SELECT blob2 AS route, double1 AS status, SUM(_sample_interval) AS n ${requests} GROUP BY route, status LIMIT 1000`,
    daily: `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, double1 AS status, SUM(_sample_interval) AS n ${requests} GROUP BY day, status ORDER BY day LIMIT 1000`,
    latency: `SELECT quantileWeighted(0.5)(double2, _sample_interval) AS p50, quantileWeighted(0.95)(double2, _sample_interval) AS p95 ${requests}`,
    companies: `SELECT blob4 AS company, SUM(_sample_interval) AS n ${track} AND blob2 = 'view' AND blob3 = 'company' AND blob4 != '' GROUP BY company ORDER BY n DESC LIMIT 20`,
    categories: `SELECT blob5 AS category, SUM(_sample_interval) AS n ${track} AND blob2 = 'query' AND blob5 != '' GROUP BY category ORDER BY n DESC LIMIT 10`,
    companyCategories: `SELECT blob4 AS company, blob5 AS category, SUM(_sample_interval) AS n ${track} AND blob2 = 'query' AND blob4 != '' AND blob5 != '' GROUP BY company, category ORDER BY n DESC LIMIT 20`,
    pages: `SELECT blob3 AS page, SUM(_sample_interval) AS n ${track} AND blob2 = 'view' AND blob3 != '' GROUP BY page ORDER BY n DESC LIMIT 10`,
    visitors: `SELECT COUNT(DISTINCT blob6) AS visitors ${track} AND blob2 = 'view'`,
    browserErrors: `SELECT double1 AS status, SUM(_sample_interval) AS n ${track} AND blob2 = 'error' GROUP BY status ORDER BY n DESC LIMIT 10`,
  };
}

export interface AnalyticsAccess {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export async function runQuery(sql: string, { accountId, token, fetchImpl = fetch }: AnalyticsAccess): Promise<Row[]> {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: `${sql} FORMAT JSON`,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Analytics Engine answered ${response.status}`);
  return (JSON.parse(text) as { data?: Row[] }).data ?? [];
}

// A panel whose query fails is reported on the page; the others still load.
export async function loadRaw(days: number, access: AnalyticsAccess): Promise<RawResults> {
  const entries = await Promise.all(
    Object.entries(queries(days)).map(async ([name, sql]): Promise<[string, Row[] | { error: string }]> => {
      try {
        return [name, await runQuery(sql, access)];
      } catch (error) {
        return [name, { error: error instanceof Error ? error.message : 'query failed' }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const sum = <T>(rows: T[], pick: (r: T) => number): number => rows.reduce((n, r) => n + pick(r), 0);
const top = <T extends { n: number }>(rows: T[], n: number): T[] => [...rows].sort((a, b) => b.n - a.n).slice(0, n);

export interface Report {
  days: number;
  total: number;
  ok: number;
  rateLimited: number;
  clientErrors: number;
  serverErrors: number;
  successRate: number | null;
  failureRate: number | null;
  statuses: { status: number; n: number }[];
  routes: { route: string; n: number; failed: number; serverErrors: number; failureRate: number }[];
  daily: { day: string; ok: number; client: number; server: number }[];
  p50: number | null;
  p95: number | null;
  companies: { company: string; n: number }[];
  categories: { category: string; n: number }[];
  companyCategories: { company: string; category: string; n: number }[];
  pages: { page: string; n: number }[];
  visitors: number | null;
  browserErrors: { status: number; n: number }[];
  unavailable: { name: string; error: string }[];
}

export function buildReport(raw: RawResults, days: number): Report {
  const unavailable: Report['unavailable'] = [];
  const rows = (name: string): Row[] => {
    const value = raw[name];
    if (value && !Array.isArray(value)) {
      unavailable.push({ name, error: value.error });
      return [];
    }
    return value ?? [];
  };
  const statuses = rows('statuses').map((r) => ({ status: num(r.status), n: num(r.n) }));
  const total = sum(statuses, (s) => s.n);
  const ok = sum(statuses.filter((s) => s.status < 400), (s) => s.n);
  const rateLimited = sum(statuses.filter((s) => s.status === 429), (s) => s.n);
  const clientErrors = sum(statuses.filter((s) => s.status >= 400 && s.status < 500 && s.status !== 429), (s) => s.n);
  const serverErrors = sum(statuses.filter((s) => s.status >= 500), (s) => s.n);

  const byRoute = new Map<string, { route: string; n: number; failed: number; serverErrors: number }>();
  for (const r of rows('routes')) {
    const route = String(r.route);
    const entry = byRoute.get(route) ?? { route, n: 0, failed: 0, serverErrors: 0 };
    entry.n += num(r.n);
    if (num(r.status) >= 400) entry.failed += num(r.n);
    if (num(r.status) >= 500) entry.serverErrors += num(r.n);
    byRoute.set(route, entry);
  }
  const routes = top([...byRoute.values()], 15).map((r) => ({ ...r, failureRate: r.n ? r.failed / r.n : 0 }));

  const byDay = new Map<string, { day: string; ok: number; client: number; server: number }>();
  for (const r of rows('daily')) {
    const day = String(r.day).slice(0, 10);
    const entry = byDay.get(day) ?? { day, ok: 0, client: 0, server: 0 };
    const status = num(r.status);
    if (status >= 500) entry.server += num(r.n);
    else if (status >= 400) entry.client += num(r.n);
    else entry.ok += num(r.n);
    byDay.set(day, entry);
  }
  const daily = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  const latency = rows('latency')[0];
  const visitors = rows('visitors')[0];
  return {
    days, total, ok, rateLimited, clientErrors, serverErrors,
    successRate: total ? ok / total : null,
    failureRate: total ? (total - ok) / total : null,
    statuses: statuses.sort((a, b) => b.n - a.n),
    routes, daily,
    p50: latency?.p50 == null ? null : num(latency.p50),
    p95: latency?.p95 == null ? null : num(latency.p95),
    companies: top(rows('companies').map((r) => ({ company: String(r.company), n: num(r.n) })), 15),
    categories: top(rows('categories').map((r) => ({ category: String(r.category), n: num(r.n) })), 10),
    companyCategories: top(rows('companyCategories').map((r) => ({ company: String(r.company), category: String(r.category), n: num(r.n) })), 15),
    pages: top(rows('pages').map((r) => ({ page: String(r.page), n: num(r.n) })), 10),
    visitors: visitors ? num(visitors.visitors) : null,
    browserErrors: top(rows('browserErrors').map((r) => ({ status: num(r.status), n: num(r.n) })), 10),
    unavailable,
  };
}

const CATEGORY_LABEL: Record<string, string> = { dsa: 'Coding (DSA)', hld: 'System design', ai: 'AI', behavioral: 'Behavioral' };
const PAGE_LABEL: Record<string, string> = { home: 'Home', company: 'Company page', sources: 'Sources', prep: 'Prep lists', question: 'Question answers' };

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const fmt = (n: number | null): string => (n == null ? 'n/a' : Math.round(n).toLocaleString('en-US'));
const pct = (v: number | null): string => (v == null ? 'n/a' : `${(v * 100).toFixed(v > 0 && v < 0.001 ? 2 : 1)}%`);
const ms = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v)} ms`);

function bars<T>(rows: T[], label: (r: T) => string, value: (r: T) => number, note?: (r: T) => string): string {
  if (!rows.length) return '<p class="muted">No data for this period yet.</p>';
  const max = Math.max(...rows.map(value), 1);
  return `<ul class="bars">${rows.map((r) => `<li><span class="label">${esc(label(r))}</span><span class="track"><span class="fill" style="width:${((value(r) / max) * 100).toFixed(1)}%"></span></span><span class="value">${fmt(value(r))}${note && note(r) ? ` <span class="muted">${esc(note(r))}</span>` : ''}</span></li>`).join('')}</ul>`;
}

function trend(daily: Report['daily']): string {
  if (!daily.length) return '<p class="muted">No data for this period yet.</p>';
  const max = Math.max(...daily.map((d) => d.ok + d.client + d.server), 1);
  const w = 100 / daily.length;
  const H = 120;
  const cols = daily.map((d, i) => {
    let y = H;
    return (['ok', 'client', 'server'] as const).map((k) => {
      const v = d[k];
      const h = (v / max) * H;
      y -= h;
      const what = k === 'ok' ? 'successful' : k === 'client' ? 'client errors (4xx)' : 'server errors (5xx)';
      return h > 0 ? `<rect class="${k}" x="${(i * w + w * 0.12).toFixed(2)}" y="${y.toFixed(2)}" width="${(w * 0.76).toFixed(2)}" height="${h.toFixed(2)}"><title>${esc(d.day)}: ${fmt(v)} ${what}</title></rect>` : '';
    }).join('');
  });
  return `<svg class="trend" viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="Requests per day">${cols.join('')}</svg><div class="axis"><span>${esc(daily[0].day)}</span><span>${esc(daily[daily.length - 1].day)}</span></div><p class="legend"><i class="ok"></i> successful <i class="client"></i> client errors (4xx) <i class="server"></i> server errors (5xx)</p>`;
}

const STYLE = `:root{--bg:#F5F7FA;--card:#fff;--ink:#14202B;--muted:#5B6B7A;--line:#D9E0E7;--accent:#2748D8;--ok:#2F9E6B;--client:#E0A33A;--server:#D64545;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0D141C;--card:#16202B;--ink:#E8EEF4;--muted:#93A2B1;--line:#263341;--accent:#8AA2FF;--ok:#5BC48C;--client:#E0A33A;--server:#FF8A80;color-scheme:dark}}
body{margin:0;padding:20px 16px 40px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font-size:24px}h2{margin:0 0 8px;font-size:17px}
.muted{color:var(--muted);font-size:13px}.big{font-size:28px;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card,section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.warn{border-color:var(--client)}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.bars{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.bars li{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:10px;align-items:center}
.label{overflow-wrap:anywhere;font-size:13px}.value{font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
.track{background:var(--bg);border-radius:6px;height:10px;overflow:hidden}.fill{display:block;height:100%;background:var(--accent);border-radius:6px}
.trend{width:100%;height:120px;display:block}.trend .ok{fill:var(--ok)}.trend .client{fill:var(--client)}.trend .server{fill:var(--server)}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px}.legend i.ok{background:var(--ok)}.legend i.client{background:var(--client)}.legend i.server{background:var(--server)}
nav a{color:var(--accent);margin-right:12px;font-size:13px}
footer{color:var(--muted);font-size:12px}`;

export function renderHtml(r: Report, { generated = new Date(), sample = false, periods = [] as number[] } = {}): string {
  const card = (title: string, value: string, note = '') => `<div class="card"><div class="muted">${esc(title)}</div><div class="big">${esc(value)}</div><div class="muted">${esc(note)}</div></div>`;
  const section = (title: string, body: string, note = '') => `<section><h2>${esc(title)}</h2>${note ? `<p class="muted">${esc(note)}</p>` : ''}${body}</section>`;
  const unavailable = r.unavailable.length
    ? `<section class="warn"><h2>Some panels could not be loaded</h2><ul>${r.unavailable.map((u) => `<li><b>${esc(u.name)}</b>: ${esc(u.error)}</li>`).join('')}</ul></section>`
    : '';
  const switcher = periods.length ? `<nav>${periods.map((d) => (d === r.days ? `<b>${d} days</b> ` : `<a href="?days=${d}">${d} days</a>`)).join('')}</nav>` : '';
  const outcome = [
    { label: 'Successful', n: r.ok }, { label: 'Rate limited (429)', n: r.rateLimited },
    { label: 'Client errors (other 4xx)', n: r.clientErrors }, { label: 'Server errors (5xx)', n: r.serverErrors },
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>InterviewSyntax traffic</title>
<style>${STYLE}</style></head><body><main>
<header><h1>InterviewSyntax traffic</h1><div class="muted">Last ${esc(r.days)} days${sample ? ' · SAMPLE DATA, not real traffic' : ''} · generated ${esc(generated.toISOString().replace('T', ' ').slice(0, 16))} UTC</div>${switcher}</header>
${unavailable}
<div class="grid">
${card('Requests that reached the server', fmt(r.total), 'cached views are not counted')}
${card('Success rate', pct(r.successRate), 'status below 400')}
${card('Failure rate', pct(r.failureRate), `${fmt(r.serverErrors)} server errors (5xx)`)}
${card('Unique visitors', fmt(r.visitors), 'counted per day, anonymous')}
${card('Response time', `${ms(r.p50)} median`, `${ms(r.p95)} for the slowest 5%`)}
</div>
${section('Requests per day', trend(r.daily))}
<div class="two">
${section('Success and failure', bars(outcome, (x) => x.label, (x) => x.n), 'Every call that reached the server, grouped by outcome.')}
${section('Failures by status code', bars(r.statuses.filter((s) => s.status >= 400), (s) => `HTTP ${s.status}`, (s) => s.n))}
</div>
${section('Most used APIs', bars(r.routes, (x) => x.route, (x) => x.n, (x) => (x.failed ? `${pct(x.failureRate)} failed` : '')), 'Calls that reached the server. The CDN answers most repeat requests, so this shows the load the server really carried.')}
<div class="two">
${section('Most clicked companies', bars(r.companies, (x) => x.company, (x) => x.n), 'Company pages opened, from the browser, so cached views are included.')}
${section('Round types opened', bars(r.categories, (x) => CATEGORY_LABEL[x.category] ?? x.category, (x) => x.n), 'Tabs opened on company pages.')}
</div>
<div class="two">
${section('Company and round type', bars(r.companyCategories, (x) => `${x.company} · ${CATEGORY_LABEL[x.category] ?? x.category}`, (x) => x.n))}
${section('Pages viewed', bars(r.pages, (x) => PAGE_LABEL[x.page] ?? x.page, (x) => x.n))}
</div>
${section('Failures the browser saw', bars(r.browserErrors, (x) => (x.status ? `HTTP ${x.status}` : 'Network error'), (x) => x.n), "Reported by visitors' browsers, so it includes failures that never reached the server.")}
<footer>Source: Cloudflare Analytics Engine, dataset ${esc(TABLE)}. Counts are sampling-adjusted. No IP addresses, keys or personal data are stored; a visitor is a daily-changing hash.</footer>
</main></body></html>
`;
}

// Deterministic fake numbers, so the layout can be checked without a token.
export function sampleRaw(days: number): RawResults {
  const count = Math.min(days, 14);
  const dayList = Array.from({ length: count }, (_, i) => new Date(Date.UTC(2026, 10, 8 - (count - 1 - i))).toISOString().replace('T', ' ').slice(0, 19));
  const daily = dayList.flatMap((day, i) => [
    { day, status: 200, n: 140 + ((i * 37) % 90) }, { day, status: 429, n: i % 4 === 0 ? 6 : 1 }, { day, status: 404, n: 3 + (i % 3) }, { day, status: 503, n: i === 5 ? 9 : 0 },
  ]);
  const routes = ([['/v1/companies/:slug', 200, 620], ['/v1/prep/:kind', 200, 410], ['/v1/companies', 200, 380], ['/v1/resources/:id', 200, 290], ['/v1/companies/:slug/dsa', 200, 240], ['/v1/companies/:slug/hld', 200, 150], ['/v1/companies/:slug/ai', 200, 120], ['/v1/companies/:slug', 404, 18], ['/v1/prep/:kind', 503, 9], ['/v1/companies', 429, 14]] as const)
    .map(([route, status, n]) => ({ route, status, n }));
  const named = <K extends string>(key: K, list: readonly (readonly [string, number])[]) => list.map(([v, n]) => ({ [key]: v, n }));
  return {
    statuses: [{ status: 200, n: 2210 }, { status: 429, n: 35 }, { status: 404, n: 44 }, { status: 503, n: 9 }],
    routes, daily,
    latency: [{ p50: 11, p95: 64 }],
    companies: named('company', [['google', 96], ['amazon', 88], ['meta', 71], ['microsoft', 52], ['apple', 33], ['uber', 29], ['stripe', 18]]),
    categories: named('category', [['dsa', 190], ['hld', 120], ['ai', 85], ['behavioral', 40]]),
    companyCategories: ([['google', 'dsa', 60], ['amazon', 'dsa', 44], ['meta', 'hld', 31], ['google', 'hld', 27], ['amazon', 'behavioral', 20]] as const).map(([company, category, n]) => ({ company, category, n })),
    pages: named('page', [['home', 640], ['company', 410], ['prep', 220], ['question', 130], ['sources', 25]]),
    visitors: [{ visitors: 318 }],
    browserErrors: [{ status: 503, n: 11 }, { status: 0, n: 4 }],
  };
}
