import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { memoryRateLimiter } from '../src/rate-limit';
import { d1Store } from '../src/store/d1';
import { DERIVED_TABLES_SQL, type Row } from '../src/store/queries';
import { sqliteStore } from '../src/store/sqlite';

const fixture = new URL('../fixtures/sample.db', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const config = (limit = 1_000_000) => ({
  allowedOrigin: 'http://localhost:5173',
  rateLimiter: memoryRateLimiter(limit),
  clientIp: () => '203.0.113.7',
});
const makeApp = (limit?: number) => createApp(sqliteStore(fixture), config(limit));
const app = makeApp();

async function get(path: string, target = app) {
  const res = await target.request(`/v1${path}`);
  return { res, text: await res.clone().text(), body: await res.json() as any };
}

const allPaths = [
  '/health', '/companies', '/companies/acme', '/companies/acme/dsa', '/companies/acme/hld', '/companies/acme/ai',
  '/companies/acme/behavioral', '/companies/globex', '/companies/globex/dsa', '/companies/initech', '/companies/initech/behavioral',
  '/graph', '/graph?limit=1', '/sources', '/prep/ai', '/prep/system-design', '/prep/ai?topic=Topic%20AI', ...Array.from({ length: 20 }, (_, i) => `/resources/${i + 1}`),
];

describe('response shapes', () => {
  it('wraps successes in {data, meta}', async () => {
    for (const path of allPaths.filter((p) => !p.startsWith('/resources/'))) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      expect(body, path).toHaveProperty('data');
      expect(body, path).toHaveProperty('meta');
    }
  });

  it('GET /health', async () => {
    expect((await get('/health')).body).toEqual({ data: { status: 'ok' }, meta: {} });
  });

  it('GET /companies lists visible companies with counts per category', async () => {
    const { body } = await get('/companies');
    expect(body.meta).toEqual({ page: 1, limit: 20, total: 3 });
    expect(body.data.map((c: any) => c.slug)).toEqual(['acme', 'globex', 'initech']);
    expect(body.data[0]).toEqual({ name: 'Acme', slug: 'acme', counts: { dsa: 8, hld: 2, ai: 2, behavioral: 2 } });
    expect(body.data[2].counts).toEqual({ dsa: 0, hld: 0, ai: 0, behavioral: 0 });
    expect((await get('/companies?q=glo')).body.data.map((c: any) => c.slug)).toEqual(['globex']);
  });

  it('GET /companies/:slug returns profile, categories, values and sources', async () => {
    const { body } = await get('/companies/acme');
    expect(body.data.profile).toEqual({
      summary: 'Fixture summary for Acme',
      rounds: [{ stage: 'Virtual', number: '1', text: 'Fixture screen' }],
      other_steps: ['Fixture other step'],
      confidence: 'medium', level: 'L1', notes: 'Fixture note',
      source_urls: ['https://example.test/acme'], last_reviewed: '2026-01-01',
    });
    expect(body.data.categories).toEqual({ dsa: 8, hld: 2, ai: 2, behavioral: 2 });
    expect(body.data.values.map((v: any) => v.name)).toEqual(['Fixture value one', 'Fixture value two']);
    expect(body.data.values[0]).toEqual({ name: 'Fixture value one', blurb: 'Fixture blurb one', official_source_url: 'https://example.test/values' });
    expect(body.data.sources.map((s: any) => s.name)).toEqual(['fx-open', 'fx-link', 'manual:fx-notes']);
  });

  it('GET /companies/:slug/dsa returns items sorted by frequency', async () => {
    const { body } = await get('/companies/acme/dsa');
    expect(body.meta).toEqual({ page: 1, limit: 20, total: 6, time_window: '6m', fallback: false });
    expect(body.data[0]).toEqual({ id: 3, title: 'Fixture Problem 1', url: 'https://example.test/r/3', difficulty: 'easy', topics: ['Array'], frequency: 10 });
    expect(body.data.map((d: any) => d.frequency)).toEqual([10, 9, 8, 7, 6, 5]);
  });

  it('filters DSA by difficulty and topic', async () => {
    const hard = (await get('/companies/acme/dsa?difficulty=hard')).body;
    expect(hard.data.map((d: any) => d.difficulty)).toEqual(['hard', 'hard']);
    expect((await get('/companies/acme/dsa?time_window=all&topic=Tree')).body.data.map((d: any) => d.title)).toEqual(['Fixture Problem 7']);
  });

  it('GET /companies/:slug/hld returns questions with approved solutions only', async () => {
    const { body } = await get('/companies/acme/hld');
    expect(body.meta.total).toBe(2);
    expect(body.data[0]).toMatchObject({ id: 11, title: 'Fixture HLD question', difficulty: null });
    expect(body.data[0].solutions).toEqual([{ title: 'Fixture approved solution', url: 'https://example.test/sol/1', confidence: 'high', source: 'manual:fx-notes' }]);
    expect(body.data[1].solutions).toEqual([]);
    expect(body.data[0].summary).toBe('FAKE SUMMARY for the fixture question');
    expect(body.data[0].links.map((l: any) => l.label)).toEqual(['Fixture link one', 'Fixture link two']);
    expect(body.data[1].links).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('HIDDEN');
  });

  it('GET /companies/:slug/ai', async () => {
    const { body } = await get('/companies/acme/ai');
    expect(body.meta.total).toBe(2);
    expect(body.data.map((d: any) => d.title)).toEqual(['Fixture AI question one', 'Fixture AI question two']);
    expect(body.data.map((d: any) => d.has_answer)).toEqual([true, false]);
  });

  it('GET /companies/:slug/behavioral returns values and topics', async () => {
    const { body } = await get('/companies/acme/behavioral');
    expect(body.data.values).toHaveLength(2);
    expect(body.data.topics).toEqual([
      { slug: 'fx-topic-one', name: 'Fixture topic one', question_types: 'fixture question types', typical_round: 'unknown' },
      { slug: 'fx-topic-two', name: 'Fixture topic two', question_types: null, typical_round: null },
    ]);
    expect((await get('/companies/globex/behavioral')).body.data.values).toEqual([]);
  });

  it('GET /resources/:id', async () => {
    const { body } = await get('/resources/11');
    expect(body.data).toMatchObject({
      id: 11, title: 'Fixture HLD question', category: 'hld', url: 'https://example.test/r/11', difficulty: null,
      source: { name: 'fx-link', license: 'NONE' }, companies: [{ name: 'Acme', slug: 'acme' }, { name: 'Globex', slug: 'globex' }],
    });
    expect(body.data.solutions).toHaveLength(1);
    expect((await get('/resources/3')).body.data.category).toBe('dsa');
    expect((await get('/resources/12')).body.data.category).toBe('hld');
    expect((await get('/resources/1')).body.data.category).toBe('ai');
  });

  it('GET /sources returns credits', async () => {
    const { body } = await get('/sources');
    expect(body.meta.total).toBe(3);
    expect(body.data[0]).toEqual({
      name: 'fx-open', repo_url: 'https://example.test/open', license: 'Apache-2.0', author: 'Fixture Author',
      license_text: 'FAKE LICENSE TEXT', notice_text: 'FAKE NOTICE TEXT', adapted: true, adaptation_note: 'FAKE ADAPTATION NOTE',
    });
    expect(body.data[1]).toMatchObject({ name: 'fx-link', adapted: false, license_text: null });
  });

  it('uses the error envelope for 404 and 400', async () => {
    for (const path of ['/companies/nope', '/resources/9999', '/companies/nope/dsa']) {
      const { res, body } = await get(path);
      expect(res.status).toBe(404);
      expect(body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    }
    const bad = await get('/resources/abc');
    expect(bad.res.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_request');
    const unknownRoute = await app.request('/v1/nothing');
    expect(unknownRoute.status).toBe(404);
  });
});

describe('visibility rules', () => {
  it('never leaks hidden rows in lists, counts, detail pages or /sources', async () => {
    for (const path of allPaths) {
      const { text } = await get(path);
      expect(text, path).not.toMatch(/HIDDEN/);
    }
    expect((await get('/resources/14')).res.status).toBe(404);
    expect((await get('/resources/15')).res.status).toBe(404);
    expect((await get('/companies/acme/dsa?time_window=all&limit=50')).body.meta.total).toBe(8);
    expect((await get('/companies/initech')).body.data.categories).toEqual({ dsa: 0, hld: 0, ai: 0, behavioral: 0 });
    expect((await get('/companies/globex')).body.data.profile).toBeNull();
    expect((await get('/sources')).body.data.map((s: any) => s.name)).not.toContain('fx-hidden');
  });

  it('excludes readme rows everywhere', async () => {
    expect((await get('/resources/13')).res.status).toBe(404);
    const hld = (await get('/companies/acme/hld')).body;
    expect(hld.data.map((d: any) => d.title)).not.toContain('Fixture README');
    expect((await get('/companies/acme')).body.data.categories.hld).toBe(2);
  });

  it('serves content_md only from /resources/:id and only for full sources', async () => {
    for (const path of ['/companies/acme/dsa', '/companies/acme/hld', '/companies/acme/ai', '/companies/acme']) {
      expect((await get(path)).text, path).not.toContain('content_md');
    }
    expect((await get('/resources/1')).body.data.content_md).toBe('FAKE AI CONTENT ONE');
    for (const id of [3, 11, 12]) expect((await get(`/resources/${id}`)).body.data.content_md, `resource ${id}`).toBeNull();
    for (let id = 1; id <= 20; id++) expect((await get(`/resources/${id}`)).text).not.toMatch(/FAKE LINK CONTENT|FAKE HLD CONTENT|FAKE NOTE CONTENT/);
  });
});

describe('dsa window fallback', () => {
  it('falls back to all when the window has fewer than 5 rows', async () => {
    const { body } = await get('/companies/globex/dsa');
    expect(body.meta).toEqual({ page: 1, limit: 20, total: 8, time_window: 'all', fallback: true });
    expect(body.data).toHaveLength(8);
  });

  it('does not fall back when asked for all, or when the window is large enough', async () => {
    expect((await get('/companies/globex/dsa?time_window=all')).body.meta.fallback).toBe(false);
    expect((await get('/companies/acme/dsa?time_window=6m')).body.meta.fallback).toBe(false);
    expect((await get('/companies/acme/dsa?time_window=30d')).body.meta).toMatchObject({ time_window: 'all', fallback: true });
  });
});

describe('request handling', () => {
  it('rejects unknown params with 400', async () => {
    for (const path of ['/companies?foo=1', '/companies/acme?x=1', '/companies/acme/dsa?sort=asc', '/companies/acme/hld?q=a', '/health?x=1', '/sources?page=1', '/resources/3?x=1']) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(400);
      expect(body.error.code).toBe('bad_request');
    }
  });

  it('rejects invalid values with 400', async () => {
    for (const path of ['/companies?page=0', '/companies?limit=0', '/companies?limit=abc', '/companies/acme/dsa?time_window=1y', '/companies/acme/dsa?difficulty=impossible']) {
      expect((await get(path)).res.status, path).toBe(400);
    }
  });

  it('caps limit at 50 and paginates', async () => {
    const capped = (await get('/companies/acme/dsa?time_window=all&limit=500')).body;
    expect(capped.meta.limit).toBe(50);
    const first = (await get('/companies/acme/dsa?time_window=all&limit=3&page=1')).body;
    const second = (await get('/companies/acme/dsa?time_window=all&limit=3&page=2')).body;
    expect(first.data).toHaveLength(3);
    expect(second.meta.page).toBe(2);
    expect(second.data.map((d: any) => d.id)).not.toContain(first.data[0].id);
  });

  it('returns 429 with Retry-After after 60 requests per minute', async () => {
    const limited = makeApp(60);
    for (let i = 0; i < 60; i++) expect((await limited.request('/v1/health')).status).toBe(200);
    const res = await limited.request('/v1/health');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
  });

  it('limits CORS to ALLOWED_ORIGIN and sets cache headers on data routes only', async () => {
    const res = await app.request('/v1/companies', { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=86400');
    expect((await app.request('/v1/health')).headers.get('Cache-Control')).toBeNull();
    expect((await app.request('/v1/companies/nope')).headers.get('Cache-Control')).toBeNull();
  });
});

describe('d1 adapter', () => {
  it('returns the same results as the sqlite adapter', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(fixture, { readOnly: true });
    db.exec(DERIVED_TABLES_SQL);
    const d1 = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(values as never[])) as Row[] }) }) }) };
    const viaD1 = createApp(d1Store(d1), config());
    for (const path of allPaths.filter((p) => p !== '/health')) {
      const [a, b] = [await get(path), await get(path, viaD1)];
      expect(b.res.status, path).toBe(a.res.status);
      expect(b.body, path).toEqual(a.body);
    }
  });
});

describe('export-d1 script', () => {
  it('writes SQL that serves the same results, without hidden rows or non-full content', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'rw-export-')), 'import.sql');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/export-d1.mjs', out], { env: { ...process.env, KB_DB_PATH: fixture }, stdio: 'pipe' });
    const sql = readFileSync(out, 'utf8');
    expect(sql).not.toMatch(/HIDDEN/);
    expect(sql).not.toMatch(/FAKE (LINK|HLD|NOTE|README) CONTENT/);
    expect(sql).toContain('FAKE AI CONTENT ONE');
    expect(sql).toContain('CREATE TABLE company_stats');
    expect(sql).not.toMatch(/BEGIN|COMMIT/);

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(sql);
    const d1 = { prepare: (q: string) => ({ bind: (...values: unknown[]) => ({ all: async () => ({ results: db.prepare(q).all(...(values as never[])) as Row[] }) }) }) };
    const imported = createApp(d1Store(d1), config());
    for (const path of allPaths.filter((p) => p !== '/health')) {
      const [a, b] = [await get(path), await get(path, imported)];
      expect(b.res.status, path).toBe(a.res.status);
      expect(b.body, path).toEqual(a.body);
    }
  });
});

describe('api key gate', () => {
  const keyed = createApp(sqliteStore(fixture), { ...config(), apiKey: 'secret-key' });

  it('requires x-api-key on every route except /health when API_KEY is set', async () => {
    for (const path of ['/companies', '/companies/acme', '/resources/3', '/sources', '/nothing']) {
      const res = await keyed.request(`/v1${path}`);
      expect(res.status, path).toBe(401);
      expect((await res.json() as any).error.code).toBe('unauthorized');
    }
    expect((await keyed.request('/v1/companies', { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
    expect((await keyed.request('/v1/companies', { headers: { 'x-api-key': 'secret-key' } })).status).toBe(200);
    expect((await keyed.request('/v1/health')).status).toBe(200);
  });

  it('skips the check when API_KEY is not set', async () => {
    expect((await app.request('/v1/companies')).status).toBe(200);
  });
});

describe('hld urls', () => {
  it('returns url null for HLD question items', async () => {
    const { body } = await get('/companies/acme/hld');
    expect(body.data.map((d: any) => d.url)).toEqual([null, null]);
  });
});

describe('local: paths', () => {
  it('never reach responses or the export', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const copy = join(mkdtempSync(join(tmpdir(), 'rw-local-')), 'local.db');
    const src = new DatabaseSync(fixture);
    src.exec(`VACUUM INTO '${copy.split(sep).join('/')}'`);
    src.close();
    const db = new DatabaseSync(copy);
    db.exec("UPDATE resources SET url = 'local:data/seed/q.md#1' WHERE id = 11; UPDATE sources SET repo_url = 'local:data/seed/q.md' WHERE id = 4");
    db.close();
    const localApp = createApp(sqliteStore(copy), config());
    for (const path of ['/resources/11', '/sources', '/companies/acme/hld', '/companies/acme']) {
      expect(await (await localApp.request(`/v1${path}`)).text(), path).not.toContain('local:');
    }
    expect(((await (await localApp.request('/v1/resources/11')).json()) as any).data.url).toBeNull();

    const out = join(mkdtempSync(join(tmpdir(), 'rw-export-')), 'import.sql');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/export-d1.mjs', out], { env: { ...process.env, KB_DB_PATH: copy }, stdio: 'pipe' });
    const sql = readFileSync(out, 'utf8');
    expect(sql).not.toContain('local:');
    const mem = new DatabaseSync(':memory:');
    mem.exec(sql);
    expect(mem.prepare('SELECT url FROM resources WHERE id = 11').get()).toEqual({ url: '' });
  });
});

describe('graph', () => {
  it('returns top companies by visible resources and shared HLD questions', async () => {
    const { res, body } = await get('/graph');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=86400');
    expect(body.meta).toEqual({ limit: 60 });
    expect(body.data).toEqual({
      nodes: [{ slug: 'acme', name: 'Acme', size: 12 }, { slug: 'globex', name: 'Globex', size: 10 }],
      edges: [{ a: 'acme', b: 'globex', weight: 2 }],
    });
  });

  it('only returns edges between returned nodes and honours limit', async () => {
    const { body } = await get('/graph?limit=1');
    expect(body.data).toEqual({ nodes: [{ slug: 'acme', name: 'Acme', size: 12 }], edges: [] });
  });

  it('never counts hidden rows: hidden shared question adds no edge or size', async () => {
    const { text, body } = await get('/graph?limit=100');
    expect(text).not.toMatch(/HIDDEN|initech/);
    expect(body.data.nodes.map((n: any) => n.slug)).not.toContain('initech');
    expect(body.data.edges.every((e: any) => e.weight === 2)).toBe(true);
  });

  it('caps limit at 100 and validates params', async () => {
    expect((await get('/graph?limit=500')).body.meta.limit).toBe(100);
    for (const path of ['/graph?limit=0', '/graph?limit=abc', '/graph?x=1']) expect((await get(path)).res.status, path).toBe(400);
  });
});

describe('rate-limit key', () => {
  const recorded = () => {
    const keys: string[] = [];
    const rateLimiter = { check: async (key: string) => (keys.push(key), { allowed: true, retryAfter: 1 }) };
    return { keys, app: createApp(sqliteStore(fixture), { ...config(), rateLimiter, apiKey: 'secret-key' }) };
  };
  const call = async (app: ReturnType<typeof createApp>, headers: Record<string, string>) => app.request('/v1/health', { headers });

  it('uses x-client-ip when the api key is valid and the value is an IP', async () => {
    const { keys, app } = recorded();
    await call(app, { 'x-api-key': 'secret-key', 'x-client-ip': '198.51.100.9' });
    await call(app, { 'x-api-key': 'secret-key', 'x-client-ip': '2001:DB8::1' });
    expect(keys).toEqual(['198.51.100.9', '2001:db8::1']);
  });

  it('uses the connecting IP otherwise', async () => {
    const { keys, app } = recorded();
    await call(app, { 'x-client-ip': '198.51.100.9' });
    await call(app, { 'x-api-key': 'wrong', 'x-client-ip': '198.51.100.9' });
    await call(app, { 'x-api-key': 'secret-key', 'x-client-ip': 'not-an-ip' });
    await call(app, { 'x-api-key': 'secret-key', 'x-client-ip': '999.1.1.1' });
    await call(app, { 'x-api-key': 'secret-key' });
    expect(keys).toEqual(Array(5).fill('203.0.113.7'));
  });

  it('ignores x-client-ip when no API_KEY is configured', async () => {
    const keys: string[] = [];
    const open = createApp(sqliteStore(fixture), { ...config(), rateLimiter: { check: async (k) => (keys.push(k), { allowed: true, retryAfter: 1 }) } });
    await open.request('/v1/health', { headers: { 'x-api-key': 'anything', 'x-client-ip': '198.51.100.9' } });
    expect(keys).toEqual(['203.0.113.7']);
  });

  it('limits each forwarded client separately', async () => {
    const app = createApp(sqliteStore(fixture), { ...config(), rateLimiter: memoryRateLimiter(2), apiKey: 'secret-key' });
    const as = (ip: string) => app.request('/v1/health', { headers: { 'x-api-key': 'secret-key', 'x-client-ip': ip } });
    expect([(await as('198.51.100.1')).status, (await as('198.51.100.1')).status, (await as('198.51.100.1')).status]).toEqual([200, 200, 429]);
    expect((await as('198.51.100.2')).status).toBe(200);
  });
});

describe('interview answers', () => {
  it('GET /resources/:id carries the answer, or null when there is none', async () => {
    const { body } = await get('/resources/1');
    expect(body.data.answer.short).toBe('FAKE SHORT ANSWER AI');
    expect(body.data.answer.sections[0]).toEqual({ heading: 'Fixture heading AI', paragraphs: ['FAKE PARAGRAPH AI'], points: ['FAKE POINT AI'] });
    expect(body.data.answer.sources).toEqual([{ title: 'Fixture source AI', url: 'https://example.test/answer-source' }]);
    expect(body.data.answer.written).toBe('2026-01-03');
    expect((await get('/resources/2')).body.data.answer).toBeNull();
  });

  it('GET /prep/ai lists answered questions with per-topic progress', async () => {
    const { res, body } = await get('/prep/ai');
    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: 1, title: 'Fixture AI question one', topics: ['Topic AI'], written: '2026-01-03', summary: null, concepts: [], links: [] }]);
    expect(body.meta).toEqual({ page: 1, limit: 20, total: 1, questions: 2, topics: [{ name: 'Topic AI', answered: 1, total: 2 }] });
  });

  it('GET /prep/system-design lists the visible hld questions with their links in order', async () => {
    const { body } = await get('/prep/system-design');
    expect(body.data.map((q: any) => q.id)).toEqual([11]);
    expect(body.data[0].summary).toBe('FAKE SUMMARY for the fixture question');
    expect(body.data[0].concepts).toEqual(['fake concept one', 'fake concept two', 'fake concept three']);
    expect(body.data[0].links).toEqual([
      { label: 'Fixture link one', url: 'https://example.test/link/1' },
      { label: 'Fixture link two', url: 'https://example.test/link/2' },
    ]);
    expect(body.meta.questions).toBe(1);
  });

  it('filters by topic, and a topic with no answers is empty', async () => {
    expect((await get('/prep/ai?topic=Topic%20AI')).body.meta.total).toBe(1);
    expect((await get('/prep/ai?topic=Nothing')).body.data).toEqual([]);
  });

  it('never shows an answer that belongs to a hidden source', async () => {
    const all = (await get('/prep/system-design')).text + (await get('/resources/15')).text;
    expect(all).not.toContain('HIDDEN');
    expect((await get('/resources/15')).res.status).toBe(404);
  });

  it('rejects an unknown section and unknown parameters', async () => {
    expect((await get('/prep/behavioral')).res.status).toBe(404);
    expect((await get('/prep/ai?foo=1')).res.status).toBe(400);
  });
});
