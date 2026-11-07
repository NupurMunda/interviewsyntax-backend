import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { memoryRateLimiter } from '../src/rate-limit';
import { d1Store } from '../src/store/d1';
import { createStore, DERIVED_TABLES_SQL, type Row } from '../src/store/queries';
import { sqliteStore } from '../src/store/sqlite';

const fixture = new URL('../fixtures/sample.db', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const config = { allowedOrigin: 'http://localhost:5173', rateLimiter: memoryRateLimiter(1_000_000), clientIp: () => '203.0.113.7' };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('database failures', () => {
  const failing = (message: string) => ({
    prepare: () => ({ bind: () => ({ all: async () => { throw new Error(message); } }) }),
  });

  it('returns 503 with Retry-After and no internals when D1 fails', async () => {
    const app = createApp(d1Store(failing('D1_ERROR: daily rows read limit exceeded')), config);
    for (const path of ['/companies', '/companies/acme', '/graph', '/sources', '/resources/3']) {
      const res = await app.request(`/v1${path}`);
      expect(res.status, path).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('300');
      expect(res.headers.get('Cache-Control')).toBeNull();
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('temporarily_unavailable');
      expect(text).not.toMatch(/D1_ERROR|limit exceeded/);
    }
  });

  it('keeps /health up and 404s unaffected when D1 fails', async () => {
    const app = createApp(d1Store(failing('boom')), config);
    expect((await app.request('/v1/health')).status).toBe(200);
    expect((await app.request('/v1/nothing')).status).toBe(404);
  });

  it('still reports unexpected bugs as 500', async () => {
    const buggy = { ...sqliteStore(fixture), listSources: async () => { throw new Error('bug'); } };
    const res = await createApp(buggy, config).request('/v1/sources');
    expect(res.status).toBe(500);
    expect((await res.json() as any).error.code).toBe('internal');
  });
});

// D1's free plan allows 5M rows read per day, so no request may scan a big table.
describe('query plans', () => {
  it('never scan the large tables', async () => {
    const db = new DatabaseSync(fixture, { readOnly: true });
    db.exec(DERIVED_TABLES_SQL);
    const seen: { sql: string; params: unknown[] }[] = [];
    const store = createStore(async (sql, params) => {
      seen.push({ sql, params });
      return db.prepare(sql).all(...(params as never[])) as Row[];
    });

    const paging = { limit: 20, offset: 0 };
    await store.listCompanies(undefined, paging);
    await store.listCompanies('ac', paging);
    const company = (await store.findCompany('acme'))!;
    await store.getCompany(company);
    for (const query of [{}, { difficulty: 'hard' as const }, { topic: 'Array' }]) {
      await store.listDsa(company.id, { timeWindow: '6m', ...paging, ...query });
    }
    await store.listHld(company.id, paging);
    await store.listAi(company.id, paging);
    await store.getBehavioral(company.id);
    await store.getResource(3);
    await store.getResource(11);
    await store.listSources();
    await store.getGraph(60);

    const bigTables = /^SCAN (cr|r|company_resources|resources)\b/; // 37k and 4k rows; every other table has under 600
    const scans: string[] = [];
    for (const { sql, params } of seen) {
      for (const row of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]) {
        if (bigTables.test(row.detail)) scans.push(`${row.detail}  <-  ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(scans).toEqual([]);
    expect(seen.length).toBeGreaterThan(15);
  });
});

describe('request log', () => {
  it('writes one JSON line per request with route, status and time only', async () => {
    const { vi } = await import('vitest');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    try {
      const app = createApp(sqliteStore(fixture), { ...config, apiKey: 'secret-key' });
      const headers = { 'x-api-key': 'secret-key', 'x-client-ip': '198.51.100.9' };
      await app.request('/v1/companies/acme/dsa?topic=Array&time_window=all', { headers });
      await app.request('/v1/companies/nope', { headers });
      await app.request('/v1/companies');
      await app.request('/v1/health');
      await app.request('/v1/nothing');
    } finally {
      spy.mockRestore();
    }
    const logged = lines.map((l) => JSON.parse(l));
    expect(logged.map((l) => [l.route, l.status])).toEqual([
      ['/v1/companies/:slug/dsa', 200], ['/v1/companies/:slug', 404], ['/v1/companies', 401], ['/v1/health', 200], ['unmatched', 401],
    ]);
    expect(logged.every((l) => l.event === 'request' && l.method === 'GET' && typeof l.ms === 'number')).toBe(true);
    expect(lines.join('\n')).not.toMatch(/198\.51\.100|secret-key|Array|time_window|acme/);
  });
});

describe('visitor tracking', () => {
  const run = async (calls: { path: string; ip?: string; key?: string }[]) => {
    const { vi } = await import('vitest');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const out: Response[] = [];
    try {
      const app = createApp(sqliteStore(fixture), { ...config, apiKey: 'secret-key' });
      for (const call of calls) {
        out.push(await app.request(call.path, { headers: { 'x-api-key': call.key ?? 'secret-key', 'x-client-ip': call.ip ?? '198.51.100.9' } }));
      }
    } finally {
      spy.mockRestore();
    }
    return { out, events: lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'track'), text: lines.join('\n') };
  };

  it('logs one event per ping, never caches it, and stores no address', async () => {
    const { out, events, text } = await run([
      { path: '/v1/ping?kind=view&page=company&company=acme' },
      { path: '/v1/ping?kind=query&company=acme&category=hld' },
      { path: '/v1/ping?kind=error&status=503' },
    ]);
    expect(out.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(out.every((r) => r.headers.get('Cache-Control') === 'no-store')).toBe(true);
    expect(events.map((e) => [e.kind, e.page, e.company, e.category, e.status])).toEqual([
      ['view', 'company', 'acme', undefined, undefined], ['query', undefined, 'acme', 'hld', undefined], ['error', undefined, undefined, undefined, 503],
    ]);
    expect(events.every((e) => /^[0-9a-f]{12}$/.test(e.visitor))).toBe(true);
    expect(text).not.toMatch(/198\.51\.100|secret-key/);
  });

  it('gives the same visitor the same id, and different visitors different ids', async () => {
    const { events } = await run([
      { path: '/v1/ping?kind=view&page=home', ip: '198.51.100.9' },
      { path: '/v1/ping?kind=view&page=home', ip: '198.51.100.9' },
      { path: '/v1/ping?kind=view&page=home', ip: '198.51.100.10' },
    ]);
    expect(events[0].visitor).toBe(events[1].visitor);
    expect(events[0].visitor).not.toBe(events[2].visitor);
  });

  it('rejects unknown kinds, categories, odd slugs and extra params', async () => {
    const { out, events } = await run([
      { path: '/v1/ping?kind=hack' },
      { path: '/v1/ping?kind=query&category=secret' },
      { path: '/v1/ping?kind=view&company=Acme%20Corp' },
      { path: '/v1/ping?kind=view&extra=1' },
      { path: '/v1/ping' },
    ]);
    expect(out.map((r) => r.status)).toEqual([400, 400, 400, 400, 400]);
    expect(events).toEqual([]);
  });

  it('needs the API key', async () => {
    const { out, events } = await run([{ path: '/v1/ping?kind=view&page=home', key: 'wrong' }]);
    expect(out[0].status).toBe(401);
    expect(events).toEqual([]);
  });
});

describe('traffic points', () => {
  const collect = () => {
    const points: any[] = [];
    return { points, traffic: { write: (p: unknown) => void points.push(p) } };
  };

  it('writes one point per request with route, method, status and time, and no address', async () => {
    const { points, traffic } = collect();
    const app = createApp(sqliteStore(fixture), { ...config, apiKey: 'secret-key', traffic });
    const headers = { 'x-api-key': 'secret-key', 'x-client-ip': '198.51.100.9' };
    await app.request('/v1/companies/acme/dsa?time_window=all', { headers });
    await app.request('/v1/companies/nobody', { headers });
    await app.request('/v1/companies');
    expect(points.map((p) => [p.blobs[0], p.blobs[1], p.blobs[2], p.doubles[0]])).toEqual([
      ['request', '/v1/companies/:slug/dsa', 'GET', 200], ['request', '/v1/companies/:slug', 'GET', 404], ['request', '/v1/companies', 'GET', 401],
    ]);
    expect(points.every((p) => p.blobs.length === 6 && p.doubles.length === 2 && typeof p.doubles[1] === 'number' && p.indexes.length === 1)).toBe(true);
    expect(JSON.stringify(points)).not.toMatch(/198\.51\.100|secret-key|time_window|nobody/);
  });

  it('writes one track point per ping with the page, company, category and a daily visitor hash', async () => {
    const { points, traffic } = collect();
    const app = createApp(sqliteStore(fixture), { ...config, apiKey: 'secret-key', traffic });
    const headers = { 'x-api-key': 'secret-key', 'x-client-ip': '198.51.100.9' };
    await app.request('/v1/ping?kind=view&page=company&company=acme', { headers });
    await app.request('/v1/ping?kind=query&company=acme&category=hld', { headers });
    await app.request('/v1/ping?kind=error&status=503', { headers });
    const track = points.filter((p) => p.blobs[0] === 'track');
    expect(track.map((p) => [p.blobs[1], p.blobs[2], p.blobs[3], p.blobs[4], p.doubles[0]])).toEqual([
      ['view', 'company', 'acme', '', 0], ['query', '', 'acme', 'hld', 0], ['error', '', '', '', 503],
    ]);
    expect(track.every((p) => /^[0-9a-f]{12}$/.test(p.blobs[5]))).toBe(true);
    expect(JSON.stringify(points)).not.toMatch(/198\.51\.100|secret-key/);
  });

  it('keeps answering when recording a point fails, and when there is no sink at all', async () => {
    const { analyticsSink } = await import('../src/traffic');
    const broken = analyticsSink({ writeDataPoint() { throw new Error('analytics down'); } });
    const quiet = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const withBroken = createApp(sqliteStore(fixture), { ...config, traffic: broken });
      expect((await withBroken.request('/v1/health')).status).toBe(200);
      expect((await withBroken.request('/v1/ping?kind=view&page=home')).status).toBe(200);
      const without = createApp(sqliteStore(fixture), config);
      expect((await without.request('/v1/health')).status).toBe(200);
    } finally {
      quiet.mockRestore();
    }
  });
});
