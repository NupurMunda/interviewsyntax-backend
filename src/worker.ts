import { createApp } from './app';
import { workersRateLimiter, type RateLimitBinding } from './rate-limit';
import { analyticsSink, type AnalyticsBinding } from './traffic';
import { d1Store, type D1Like } from './store/d1';

interface Env {
  DB: D1Like;
  RATE_LIMITER: RateLimitBinding;
  TRAFFIC?: AnalyticsBinding;
  ALLOWED_ORIGIN?: string;
  API_KEY?: string;
  ADMIN_PASSWORD?: string;
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    app ??= createApp(d1Store(env.DB), {
      allowedOrigin: env.ALLOWED_ORIGIN ?? 'http://localhost:5173',
      apiKey: env.API_KEY,
      rateLimiter: workersRateLimiter(env.RATE_LIMITER),
      traffic: env.TRAFFIC ? analyticsSink(env.TRAFFIC) : undefined,
      admin: env.ADMIN_PASSWORD
        ? { password: env.ADMIN_PASSWORD, analytics: env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID ? { accountId: env.CF_ACCOUNT_ID, token: env.CF_ANALYTICS_TOKEN } : undefined }
        : undefined,
      clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
    });
    return app.fetch(request, env, ctx as never);
  },
};
