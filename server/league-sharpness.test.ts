/**
 * league-sharpness.test.ts — the match-fitness half of the condition/
 * sharpness split on the real tick paths: accrual from minutes, bench decay,
 * faster treatment-room decay, cold starts (default + transfer clamp),
 * facility independence, and the re-injury-vs-sharpness distinctness.
 *
 *   npm run db:test:up && node --test league-sharpness.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { HalfResult, HalfStats, MatchEvent } from '@fm/engine/types';
import { LEAGUE_CFG } from '@fm/engine/config';
import { createCore, type OrchestratorCore } from './league-orchestrator.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, seedClub, seedSeason } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let core: OrchestratorCore;
let seasonId: string;
let clubA: string, clubB: string;
let playersA: string[], playersB: string[];

const q = (text: string, params?: unknown[]) => pool.query(text, params);

const sharpnessOf = async (playerId: string): Promise<number> =>
  Number((await q(`SELECT sharpness FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playerId])).rows[0].sharpness);

/** stub final fixture: given (player → minutes) map plays; others absent. */
async function stubWeek(minutes: Map<string, number>): Promise<string> {
  const mw = await q(
    `INSERT INTO matchweeks (season_id, number, opens_at, deadline_at)
     VALUES ($1, (SELECT COALESCE(MAX(number),0)+1 FROM matchweeks WHERE season_id = $1),
             now() - interval '2 hours', now() - interval '1 minute') RETURNING id`,
    [seasonId],
  );
  const fx = await q(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed, state) VALUES ($1, $2, $3, $4, 'final') RETURNING id`,
    [mw.rows[0].id, clubA, clubB, `sharp-${mw.rows[0].id}`],
  );
  const playerState = Object.fromEntries([...minutes].map(([id, m]) => [
    id,
    { fatigue: 0.4, cards: { yellows: 0 as const, sentOff: false }, injured: false, minutesPlayed: m },
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
  await store.insertHalfResult(pool, fx.rows[0].id, 1, mk([{ t: 0, type: 'kickoff' }]));
  await store.insertHalfResult(pool, fx.rows[0].id, 2, mk([{ t: 5400, type: 'halfEnd' }]));
  return mw.rows[0].id as string;
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool); // phase 'regular'
  ({ clubId: clubA, playerIds: playersA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@sh.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub(pool, seasonId, 'Beta', 'beta@sh.io'));
  core = createCore({ pool });
});

after(async () => {
  await pool?.end();
});

test('cold start: every newly-inserted squad row arrives match-rusty (schema default)', async () => {
  assert.equal(await sharpnessOf(playersA[0]), LEAGUE_CFG.sharpnessColdStart);
  // and the engine input carries it
  const squad = await store.loadSquad(pool, clubA, seasonId);
  assert.equal(squad[0].sharpness, LEAGUE_CFG.sharpnessColdStart);
});

test('tick: minutes build sharpness pro-rata, the bench decays, the treatment room decays faster', async () => {
  await q(`UPDATE squad_players SET sharpness = 0.4 WHERE season_id = $1`, [seasonId]);
  await q(`UPDATE squad_players SET sharpness = 1.0 WHERE season_id = $1 AND player_id = ANY($2)`,
    [seasonId, [playersA[11], playersA[12], playersB[11]]]); // the bench trio
  await q(`UPDATE squad_players SET injury_weeks_left = 3 WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playersB[11]]); // injured benchwarmer

  // full match for both XIs, except A10 plays a 45' cameo
  const minutes = new Map<string, number>();
  for (const id of [...playersA.slice(0, 10), ...playersB.slice(0, 11)]) minutes.set(id, 90);
  minutes.set(playersA[10], 45);
  const mwId = await stubWeek(minutes);
  assert.equal(await core.runWeekClose(mwId), 'closed');

  const gain = LEAGUE_CFG.sharpnessGainPerMatch;
  assert.ok(Math.abs((await sharpnessOf(playersA[0])) - (0.4 + gain)) < 1e-6, 'full match: full gain');
  assert.ok(Math.abs((await sharpnessOf(playersA[10])) - (0.4 + gain * 0.5)) < 1e-6, 'cameo: pro-rata');
  assert.ok(
    Math.abs((await sharpnessOf(playersA[11])) - (1.0 - LEAGUE_CFG.sharpnessDecayPerWeek)) < 1e-6,
    'benched but fit: light decay',
  );
  assert.ok(
    Math.abs((await sharpnessOf(playersB[11])) - (1.0 - LEAGUE_CFG.sharpnessInjuredDecayPerWeek)) < 1e-6,
    'injured: faster decay — returnees come back LOW',
  );
});

test('accrual caps at 1, decay floors at the config floor', async () => {
  await q(`UPDATE squad_players SET sharpness = 0.95 WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[0]]);
  await q(`UPDATE squad_players SET sharpness = 0.27 WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[12]]);
  const minutes = new Map<string, number>();
  for (const id of [...playersA.slice(0, 11), ...playersB.slice(0, 11)]) minutes.set(id, 90);
  const mwId = await stubWeek(minutes);
  assert.equal(await core.runWeekClose(mwId), 'closed');
  assert.equal(await sharpnessOf(playersA[0]), 1, 'cap');
  assert.equal(await sharpnessOf(playersA[12]), LEAGUE_CFG.sharpnessFloor, 'floor');
});

test('facilities never touch sharpness: identical decay at training/medical 5 vs 0', async () => {
  await q(`UPDATE club_seasons SET training_level = 5, medical_level = 5 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  await q(`UPDATE squad_players SET sharpness = 0.8 WHERE season_id = $1 AND player_id = ANY($2)`,
    [seasonId, [playersA[12], playersB[12]]]);
  const minutes = new Map<string, number>();
  for (const id of [...playersA.slice(0, 11), ...playersB.slice(0, 11)]) minutes.set(id, 90);
  const mwId = await stubWeek(minutes);
  assert.equal(await core.runWeekClose(mwId), 'closed');
  assert.equal(await sharpnessOf(playersA[12]), await sharpnessOf(playersB[12]),
    'maxed facilities decay exactly like none — play-rhythm, not health/development');
  await q(`UPDATE club_seasons SET training_level = 0, medical_level = 0 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
});

test('re-injury risk and sharpness stay DISTINCT: just_returned flips on playing, rust rebuilds gradually', async () => {
  // a returnee: injury just healed → just_returned TRUE, sharpness eroded
  await q(`UPDATE squad_players SET injury_weeks_left = 1, sharpness = 0.5, just_returned = FALSE
           WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[9]]);
  const noMinutes = new Map<string, number>([[playersA[0], 90], [playersB[0], 90]]);
  let mwId = await stubWeek(noMinutes);
  assert.equal(await core.runWeekClose(mwId), 'closed');
  let row = (await q(`SELECT just_returned, sharpness, injury_weeks_left FROM squad_players WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playersA[9]])).rows[0];
  assert.equal(row.injury_weeks_left, 0);
  assert.equal(row.just_returned, true, 'the re-injury flag raised by healing');
  // decrementInjuries precedes the sharpness pass in the tick, so the week a
  // player HEALS decays at the fit rate (he trained once cleared) — earlier
  // injured weeks took the faster rate (covered above)
  assert.ok(Math.abs(Number(row.sharpness) - (0.5 - LEAGUE_CFG.sharpnessDecayPerWeek)) < 1e-6, 'rust decayed separately');

  // he plays: bookkeeping consumes just_returned; the tick rebuilds sharpness PARTIALLY
  const back = new Map<string, number>([[playersA[9], 90], [playersB[0], 90]]);
  mwId = await stubWeek(back);
  const fixtureId = (await q(`SELECT id FROM fixtures WHERE matchweek_id = $1`, [mwId])).rows[0].id;
  assert.equal(await core.applyBookkeeping(fixtureId), 'applied');
  assert.equal(await core.runWeekClose(mwId), 'closed');
  row = (await q(`SELECT just_returned, sharpness FROM squad_players WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playersA[9]])).rows[0];
  assert.equal(row.just_returned, false, 'one match consumes the re-injury modifier entirely');
  assert.ok(Number(row.sharpness) < 0.9, 'while match fitness is still rebuilding — two costs, two numbers');
  assert.ok(Number(row.sharpness) > 0.5, 'but rebuilding it is');
});

test('transfer clamps sharpness to the cold start (never boosts an already-rusty mover)', async () => {
  await q(`UPDATE squad_players SET sharpness = 0.9 WHERE season_id = $1 AND player_id = $2`, [seasonId, playersB[5]]);
  await store.transferPlayer(pool, seasonId, playersB[5], clubA, clubB, 1000, LEAGUE_CFG.sharpnessColdStart);
  assert.equal(await sharpnessOf(playersB[5]), LEAGUE_CFG.sharpnessColdStart, 'sharp mover arrives cold');

  await q(`UPDATE squad_players SET sharpness = 0.2 WHERE season_id = $1 AND player_id = $2`, [seasonId, playersB[6]]);
  await store.transferPlayer(pool, seasonId, playersB[6], clubA, clubB, 1000, LEAGUE_CFG.sharpnessColdStart);
  assert.ok(Math.abs((await sharpnessOf(playersB[6])) - 0.2) < 1e-6, 'rustier mover is not boosted (LEAST)');
});
