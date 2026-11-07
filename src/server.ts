import { serve } from '@hono/node-server';
import type { IncomingMessage } from 'node:http';
import { createApp } from './app';
import { memoryRateLimiter } from './rate-limit';
import { sqliteStore } from './store/sqlite';

const dbPath = process.env.KB_DB_PATH ?? 'C:\\Project\\kb\\data\\kb.db';

const app = createApp(sqliteStore(dbPath), {
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173',
  rateLimiter: memoryRateLimiter(),
  clientIp: (c) => (c.env as { incoming: IncomingMessage }).incoming.socket.remoteAddress ?? 'unknown',
});

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8787 }, ({ address, port }) => {
  console.log(`interviewsyntax-backend on http://${address}:${port}/v1 (db: ${dbPath})`);
});
