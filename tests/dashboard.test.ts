import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildReport, esc, loadRaw, queries, renderHtml, sampleRaw } from '../src/dashboard';
import { memoryRateLimiter } from '../src/rate-limit';
import { sqliteStore } from '../src/store/sqlite';

const fixture = new URL('../fixtures/sample.db', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const base = { allowedOrigin: 'http://localhost:5173', rateLimiter: memoryRateLimiter(1_000_000), clientIp: () => '203.0.113.7' };
const auth = (password: string) => ({ authorization: `Basic ${btoa(`admin:${password}`)}` });

describe('report', () => {
  it('derives success, failure and per-route rates from raw rows', () => {
    const r = buildReport({
      statuses: [{ status: 200, n: 90 }, { status: 429, n: 4 }, { status: 404, n: 4 }, { status: 503, n: 2 }],
      routes: [{ route: '/a', status: 200, n: 60 }, { route: '/a', status: 503, n: 2 }, { route: '/b', status: 200, n: 30 }],
      daily: [{ day: '2026-11-02 00:00:00', status: 200, n: 5 }, { day: '2026-11-01 00:00:00', status: 500, n: 1 }],
      latency: [{ p50: 10, p95: 80 }], visitors: [{ visitors: 7 }],
    }, 7);
    expect([r.total, r.ok, r.rateLimited, r.clientErrors, r.serverErrors]).toEqual([100, 90, 4, 4, 2]);
    expect(r.successRate).toBeCloseTo(0.9);
    expect(r.routes[0]).toMatchObject({ route: '/a', n: 62, failed: 2 });
    expect(r.daily.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-02']);
    expect([r.p50, r.p95, r.visitors]).toEqual([10, 80, 7]);
  });

  it('survives an empty dataset and reports a failed query without losing the rest', () => {
    const empty = buildReport({}, 7);
    expect(empty.successRate).toBeNull();
    const partial = buildReport({ statuses: [{ status: 200, n: 3 }], routes: { error: 'Analytics Engine answered 500' } }, 7);
    expect(partial.total).toBe(3);
    expect(partial.unavailable).toEqual([{ name: 'routes', error: 'Analytics Engine answered 500' }]);
    expect(renderHtml(partial)).toContain('Some panels could not be loaded');
  });

  it('escapes every value that came from stored data', () => {
    const html = renderHtml(buildReport({ companies: [{ company: '<img src=x onerror=alert(1)>', n: 3 }] }, 7));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(esc(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });

  it('renders the sample data and builds one query per panel', () => {
    const html = renderHtml(buildReport(sampleRaw(7), 7), { sample: true });
    expect(html).toContain('SAMPLE DATA');
    expect(Object.keys(queries(7))).toEqual(Object.keys(sampleRaw(7)));
    expect(queries(30).statuses).toContain("INTERVAL '30' DAY");
  });

  it('sends the token to Cloudflare and turns a failure into a panel error', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: String(init.body) });
      return seen.length === 1 ? new Response('nope', { status: 500 }) : Response.json({ data: [{ n: 1 }] });
    }) as unknown as typeof fetch;
    const raw = await loadRaw(7, { accountId: 'acc', token: 'tok', fetchImpl });
    expect(seen[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql');
    expect(seen.every((s) => s.auth === 'Bearer tok' && s.body.endsWith('FORMAT JSON'))).toBe(true);
    expect(Object.values(raw).filter((v) => !Array.isArray(v))).toHaveLength(1);
  });
});

describe('/admin', () => {
  const analytics = {
    accountId: 'acc', token: 'tok',
    fetchImpl: (async () => Response.json({ data: [{ status: 200, n: 5 }] })) as unknown as typeof fetch,
  };
  const app = (admin?: object) => createApp(sqliteStore(fixture), { ...base, apiKey: 'api-key', admin: admin as never });

  it('does not exist unless a password is configured', async () => {
    expect((await app().request('/admin')).status).toBe(404);
  });

  it('asks for a password, rejects a wrong one and accepts the right one', async () => {
    const a = app({ password: 's3cret', analytics });
    const none = await a.request('/admin');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Basic');
    expect((await a.request('/admin', { headers: auth('wrong') })).status).toBe(401);
    expect((await a.request('/admin', { headers: { authorization: 'Basic %%%' } })).status).toBe(401);
    expect((await a.request('/admin', { headers: { 'x-api-key': 'api-key' } })).status).toBe(401);
    const ok = await a.request('/admin?days=30', { headers: auth('s3cret') });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await ok.text()).toContain('Last 30 days');
  });

  it('validates days and says so when the analytics token is missing', async () => {
    const a = app({ password: 's3cret', analytics });
    expect((await a.request('/admin?days=500', { headers: auth('s3cret') })).status).toBe(400);
    expect((await a.request('/admin?x=1', { headers: auth('s3cret') })).status).toBe(400);
    const noToken = app({ password: 's3cret' });
    expect((await noToken.request('/admin', { headers: auth('s3cret') })).status).toBe(503);
  });

  it('does not count its own page views as API traffic', async () => {
    const points: unknown[] = [];
    const a = createApp(sqliteStore(fixture), { ...base, traffic: { write: (p) => void points.push(p) }, admin: { password: 's3cret', analytics } });
    await a.request('/admin', { headers: auth('s3cret') });
    expect(points).toHaveLength(0);
  });
});
