/**
 * league-admin.test.ts — the TEST-ONLY force-week-close endpoint.
 *
 * The guard is the property: with the flag off the route does not exist
 * (404 — cannot fire in a real season); with it on, a confirm string is
 * still required, and the confirmed call runs the REAL week-close path —
 * deadline pulled to now(), both halves simmed with defaults, bookkeeping,
 * the between-week tick, and the reveal. Results become visible exactly as
 * a deadline firing would make them.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createApi, SESSION_COOKIE, type LinkDelivery } from './league-api.ts';
import { createOrchestrator, type Orchestrator } from './league-orchestrator.ts';
import { bootstrapSchema, seedClub, seedSeason } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const SECRET = 'admin-test-secret';

let pool: pg.Pool;
let orch: Orchestrator;
let api: FastifyInstance; // testForceWeekClose: true
let apiDisabled: FastifyInstance; // default flags
let seasonId: string;
let clubA: string, clubB: string;
let fixtureId: string;
let matchweekId: string;
let cookie: string;

const delivered: Array<{ url: string }> = [];
const delivery: LinkDelivery = {
  async sendLoginLink(_email, url) {
    delivered.push({ url });
  },
};

const q = (text: string, params?: unknown[]) => pool.query(text, params);

async function login(app: FastifyInstance, email: string): Promise<string> {
  delivered.length = 0;
  await app.inject({ method: 'POST', url: '/api/auth/request-link', payload: { email } });
  const token = new URL(delivered[0].url).searchParams.get('token')!;
  const res = await app.inject({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(token)}` });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool);
  ({ clubId: clubA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@adm.io'));
  ({ clubId: clubB } = await seedClub(pool, seasonId, 'Beta', 'beta@adm.io'));

  // an open matchweek whose deadline is comfortably in the FUTURE — exactly
  // the state where testing would otherwise wait out the cadence
  const mw = await q(
    `INSERT INTO matchweeks (season_id, number, opens_at, deadline_at)
     VALUES ($1, 1, now() - interval '1 hour', now() + interval '7 days') RETURNING id`,
    [seasonId],
  );
  matchweekId = mw.rows[0].id;
  const fx = await q(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed) VALUES ($1, $2, $3, 'adm-1') RETURNING id`,
    [matchweekId, clubA, clubB],
  );
  fixtureId = fx.rows[0].id;

  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 0.5 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET, delivery, testForceWeekClose: true });
  apiDisabled = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET, delivery });
  cookie = await login(api, 'alpha@adm.io');
});

after(async () => {
  await api?.close();
  await apiDisabled?.close();
  await orch?.stop();
  await pool?.end();
});

test('flag off → the route does not exist (404), season untouched', async () => {
  const cookieOff = await login(apiDisabled, 'alpha@adm.io');
  const res = await apiDisabled.inject({
    method: 'POST', url: '/api/admin/force-week-close',
    cookies: { [SESSION_COOKIE]: cookieOff },
    payload: { confirm: 'SIM NOW' },
  });
  assert.equal(res.statusCode, 404);
  const mw = await q(`SELECT revealed_at FROM matchweeks WHERE id = $1`, [matchweekId]);
  assert.equal(mw.rows[0].revealed_at, null);
});

test('flag on but no confirm string → 400, nothing runs', async () => {
  for (const payload of [{}, { confirm: 'yes' }, { confirm: 'sim now' }]) {
    const res = await api.inject({
      method: 'POST', url: '/api/admin/force-week-close',
      cookies: { [SESSION_COOKIE]: cookie }, payload,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'confirm_required');
  }
  const fx = await q(`SELECT state FROM fixtures WHERE id = $1`, [fixtureId]);
  assert.equal(fx.rows[0].state, 'scheduled');
});

test('confirmed → the REAL week-close runs now: sims, bookkeeping, tick, reveal', async () => {
  const res = await api.inject({
    method: 'POST', url: '/api/admin/force-week-close',
    cookies: { [SESSION_COOKIE]: cookie },
    payload: { confirm: 'SIM NOW' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { matchweek: 1, kind: 'regular', status: 'closed' });

  const fx = await q(`SELECT state, bookkept_at FROM fixtures WHERE id = $1`, [fixtureId]);
  assert.equal(fx.rows[0].state, 'final', 'both halves simmed (defaults — nobody submitted)');
  assert.ok(fx.rows[0].bookkept_at, 'bookkeeping applied');
  const mw = await q(`SELECT revealed_at, deadline_at FROM matchweeks WHERE id = $1`, [matchweekId]);
  assert.ok(mw.rows[0].revealed_at, 'the reveal happened');
  assert.ok(new Date(mw.rows[0].deadline_at) <= new Date(), 'deadline was pulled to now');

  // and the result is visible through the normal embargo join — same as a
  // deadline firing (participant view, post-reveal)
  const result = await api.inject({
    method: 'GET', url: `/api/fixture/${fixtureId}/result`,
    cookies: { [SESSION_COOKIE]: cookie },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().halves.length, 2);
});

test('a second force on the same (now revealed) week → 409 no_open_matchweek', async () => {
  const res = await api.inject({
    method: 'POST', url: '/api/admin/force-week-close',
    cookies: { [SESSION_COOKIE]: cookie },
    payload: { confirm: 'SIM NOW' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'no_open_matchweek');
});
