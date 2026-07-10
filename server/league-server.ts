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
import { AgentEngine } from '@fm/engine/agent';
import { LEAGUE_CFG } from '@fm/engine/config';
import { consoleLinkDelivery, createApi, type LinkDelivery } from './league-api.ts';
import { resendLinkDelivery } from './league-email.ts';
import { createOrchestrator } from './league-orchestrator.ts';
import { cadenceOverrideActive, forceWeekCloseEnabled, matchweekCadenceMs } from './league-test-overrides.ts';

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

// ⚠️ TEST-ONLY auction timer override. The REAL timers are LEAGUE_CFG's
// 120s lot / 20s soft close — this env var exists so a test league can run
// fast lots WITHOUT editing config (an edited working tree deployed via
// `fly deploy --local-only` is invisible; an env var shows up in
// `fly config show`). MUST be unset for launch: `fly secrets unset
// AUCTION_LOT_SECONDS_TEST` (or remove from [env]) and redeploy.
let auctionTuning: { lotSeconds: number; softCloseSeconds: number } | undefined;
if (process.env.AUCTION_LOT_SECONDS_TEST) {
  const lotSeconds = Number(process.env.AUCTION_LOT_SECONDS_TEST);
  if (!Number.isFinite(lotSeconds) || lotSeconds <= 0) throw new Error('AUCTION_LOT_SECONDS_TEST must be a positive number');
  auctionTuning = { lotSeconds, softCloseSeconds: Math.max(1, Math.min(lotSeconds / 3, 20)) };
  console.warn(
    `[league] ⚠️⚠️ TEST OVERRIDE ACTIVE: auction lots close in ${lotSeconds}s ` +
    `(soft close ${auctionTuning.softCloseSeconds}s) — NOT the real ` +
    `${LEAGUE_CFG.auctionLotSeconds}s/${LEAGUE_CFG.auctionSoftCloseSeconds}s. Unset AUCTION_LOT_SECONDS_TEST before launch.`,
  );
}

// ⚠️ TEST-ONLY matchweek overrides (league-test-overrides.ts) — same
// discipline as the auction timer: env-gated, loud, in the launch checklist.
if (cadenceOverrideActive()) {
  console.warn(
    `[league] ⚠️⚠️ TEST OVERRIDE ACTIVE: matchweek cadence ${matchweekCadenceMs() / 60_000} min ` +
    `(real: ${LEAGUE_CFG.matchweekCadenceDays} days). Unset MATCHWEEK_CADENCE_MINUTES_TEST before launch.`,
  );
}
if (forceWeekCloseEnabled()) {
  console.warn(
    '[league] ⚠️⚠️ TEST OVERRIDE ACTIVE: POST /api/admin/force-week-close is LIVE ' +
    '(closes + sims the current matchweek on demand). Unset TEST_FORCE_WEEK_CLOSE before launch.',
  );
}

// sim engine: default = the calibrated AggregateEngine. SIM_ENGINE=agent
// opts in to the spatial sim — integration + sim-cost verified, but it does
// NOT yet meet the stat-harness bands (DECISIONS 2026-08-29): per-match
// stats will read off-spec (possession spreads, offsides). Visible in
// `fly config show`, like every operational knob.
if (process.env.SIM_ENGINE && !['agent', 'aggregate'].includes(process.env.SIM_ENGINE)) {
  throw new Error(`SIM_ENGINE must be 'agent' or 'aggregate', got ${process.env.SIM_ENGINE}`);
}
const engine = process.env.SIM_ENGINE === 'agent' ? new AgentEngine() : undefined; // undefined → orchestrator default (aggregate)
if (engine) {
  console.warn(
    '[league] ⚠️ SIM_ENGINE=agent — the spatial sim is live: real replay motion, but per-match ' +
    'stats are NOT yet calibrated to the harness bands (possession spread, offsides — DECISIONS 2026-08-29)',
  );
}

const pool = new pg.Pool({ connectionString });
const orchestrator = await createOrchestrator({ pool, connectionString, auctionTuning, engine });
const api = await createApi({
  pool, orchestrator, sessionSecret, delivery, baseUrl,
  testForceWeekClose: forceWeekCloseEnabled(),
});

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
