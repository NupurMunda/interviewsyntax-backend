import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { RateLimiter } from './rate-limit';
import { buildReport, loadRaw, MAX_DAYS, renderHtml, type AnalyticsAccess } from './dashboard';
import { requestPoint, trackPoint, type TrafficSink } from './traffic';
import { StoreUnavailableError, type CompanyRef, type DataStore } from './store/types';

export interface AppConfig {
  allowedOrigin: string;
  apiKey?: string;
  rateLimiter: RateLimiter;
  clientIp(c: Context): string;
  traffic?: TrafficSink;
  // The password-protected traffic dashboard at /admin. Leave it out and the route does not exist.
  admin?: { password: string; analytics?: AnalyticsAccess };
}

// Compares two secrets without leaking, through timing, how many leading characters matched.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encode.encode(a)), crypto.subtle.digest('SHA-256', encode.encode(b))]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function basicPassword(header: string | undefined): string | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(':');
    return colon < 0 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

const adminQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).default(7) }).strict();
const ADMIN_CACHE_MS = 60_000;
const ADMIN_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

class HttpError extends Error {
  constructor(readonly status: 400 | 404, readonly code: string, message: string) {
    super(message);
  }
}

const MAX_LIMIT = 50;
const MIN_WINDOW_ROWS = 5;

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(20).transform((n) => Math.min(n, MAX_LIMIT)),
};
const MAX_GRAPH_NODES = 100;
const noQuery = z.object({}).strict();
const graphQuery = z
  .object({ limit: z.coerce.number().int().min(1).default(60).transform((n) => Math.min(n, MAX_GRAPH_NODES)) })
  .strict();
const pagedQuery = z.object(paging).strict();
const companiesQuery = z.object({ ...paging, q: z.string().trim().min(1).max(100).optional() }).strict();
const dsaQuery = z
  .object({
    ...paging,
    time_window: z.enum(['30d', '3m', '6m', '6m+', 'all']).default('6m'),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    topic: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

function parse<S extends z.ZodTypeAny>(c: Context, schema: S): z.infer<S> {
  const result = schema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!result.success) {
    throw new HttpError(400, 'bad_request', result.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '));
  }
  return result.data;
}

// Returns the normalised address, or null when the value is not an IP address.
function parseIp(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v)) return v;
  if (!v.includes(':') || !/^[0-9a-fA-F:.]+$/.test(v)) return null;
  try {
    return new URL(`http://[${v}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

const trackQuery = z
  .object({
    kind: z.enum(['view', 'query', 'error']),
    page: z.enum(['home', 'company', 'sources', 'prep', 'question']).optional(),
    company: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
    category: z.enum(['dsa', 'hld', 'ai', 'behavioral']).optional(),
    status: z.coerce.number().int().min(0).max(599).optional(),
  })
  .strict();

// A visitor is counted as a short hash of their address and the UTC date: it lets us count distinct
// visitors per day, changes every day, and cannot be turned back into the address.
async function visitorId(ip: string, day: string, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${day}|${pepper}`));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const prepKind = z.enum(['ai', 'system-design']);
const prepQuery = z.object({ ...paging, topic: z.string().trim().min(1).max(80).optional() }).strict();

const paged = (page: number, limit: number) => ({ page, limit, offset: (page - 1) * limit });

export function createApp(store: DataStore, config: AppConfig) {
  const app = new Hono();
  const v1 = new Hono();

  const company = async (c: Context): Promise<CompanyRef> => {
    const found = await store.findCompany(c.req.param('slug') ?? '');
    if (!found) throw new HttpError(404, 'not_found', 'company not found');
    return found;
  };
  const rateLimitKey = (c: Context) => {
    const forwarded = config.apiKey && c.req.header('x-api-key') === config.apiKey ? parseIp(c.req.header('x-client-ip')) : null;
    return forwarded ?? config.clientIp(c);
  };
  const listing = (c: Context, data: unknown[], page: number, limit: number, total: number, extra: object = {}) =>
    c.json({ data, meta: { page, limit, total, ...extra } });

  v1.use('*', cors({ origin: config.allowedOrigin, allowMethods: ['GET', 'OPTIONS'] }));
  v1.use('*', async (c, next) => {
    const { allowed, retryAfter } = await config.rateLimiter.check(rateLimitKey(c));
    if (!allowed) {
      return c.json({ error: { code: 'rate_limited', message: 'too many requests' } }, 429, { 'Retry-After': String(retryAfter) });
    }
    await next();
  });
  v1.use('*', async (c, next) => {
    if (config.apiKey && c.req.path !== '/v1/health' && c.req.header('x-api-key') !== config.apiKey) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid x-api-key' } }, 401);
    }
    await next();
  });
  v1.use('*', async (c, next) => {
    await next();
    if (c.req.path === '/v1/ping') c.header('Cache-Control', 'no-store');
    else if (c.req.path !== '/v1/health' && c.res.status === 200) c.header('Cache-Control', 'public, s-maxage=86400');
  });

  v1.get('/health', (c) => {
    parse(c, noQuery);
    return c.json({ data: { status: 'ok' }, meta: {} });
  });

  v1.get('/companies', async (c) => {
    const { q, page, limit } = parse(c, companiesQuery);
    const { items, total } = await store.listCompanies(q, paged(page, limit));
    return listing(c, items, page, limit, total);
  });

  v1.get('/companies/:slug', async (c) => {
    parse(c, noQuery);
    return c.json({ data: await store.getCompany(await company(c)), meta: {} });
  });

  v1.get('/companies/:slug/dsa', async (c) => {
    const query = parse(c, dsaQuery);
    const { id } = await company(c);
    const { page, limit, offset } = paged(query.page, query.limit);
    const base = { difficulty: query.difficulty, topic: query.topic, limit, offset };
    let timeWindow = query.time_window;
    let result = await store.listDsa(id, { ...base, timeWindow });
    const fallback = result.total < MIN_WINDOW_ROWS && timeWindow !== 'all';
    if (fallback) {
      timeWindow = 'all';
      result = await store.listDsa(id, { ...base, timeWindow });
    }
    return listing(c, result.items, page, limit, result.total, { time_window: timeWindow, fallback });
  });

  v1.get('/companies/:slug/hld', async (c) => {
    const { page, limit } = parse(c, pagedQuery);
    const { items, total } = await store.listHld((await company(c)).id, paged(page, limit));
    return listing(c, items, page, limit, total);
  });

  v1.get('/companies/:slug/ai', async (c) => {
    const { page, limit } = parse(c, pagedQuery);
    const { items, total } = await store.listAi((await company(c)).id, paged(page, limit));
    return listing(c, items, page, limit, total);
  });

  v1.get('/companies/:slug/behavioral', async (c) => {
    parse(c, noQuery);
    return c.json({ data: await store.getBehavioral((await company(c)).id), meta: {} });
  });

  // Questions that have an interview answer, for the AI and system design prep sections.
  v1.get('/prep/:kind', async (c) => {
    const kind = prepKind.safeParse(c.req.param('kind'));
    if (!kind.success) throw new HttpError(404, 'not_found', 'unknown section');
    const { topic, page, limit } = parse(c, prepQuery);
    const { items, total, questions, topics } = await store.listPrep(kind.data, topic, paged(page, limit));
    return listing(c, items, page, limit, total, { questions, topics });
  });

  v1.get('/resources/:id', async (c) => {
    parse(c, noQuery);
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'bad_request', 'id must be a positive integer');
    const resource = await store.getResource(id);
    if (!resource) throw new HttpError(404, 'not_found', 'resource not found');
    return c.json({ data: resource, meta: {} });
  });

  v1.get('/graph', async (c) => {
    const { limit } = parse(c, graphQuery);
    return c.json({ data: await store.getGraph(limit), meta: { limit } });
  });

  v1.get('/sources', async (c) => {
    parse(c, noQuery);
    const data = await store.listSources();
    return c.json({ data, meta: { total: data.length } });
  });

  // The browser reports what visitors did, because the CDN answers most repeat views without reaching us.
  v1.get('/ping', async (c) => {
    const event = parse(c, trackQuery);
    const visitor = await visitorId(rateLimitKey(c), new Date().toISOString().slice(0, 10), config.apiKey ?? '');
    console.log(JSON.stringify({ event: 'track', ...event, visitor }));
    config.traffic?.write(trackPoint(event, visitor));
    return c.json({ data: { ok: true }, meta: {} });
  });

  // One JSON line per request: the route pattern (not the URL), status and time. No IPs, keys or query values.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const route = c.req.matchedRoutes.map((r) => r.path).filter((p) => !p.endsWith('*')).at(-1) ?? 'unmatched';
    const ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'request', method: c.req.method, route, status: c.res.status, ms }));
    if (route !== '/admin') config.traffic?.write(requestPoint(route, c.req.method, c.res.status, ms));
  });

  app.route('/v1', v1);

  // Live traffic dashboard. Outside /v1 (so the API key and CORS rules do not apply) and not reachable through the site's proxy.
  const adminPages = new Map<number, { at: number; html: string }>();
  app.get('/admin', async (c) => {
    const admin = config.admin;
    if (!admin) return c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);
    const { allowed, retryAfter } = await config.rateLimiter.check(`admin:${config.clientIp(c)}`);
    if (!allowed) return c.json({ error: { code: 'rate_limited', message: 'too many requests' } }, 429, { 'Retry-After': String(retryAfter), ...ADMIN_HEADERS });
    const given = basicPassword(c.req.header('authorization'));
    if (given === null || !(await sameSecret(given, admin.password))) {
      return c.text('Authentication required', 401, { 'WWW-Authenticate': 'Basic realm="InterviewSyntax dashboard", charset="UTF-8"', ...ADMIN_HEADERS });
    }
    const parsed = adminQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'days must be a whole number from 1 to 90' } }, 400, ADMIN_HEADERS);
    if (!admin.analytics) return c.text('The dashboard is not configured: the Analytics Engine token is missing.', 503, ADMIN_HEADERS);
    const { days } = parsed.data;
    const cached = adminPages.get(days);
    const html = cached && Date.now() - cached.at < ADMIN_CACHE_MS
      ? cached.html
      : renderHtml(buildReport(await loadRaw(days, admin.analytics), days), { periods: [1, 7, 30, 90] });
    if (!cached || html !== cached.html) adminPages.set(days, { at: Date.now(), html });
    return c.html(html, 200, ADMIN_HEADERS);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof StoreUnavailableError) {
      console.error('database unavailable', err.cause);
      return c.json({ error: { code: 'temporarily_unavailable', message: 'the data service is temporarily unavailable, try again shortly' } }, 503, { 'Retry-After': '300' });
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });
  return app;
}
