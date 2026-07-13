/**
 * league-training.test.ts — training focus + season-end growth on the real
 * tick and week-close paths.
 *
 * The league here is a MICRO-SEASON: matchweek_count 2, transfer week after
 * week 1 — so three week-closes walk the entire choreography that production
 * runs: regular → transfer_window → regular → season_end (+ growth applied).
 *
 *   npm run db:test:up && node --test league-training.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { HalfResult, HalfStats, MatchEvent } from '@fm/engine/types';
import { LEAGUE_CFG, trainingGrowthMul } from '@fm/engine/config';
import { ageDecline, minutesMul } from '@fm/engine/growth';
import { createApi, SESSION_COOKIE } from './league-api.ts';
import { createCore, createOrchestrator, type Orchestrator, type OrchestratorCore } from './league-orchestrator.ts';
import { applySeasonEndGrowth } from './league-training.ts';
import * as store from './league-store.ts';
import { apiLogin, bootstrapSchema, flatAttributes, seedClub } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const SECRET = 'training-test-secret';

let pool: pg.Pool;
let orch: Orchestrator;
let core: OrchestratorCore;
let api: FastifyInstance;
let seasonId: string;
let clubA: string, clubB: string;
let playersA: string[], playersB: string[];
let youngId: string, oldId: string, poolId: string;
let cookieA: string, cookieB: string;
let mw1: string, mwBye: string, mwFinal: string;

const q = (text: string, params?: unknown[]) => pool.query(text, params);

const login = (email: string): Promise<string> => apiLogin(api, email);

const progressOf = async (playerId: string): Promise<Record<string, number>> =>
  (await q(`SELECT training_progress FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playerId]))
    .rows[0].training_progress;

const attrsOf = async (playerId: string): Promise<Record<string, number>> =>
  (await q(`SELECT attributes FROM players WHERE id = $1`, [playerId])).rows[0].attributes;

const seasonPhase = async (): Promise<string> =>
  (await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase;

/** stub final fixture: XI of each club played 90', reserves absent (0'). */
function stubHalves(allIds: string[]): { h1: HalfResult; h2: HalfResult } {
  const playerState = Object.fromEntries(allIds.map((id) => [
    id,
    { fatigue: 0.4, cards: { yellows: 0 as const, sentOff: false }, injured: false, minutesPlayed: 90 },
  ]));
  const zero: [number, number] = [0, 0];
  const stats: HalfStats = {
    possession: [50, 50], shots: zero, shotsOnTarget: zero, xg: zero, passAccuracy: [80, 80],
    aerialsWon: zero, ppda: [12, 12], fieldTilt: [50, 50], playerRatings: {}, heatmaps: {},
  };
  const mk = (events: MatchEvent[]): HalfResult => ({
    events, frames: [], stats,
    endState: { v: 2, score: [0, 0], playerState, subsUsed: [0, 0], rngState: '0'.repeat(32) },
  });
  return { h1: mk([{ t: 0, type: 'kickoff' }]), h2: mk([{ t: 5400, type: 'halfEnd' }]) };
}

async function insertFinalFixture(mwId: string, seed: string): Promise<void> {
  const fx = await q(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed, state) VALUES ($1, $2, $3, $4, 'final') RETURNING id`,
    [mwId, clubA, clubB, seed],
  );
  const { h1, h2 } = stubHalves([...playersA.slice(0, 11), ...playersB.slice(0, 11)]);
  await store.insertHalfResult(pool, fx.rows[0].id, 1, h1);
  await store.insertHalfResult(pool, fx.rows[0].id, 2, h2);
}

async function addPlayer(name: string, birth: string, contractedTo: string | null): Promise<string> {
  const p = await q(
    `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, market_value, attributes, physical)
     VALUES ($1, $2, 'MF', 180, 75, 1000000, $3, '{"injuryProneness": 10}') RETURNING id`,
    [name, birth, JSON.stringify(flatAttributes(false))],
  );
  const id = p.rows[0].id as string;
  if (contractedTo) {
    await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`,
      [id, contractedTo, seasonId]);
    await q(`INSERT INTO squad_players (club_id, season_id, player_id, fatigue) VALUES ($1, $2, $3, 0.1)`,
      [contractedTo, seasonId, id]);
  }
  return id;
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);

  // MICRO-SEASON: 2 regular weeks, transfer bye after week 1 — three closes
  // walk regular → transfer_window → regular → season_end
  const season = await q(`INSERT INTO seasons (number, matchweek_count, transfer_week) VALUES (1, 2, 1) RETURNING id`);
  seasonId = season.rows[0].id as string;
  await q(`UPDATE seasons SET phase = 'auction' WHERE id = $1`, [seasonId]);
  await q(`UPDATE seasons SET phase = 'regular' WHERE id = $1`, [seasonId]);

  ({ clubId: clubA, playerIds: playersA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@tr.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub(pool, seasonId, 'Beta', 'beta@tr.io'));
  // age-arc cast: a 19-year-old and a 34-year-old squad member (bench), and
  // one FROZEN POOL player who must come out of the season byte-identical
  youngId = await addPlayer('Young Prospect', '2007-03-01', clubA);
  oldId = await addPlayer('Old Warhorse', '1992-03-01', clubA);
  poolId = await addPlayer('Frozen Pool Guy', '2004-06-01', null);

  mw1 = await store.insertMatchweek(pool, seasonId, 1, 'regular', new Date(Date.now() - 7_200_000), new Date(Date.now() - 60_000));
  mwBye = await store.insertMatchweek(pool, seasonId, 2, 'transfer', new Date(Date.now() - 60_000), new Date(Date.now() + 86_400_000));
  mwFinal = await store.insertMatchweek(pool, seasonId, 3, 'regular', new Date(Date.now() - 60_000), new Date(Date.now() + 172_800_000));
  await insertFinalFixture(mw1, 'train-week-1');

  core = createCore({ pool });
  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 0.5 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET });
  cookieA = await login('alpha@tr.io');
  cookieB = await login('beta@tr.io');
});

after(async () => {
  await api?.close();
  await orch?.stop();
  await pool?.end();
});

// ── the training dial API ────────────────────────────────────────────────────

test('training API: defaults, set focus+intensity, garbage rejected', async () => {
  const view = (await api.inject({ method: 'GET', url: '/api/training', cookies: { [SESSION_COOKIE]: cookieA } })).json();
  assert.equal(view.focus, 'balanced');
  assert.equal(view.intensity, 0.5);
  assert.deepEqual(view.focuses, ['balanced', 'possession', 'attacking', 'defending', 'physical']);

  const put = (payload: unknown, cookie = cookieA) =>
    api.inject({ method: 'PUT', url: '/api/training', cookies: { [SESSION_COOKIE]: cookie }, payload: payload as Record<string, unknown> });
  assert.equal((await put({ focus: 'possession', intensity: 0.5 })).statusCode, 204);
  assert.equal((await put({ focus: 'possession', intensity: 0.5 }, cookieB)).statusCode, 204);
  assert.equal((await put({ focus: 'shooting-drills', intensity: 0.5 })).statusCode, 400);
  assert.equal((await put({ focus: 'physical', intensity: 1.7 })).statusCode, 400);

  const back = (await api.inject({ method: 'GET', url: '/api/training', cookies: { [SESSION_COOKIE]: cookieA } })).json();
  assert.equal(back.focus, 'possession');
});

// ── week 1: accrual mechanics in the real tick ───────────────────────────────

test('tick accrues into the scratch: focus group only, minutes-gated, facility-scaled, attributes untouched', async () => {
  await q(`UPDATE club_seasons SET training_level = 5 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  const attrsBefore = await attrsOf(playersA[1]);

  assert.equal(await core.runWeekClose(mw1), 'closed');
  assert.equal(await seasonPhase(), 'transfer_window', 'week 1 close opens the window (choreography intact)');

  // focused outfielder who played 90': possession attrs only
  const starter = await progressOf(playersA[1]);
  assert.ok(starter.passing > 0 && starter.vision > 0);
  assert.equal(starter.tackling, undefined, 'unfocused attributes accrue nothing');
  // per-attr = budget/5 × int(0.5)=1 × fac(5)=1.5 × age(26)=1 × minutes(90)=1
  const expected = (LEAGUE_CFG.trainingWeeklyBudget / 5) * trainingGrowthMul(5);
  assert.ok(Math.abs(starter.passing - expected) < 1e-6, `starter accrual ${starter.passing} ≈ ${expected}`);

  // keeper trains the craft regardless of club focus
  const gk = await progressOf(playersA[0]);
  assert.ok(gk.gkReflexes > 0);
  assert.equal(gk.passing, undefined);

  // benchwarmer (no minutes) develops at the floor share
  const bench = await progressOf(playersA[11]);
  assert.ok(Math.abs(bench.passing - expected * minutesMul(0)) < 1e-6, 'minutes floor');

  // facility scaling: Beta (level 0), same focus/minutes/age
  const betaStarter = await progressOf(playersB[1]);
  assert.ok(Math.abs(starter.passing / betaStarter.passing - trainingGrowthMul(5)) < 1e-6, 'facility multiplier');

  // live attributes NEVER move mid-season
  assert.deepEqual(await attrsOf(playersA[1]), attrsBefore);
});

// ── the bye week: intensity trades development against recovery ──────────────

test('intensity trade-off in one tick: grinders develop more and recover less, resters the reverse', async () => {
  const put = (cookie: string, intensity: number) =>
    api.inject({ method: 'PUT', url: '/api/training', cookies: { [SESSION_COOKIE]: cookie }, payload: { focus: 'possession', intensity } });
  assert.equal((await put(cookieA, 1.0)).statusCode, 204, 'dial adjustable during the window');
  assert.equal((await put(cookieB, 0.0)).statusCode, 204);
  await q(`UPDATE squad_players SET fatigue = 0.5 WHERE season_id = $1`, [seasonId]);
  const beforeA = (await progressOf(playersA[1])).passing;
  const beforeB = (await progressOf(playersB[1])).passing;

  await q(`UPDATE matchweeks SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [mwBye]);
  assert.equal(await core.runWeekClose(mwBye), 'closed');
  assert.equal(await seasonPhase(), 'regular');

  // development: Alpha (intensity 1) accrued, Beta (full rest) accrued NOTHING
  const afterA = (await progressOf(playersA[1])).passing;
  const afterB = (await progressOf(playersB[1])).passing;
  assert.ok(afterA > beforeA, 'grinding through the bye develops');
  assert.equal(afterB, beforeB, 'full rest develops nothing');

  // recovery: base 0.4 → Alpha ×0.75 (0.5→0.35), Beta ×1.25 (0.5→0.25)
  const fatA = Number((await q(`SELECT fatigue FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[1]])).rows[0].fatigue);
  const fatB = Number((await q(`SELECT fatigue FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playersB[1]])).rows[0].fatigue);
  assert.ok(Math.abs(fatA - 0.35) < 1e-6, `grinder keeps fatigue (${fatA})`);
  assert.ok(Math.abs(fatB - 0.25) < 1e-6, `rester sheds it (${fatB})`);
});

// ── the final week: season_end + growth, the whole arc ───────────────────────

test('last regular week closes the season: growth + age curve applied, audited, pool frozen, idempotent', async () => {
  const youngBefore = await attrsOf(youngId);
  const oldBefore = await attrsOf(oldId);
  const poolBefore = await attrsOf(poolId);
  const peakBefore = await attrsOf(playersA[1]);

  await insertFinalFixture(mwFinal, 'train-final');
  await q(`UPDATE matchweeks SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [mwFinal]);
  assert.equal(await core.runWeekClose(mwFinal), 'closed');
  // season_end and complete flash by in one transaction since the rollover
  // PR — season 1 ends complete and season 2 opens in the auction phase
  assert.equal(await seasonPhase(), 'complete', '2 regular weeks revealed = matchweek_count → season over');
  const next = await q(`SELECT phase FROM seasons WHERE number = 2`);
  assert.equal(next.rows[0]?.phase, 'auction', 'the rollover opened season 2');

  // the age arc: young net-grow, peak drift up slightly, old net-decline
  const youngAfter = await attrsOf(youngId);
  assert.ok(youngAfter.passing > youngBefore.passing, 'young grow');
  const oldAfter = await attrsOf(oldId);
  const rawDecline = ageDecline(34);
  assert.ok(Math.abs(oldAfter.pace - (oldBefore.pace - rawDecline)) < 0.05, 'old physical declines at full weight');
  assert.ok(oldBefore.decisions - oldAfter.decisions < 0.15, 'mental barely declines');
  assert.ok(oldAfter.pace < oldBefore.pace && oldAfter.decisions <= oldBefore.decisions);
  const peakAfter = await attrsOf(playersA[1]);
  assert.ok(peakAfter.passing > peakBefore.passing, 'accumulated focused training lands at season end');
  assert.ok(peakAfter.pace === peakBefore.pace, 'nothing declines at 26, unfocused attrs untouched');

  // audit: before/after inspectable for every changed player
  const audits = await q(`SELECT count(*) FROM attribute_audit WHERE season_id = $1 AND reason = 'season_growth'`, [seasonId]);
  assert.ok(Number(audits.rows[0].count) >= 26, `audit rows for the contracted league (${audits.rows[0].count})`);
  const oldAudit = await q(
    `SELECT before, after FROM attribute_audit WHERE season_id = $1 AND player_id = $2 AND reason = 'season_growth'`,
    [seasonId, oldId],
  );
  assert.equal(oldAudit.rowCount, 1);
  assert.equal(oldAudit.rows[0].before.pace, oldBefore.pace);
  assert.equal(oldAudit.rows[0].after.pace, oldAfter.pace);

  // frozen pool: no growth, no aging, no audit
  assert.deepEqual(await attrsOf(poolId), poolBefore, 'pool players never age or grow');
  const poolAudit = await q(`SELECT count(*) FROM attribute_audit WHERE player_id = $1`, [poolId]);
  assert.equal(Number(poolAudit.rows[0].count), 0);

  // idempotency: a second pass (retried week close / crashed job) applies nothing
  const snapshot = await attrsOf(playersA[1]);
  assert.equal(await applySeasonEndGrowth(pool, seasonId), 0, 'audit PK short-circuits every player');
  assert.deepEqual(await attrsOf(playersA[1]), snapshot);
  assert.equal(await core.runWeekClose(mwFinal), 'skipped:revealed');
});

// ── the dial closes with the season ──────────────────────────────────────────

test('training dial rejects once the season ends', async () => {
  const res = await api.inject({
    method: 'PUT', url: '/api/training', cookies: { [SESSION_COOKIE]: cookieA },
    payload: { focus: 'balanced', intensity: 0.5 },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'training_closed');
});
