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
import { LEAGUE_CFG } from './league-config.ts';
import { consoleLinkDelivery, createApi } from './league-api.ts';
import { createOrchestrator } from './league-orchestrator.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error('SESSION_SECRET is required');

const pool = new pg.Pool({ connectionString });
const orchestrator = await createOrchestrator({ pool, connectionString });
const api = await createApi({ pool, orchestrator, sessionSecret, delivery: consoleLinkDelivery });

// serve the built client when present (npm --prefix web run build); the SPA owns
// every non-/api path, so unknown GETs fall back to index.html for client routing
const webDist = fileURLToPath(new URL('./web/dist', import.meta.url));
if (existsSync(webDist)) {
  await api.register(fastifyStatic, { root: webDist });
  api.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
} else {
  console.warn('[league] web/dist not found — API only (run: npm --prefix web run build)');
}

await api.listen({ host: LEAGUE_CFG.apiHost, port: LEAGUE_CFG.apiPort });
console.log(`[league] api on http://${LEAGUE_CFG.apiHost}:${LEAGUE_CFG.apiPort}, pg-boss worker running`);

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
