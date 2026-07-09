/**
 * league-server.ts — single-process entry point: pg-boss worker + HTTP API
 * share one Postgres pool. Split into separate processes when scale demands
 * (it won't, for an 8-manager league).
 *
 *   DATABASE_URL=postgres://... SESSION_SECRET=... node league-server.ts
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { consoleLinkDelivery, createApi, type LinkDelivery } from './league-api.ts';
import { resendLinkDelivery } from './league-email.ts';
import { createOrchestrator } from './league-orchestrator.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error('SESSION_SECRET is required');

// deploy config (fly.toml/docs/DEPLOY.md); local dev needs none of these
const host = process.env.HOST ?? LEAGUE_CFG.apiHost;
const port = Number(process.env.PORT ?? LEAGUE_CFG.apiPort);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got ${process.env.PORT}`);
const baseUrl = process.env.BASE_URL ?? `http://${host}:${port}`; // magic links point here

let delivery: LinkDelivery = consoleLinkDelivery;
if (process.env.RESEND_API_KEY) {
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set');
  delivery = resendLinkDelivery({ apiKey: process.env.RESEND_API_KEY, from });
} else if (process.env.BASE_URL) {
  // BASE_URL set but no email provider smells like a misconfigured production env
  console.warn('[league] RESEND_API_KEY not set — login links only go to stdout');
}

const pool = new pg.Pool({ connectionString });
const orchestrator = await createOrchestrator({ pool, connectionString });
const api = await createApi({ pool, orchestrator, sessionSecret, delivery, baseUrl });

// serve the built client when present (npm --prefix web run build); the SPA owns
// every non-/api path, so unknown GETs fall back to index.html for client routing
const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await api.register(fastifyStatic, { root: webDist });
  api.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
} else {
  console.warn('[league] web/dist not found — API only (run: npm --prefix web run build)');
}

await api.listen({ host, port });
console.log(`[league] api on http://${host}:${port} (links → ${baseUrl}), pg-boss worker running`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await api.close();
      await orchestrator.stop();
      await pool.end();
      process.exit(0);
    })();
  });
}
