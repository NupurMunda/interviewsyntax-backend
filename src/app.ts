import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { RateLimiter } from './rate-limit';
import { StoreUnavailableError, type CompanyRef, type DataStore } from './store/types';

export interface AppConfig {
  allowedOrigin: string;
  apiKey?: string;
  rateLimiter: RateLimiter;
  clientIp(c: Context): string;
}

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
    return c.json({ data: { ok: true }, meta: {} });
  });

  // One JSON line per request: the route pattern (not the URL), status and time. No IPs, keys or query values.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const route = c.req.matchedRoutes.map((r) => r.path).filter((p) => !p.endsWith('*')).at(-1) ?? 'unmatched';
    console.log(JSON.stringify({ event: 'request', method: c.req.method, route, status: c.res.status, ms: Date.now() - started }));
  });

  app.route('/v1', v1);
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
