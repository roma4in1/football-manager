/**
 * league-facilities.test.ts — facilities economy: invest endpoint (atomic
 * debit, cap, budget, phase gates) and the medical effects on the real
 * bookkeeping/tick paths with stubbed injuries.
 *
 *   npm run db:test:up && node --test league-facilities.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { HalfResult, HalfStats, MatchEvent } from '@fm/engine/types';
import { LEAGUE_CFG, facilityUpgradeCost, medicalInjuryAvoidProb, trainingGrowthMul } from '@fm/engine/config';
import { createApi, SESSION_COOKIE, type LinkDelivery } from './league-api.ts';
import { createOrchestrator, type Orchestrator } from './league-orchestrator.ts';
import { injuryWeeks, createCore } from './league-orchestrator.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, seedClub, seedSeason } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const SECRET = 'facilities-test-secret';

let pool: pg.Pool;
let orch: Orchestrator;
let api: FastifyInstance;
let seasonId: string;
let clubA: string, clubB: string;
let playersA: string[], playersB: string[];
let cookieA: string;

const delivered: Array<{ email: string; url: string }> = [];
const delivery: LinkDelivery = {
  async sendLoginLink(email, url) {
    delivered.push({ email, url });
  },
};
const q = (text: string, params?: unknown[]) => pool.query(text, params);

async function login(email: string): Promise<string> {
  delivered.length = 0;
  await api.inject({ method: 'POST', url: '/api/auth/request-link', payload: { email } });
  const token = new URL(delivered[0].url).searchParams.get('token')!;
  const res = await api.inject({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(token)}` });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

type Call = { method: 'GET' | 'POST'; url: string; payload?: unknown };
const call = ({ method, url, payload }: Call) =>
  api.inject({
    method,
    url,
    cookies: { [SESSION_COOKIE]: cookieA },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool); // phase 'regular'
  ({ clubId: clubA, playerIds: playersA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@fac.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub(pool, seasonId, 'Beta', 'beta@fac.io'));
  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 0.5 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET, delivery });
  cookieA = await login('alpha@fac.io');
});

after(async () => {
  await api?.close();
  await orch?.stop();
  await pool?.end();
});

// ── invest endpoint ──────────────────────────────────────────────────────────

test('facilities view: levels 0, next costs from config, budget remaining', async () => {
  const res = await call({ method: 'GET', url: '/api/facilities' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.training.level, 0);
  assert.equal(body.medical.level, 0);
  assert.equal(body.training.nextCost, LEAGUE_CFG.facilityCostByLevel[0]);
  assert.equal(body.budgetRemaining, 100_000);
  assert.equal(body.investmentOpen, true);
});

test('invest: level +1 and budget debit are one transaction, txn row recorded', async () => {
  const res = await call({ method: 'POST', url: '/api/facilities/invest', payload: { facility: 'medical' } });
  assert.equal(res.statusCode, 204);

  const view = (await call({ method: 'GET', url: '/api/facilities' })).json();
  assert.equal(view.medical.level, 1);
  assert.equal(view.medical.nextCost, LEAGUE_CFG.facilityCostByLevel[1]);
  assert.equal(view.budgetRemaining, 100_000 - LEAGUE_CFG.facilityCostByLevel[0]);

  const txns = await q(
    `SELECT kind, amount FROM transactions WHERE club_id = $1 AND kind = 'facility_investment'`,
    [clubA],
  );
  assert.equal(txns.rowCount, 1);
  assert.equal(Number(txns.rows[0].amount), LEAGUE_CFG.facilityCostByLevel[0]);
});

test('invest: unknown facility 400; level cap 422; over-budget 422 leaves nothing behind', async () => {
  assert.equal((await call({ method: 'POST', url: '/api/facilities/invest', payload: { facility: 'stadium' } })).statusCode, 400);

  await q(`UPDATE club_seasons SET medical_level = 5 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  const capped = await call({ method: 'POST', url: '/api/facilities/invest', payload: { facility: 'medical' } });
  assert.equal(capped.statusCode, 422);
  assert.equal(capped.json().error, 'level_cap');
  await q(`UPDATE club_seasons SET medical_level = 1 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);

  await q(`UPDATE club_seasons SET transfer_budget = 7000 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  // 5,000 already spent → remaining 2,000 < 5,000 (training level 0 cost)
  const poor = await call({ method: 'POST', url: '/api/facilities/invest', payload: { facility: 'training' } });
  assert.equal(poor.statusCode, 422);
  assert.equal(poor.json().error, 'insufficient_budget');
  const level = await q(`SELECT training_level FROM club_seasons WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  assert.equal(level.rows[0].training_level, 0, 'rejected investment writes nothing');
  const txns = await q(`SELECT count(*) FROM transactions WHERE club_id = $1 AND kind = 'facility_investment'`, [clubA]);
  assert.equal(Number(txns.rows[0].count), 1, 'no txn recorded for the rejection');
  await q(`UPDATE club_seasons SET transfer_budget = 100000 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
});

// ── medical effects on the real bookkeeping path ─────────────────────────────

function stubHalves(injuredIds: string[], allIds: string[]): { h1: HalfResult; h2: HalfResult } {
  const playerState = Object.fromEntries(allIds.map((id) => [
    id,
    { fatigue: 0.5, cards: { yellows: 0 as const, sentOff: false }, injured: injuredIds.includes(id), minutesPlayed: 90 },
  ]));
  const zero: [number, number] = [0, 0];
  const stats: HalfStats = {
    possession: [50, 50], shots: zero, shotsOnTarget: zero, xg: zero, passAccuracy: [80, 80],
    aerialsWon: zero, ppda: [12, 12], fieldTilt: [50, 50], playerRatings: {}, heatmaps: {},
  };
  const injuries: MatchEvent[] = injuredIds.map((id, i) => ({ t: 100 + i, type: 'injury', playerId: id }));
  const mk = (events: MatchEvent[]): HalfResult => ({
    events, frames: [], stats,
    endState: { v: 2, score: [0, 0], playerState, subsUsed: [0, 0], rngState: '0'.repeat(32) },
  });
  return { h1: mk([{ t: 0, type: 'kickoff' }, ...injuries]), h2: mk([{ t: 5400, type: 'halfEnd' }]) };
}

async function runStubbedFixture(seed: string): Promise<{ applied: number; totalWeeks: number }> {
  const mw = await q(
    `INSERT INTO matchweeks (season_id, number, opens_at, deadline_at)
     VALUES ($1, (SELECT COALESCE(MAX(number),0)+1 FROM matchweeks WHERE season_id = $1), now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
    [seasonId],
  );
  const fx = await q(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed, state) VALUES ($1, $2, $3, $4, 'final') RETURNING id`,
    [mw.rows[0].id, clubA, clubB, seed],
  );
  const fixtureId = fx.rows[0].id as string;
  const injured = playersA.slice(0, 10); // ten Alpha knocks
  const { h1, h2 } = stubHalves(injured, [...playersA.slice(0, 11), ...playersB.slice(0, 11)]);
  await store.insertHalfResult(pool, fixtureId, 1, h1);
  await store.insertHalfResult(pool, fixtureId, 2, h2);

  const core = createCore({ pool });
  assert.equal(await core.applyBookkeeping(fixtureId), 'applied');

  const rows = await q(
    `SELECT injury_weeks_left FROM squad_players WHERE season_id = $1 AND player_id = ANY($2) AND injury_weeks_left > 0`,
    [seasonId, injured],
  );
  const applied = rows.rowCount ?? 0;
  const totalWeeks = rows.rows.reduce((s, r) => s + r.injury_weeks_left, 0);
  // reset for the next scenario
  await q(`UPDATE squad_players SET injury_weeks_left = 0, just_returned = FALSE WHERE season_id = $1`, [seasonId]);
  return { applied, totalWeeks };
}

test('medical level measurably reduces applied injuries and their duration', async () => {
  await q(`UPDATE club_seasons SET medical_level = 0 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  const at0 = await runStubbedFixture('medical-ab');
  assert.equal(at0.applied, 10, 'level 0 avoids nothing');

  await q(`UPDATE club_seasons SET medical_level = 5 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  const at5 = await runStubbedFixture('medical-ab'); // SAME seed → same deterministic draws
  assert.ok(at5.applied < at0.applied, `level 5 shrugs some off (${at5.applied} < ${at0.applied})`);
  assert.ok(at5.totalWeeks < at0.totalWeeks, `and shortens the rest (${at5.totalWeeks} < ${at0.totalWeeks} weeks)`);
  assert.ok(at5.applied > 0, 'injuries still happen at max medical');
  await q(`UPDATE club_seasons SET medical_level = 0 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
});

test('weekly fatigue recovery scales with medical level in the tick SQL', async () => {
  await q(`UPDATE squad_players SET fatigue = 0.5 WHERE season_id = $1`, [seasonId]);
  await q(`UPDATE club_seasons SET medical_level = 5 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  await store.recoverFatigue(pool, seasonId, LEAGUE_CFG.fatigueWeeklyRecovery, LEAGUE_CFG.medicalRecoveryBonusPerLevel);
  const a = await q(`SELECT fatigue FROM squad_players WHERE season_id = $1 AND club_id = $2 LIMIT 1`, [seasonId, clubA]);
  const b = await q(`SELECT fatigue FROM squad_players WHERE season_id = $1 AND club_id = $2 LIMIT 1`, [seasonId, clubB]);
  assert.ok(Number(a.rows[0].fatigue) < Number(b.rows[0].fatigue), 'level-5 club recovers more than level-0');
  await q(`UPDATE club_seasons SET medical_level = 0 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
});

// ── pure curves + the training hook contract ─────────────────────────────────

test('curves: neutral at 0, monotone, meaningful-not-trivializing at 5', () => {
  assert.equal(medicalInjuryAvoidProb(0), 0);
  assert.ok(Math.abs(medicalInjuryAvoidProb(5) - 0.3) < 1e-9);
  for (const [p1, p2] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]) {
    assert.ok(injuryWeeks('curve-seed', 'p', p2) <= injuryWeeks('curve-seed', 'p', p1), 'duration monotone in level');
  }
  assert.equal(facilityUpgradeCost(5), null);
  assert.ok(LEAGUE_CFG.facilityCostByLevel.every((c, i, a) => i === 0 || c > a[i - 1]), 'each level dearer');
  // training hook: neutral at 0, defined slope — consumed by the growth PR
  assert.equal(trainingGrowthMul(0), 1);
  assert.ok(trainingGrowthMul(5) > 1.5);
});

// runs LAST (uses legal forward transitions): open in transfer_window,
// closed from season_end on — the same gate the auction phase hits
test('invest: open in the transfer window, closed once the season ends', async () => {
  await q(`UPDATE seasons SET phase = 'transfer_window' WHERE id = $1`, [seasonId]);
  const inWindow = await call({ method: 'POST', url: '/api/facilities/invest', payload: { facility: 'training' } });
  assert.equal(inWindow.statusCode, 204, 'transfer window is a management window');
  await q(`UPDATE seasons SET phase = 'regular' WHERE id = $1`, [seasonId]);

  await q(`UPDATE seasons SET phase = 'season_end' WHERE id = $1`, [seasonId]);
  const closed = await call({ method: 'POST', url: '/api/facilities/invest', payload: { facility: 'training' } });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().error, 'investment_closed');
  const view = (await call({ method: 'GET', url: '/api/facilities' })).json();
  assert.equal(view.investmentOpen, false);
});
