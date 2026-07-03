/**
 * league-integration.test.ts — end-to-end orchestration tests against real
 * Postgres + pg-boss.
 *
 * Requires a database (throwaway docker container):
 *   npm run db:test:up      # postgres:16-alpine on :54329
 *   npm run test:integration
 * Override with DATABASE_URL. The test DROPs and rebuilds schema `public` and
 * `pgboss` in that database — never point it at real data.
 *
 * Scenarios (spec: matchweek orchestration layer):
 *   1. both clubs submit early     → queue path, 12h HT window
 *   2. one club defaults           → is_default row, still 12h (one fresh)
 *      both clubs default          → 2h HT window
 *   3. HT timeout                  → half-1 tactics carried forward
 *   4. week-close force-complete   → sim + bookkeeping + reveal (queue path)
 *   5. idempotent re-run           → every job no-ops on second run
 *   6. bookkeeping detail          → stub engine: injuries, red cards,
 *                                    just_returned, familiarity, wages
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  createCore,
  createOrchestrator,
  injuryWeeks,
  isAssertionFailure,
  type Orchestrator,
  type OrchestratorCore,
} from './league-orchestrator.ts';
import { bootstrapSchema, buildTactics as tacticsFor, seedClub, seedSeason, waitFor } from './league-test-helpers.ts';
import type { HalfResult, HalfStats, MatchEvent, SimEngine, Tactics } from '@fm/engine/types';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let orch: Orchestrator;
const assertions: Error[] = [];

// ── seeded league state (filled in before()) ─────────────────────────────────

let seasonId: string;
let clubA: string;
let clubB: string;
let playersA: string[] = []; // 13 uuids: 0 = GK, 1–10 outfield lineup, 11–12 reserves
let playersB: string[] = [];

const q = (text: string, params?: unknown[]) => pool.query(text, params);

async function mkMatchweek(
  number: number, opensAt: Date, deadlineAt: Date, kind: 'regular' | 'transfer' = 'regular',
): Promise<string> {
  const r = await q(
    `INSERT INTO matchweeks (season_id, number, kind, opens_at, deadline_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [seasonId, number, kind, opensAt, deadlineAt],
  );
  return r.rows[0].id;
}

async function mkFixture(matchweekId: string, seed: string): Promise<string> {
  const r = await q(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed) VALUES ($1, $2, $3, $4) RETURNING id`,
    [matchweekId, clubA, clubB, seed],
  );
  return r.rows[0].id;
}

async function submitPayload(fixtureId: string, clubId: string, half: 1 | 2, payload: Tactics): Promise<void> {
  await q(
    `INSERT INTO tactics_submissions (fixture_id, club_id, half, payload) VALUES ($1, $2, $3, $4)`,
    [fixtureId, clubId, half, JSON.stringify(payload)],
  );
}

async function submitTactics(fixtureId: string, clubId: string, half: 1 | 2): Promise<void> {
  await submitPayload(fixtureId, clubId, half, tacticsFor(clubId === clubA ? playersA : playersB));
}

const fixtureState = async (id: string): Promise<{ state: string; ht: Date | null }> => {
  const r = await q(`SELECT state, ht_deadline AS ht FROM fixtures WHERE id = $1`, [id]);
  return r.rows[0];
};

const hoursFromNow = (d: Date): number => (d.getTime() - Date.now()) / 3_600_000;
const past = (h: number): Date => new Date(Date.now() - h * 3_600_000);
const future = (h: number): Date => new Date(Date.now() + h * 3_600_000);

// ── bootstrap ────────────────────────────────────────────────────────────────

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool);

  ({ clubId: clubA, playerIds: playersA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@test.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub(pool, seasonId, 'Beta', 'beta@test.io'));

  orch = await createOrchestrator({
    pool,
    connectionString: DATABASE_URL,
    pollingIntervalSeconds: 0.5,
    onAssertion: (err) => assertions.push(err),
  });
});

after(async () => {
  await orch?.stop();
  await pool?.end();
});

// ── 1. both clubs submit early (real queue path) ─────────────────────────────

test('both submit early: queue sims half 1, 12h HT window, then half 2', async () => {
  const mw = await mkMatchweek(1, past(1), future(24));
  const f = await mkFixture(mw, 'itest-1');

  await submitTactics(f, clubA, 1);
  assert.equal(await orch.notifyTacticsSubmitted(f, clubA, 1), 'waiting');
  await submitTactics(f, clubB, 1);
  assert.equal(await orch.notifyTacticsSubmitted(f, clubB, 1), 'enqueued');

  await waitFor(async () => (await fixtureState(f)).state === 'awaiting_ht', 'half 1 sim via queue');
  const { ht } = await fixtureState(f);
  assert.ok(ht && Math.abs(hoursFromNow(ht) - 12) < 0.2, `fresh submission → ~12h HT window, got ${ht}`);

  const h1 = await q(`SELECT 1 FROM half_results WHERE fixture_id = $1 AND half = 1`, [f]);
  const fr = await q(`SELECT 1 FROM replay_frames WHERE fixture_id = $1 AND half = 1`, [f]);
  assert.equal(h1.rowCount, 1);
  assert.equal(fr.rowCount, 1);

  await submitTactics(f, clubA, 2);
  assert.equal(await orch.notifyTacticsSubmitted(f, clubA, 2), 'waiting');
  await submitTactics(f, clubB, 2);
  assert.equal(await orch.notifyTacticsSubmitted(f, clubB, 2), 'enqueued');

  await waitFor(async () => (await fixtureState(f)).state === 'final', 'half 2 sim via queue');
  const h2 = await q(`SELECT end_state FROM half_results WHERE fixture_id = $1 AND half = 2`, [f]);
  assert.equal(h2.rowCount, 1);
  assert.equal(h2.rows[0].end_state.v, 2, 'end_state is versioned');
  const players = Object.values(
    h2.rows[0].end_state.playerState as Record<string, { minutesPlayed: number; cards: { sentOff: boolean } }>,
  );
  assert.ok(players.every((p) => p.minutesPlayed === 90 || (p.cards.sentOff && p.minutesPlayed === 45)));

  // week-close before deadline must not touch it
  assert.equal(await orch.runWeekClose(mw), 'skipped:early');
});

// ── 2. defaults at deadline ───────────────────────────────────────────────────

let f2: string; // carried into scenario 3

test('one club defaults: is_default row inserted, 12h window (one fresh submission)', async () => {
  const mw = await mkMatchweek(2, past(2), past(1)); // deadline already passed
  f2 = await mkFixture(mw, 'itest-2');
  await submitTactics(f2, clubA, 1); // fresh; B never submits

  const out = await orch.runSimHalf1(f2);
  assert.equal(out.status, 'simmed');
  assert.ok(Math.abs(hoursFromNow(out.htDeadline!) - 12) < 0.2, 'one fresh manager → 12h');

  const sub = await q(
    `SELECT is_default FROM tactics_submissions WHERE fixture_id = $1 AND club_id = $2 AND half = 1`,
    [f2, clubB],
  );
  assert.equal(sub.rows[0].is_default, true);
});

test('both clubs default: 2h HT window', async () => {
  const mw = await mkMatchweek(3, past(2), past(1));
  const f = await mkFixture(mw, 'itest-3');
  const out = await orch.runSimHalf1(f);
  assert.equal(out.status, 'simmed');
  assert.ok(Math.abs(hoursFromNow(out.htDeadline!) - 2) < 0.2, 'both defaulted → 2h');
  const subs = await q(`SELECT count(*) FROM tactics_submissions WHERE fixture_id = $1 AND is_default`, [f]);
  assert.equal(Number(subs.rows[0].count), 2);
});

// ── 3. HT timeout: half-1 tactics carried forward ────────────────────────────

test('HT timeout: no half-2 rows, deadline passes, half-1 payload carries', async () => {
  assert.equal((await orch.runSimHalf2(f2)).status, 'skipped:waiting', 'HT window still open, nobody submitted');

  await q(`UPDATE fixtures SET ht_deadline = now() - interval '1 minute' WHERE id = $1`, [f2]);
  assert.equal((await orch.runSimHalf2(f2)).status, 'simmed');
  assert.equal((await fixtureState(f2)).state, 'final');

  const h2subs = await q(`SELECT count(*) FROM tactics_submissions WHERE fixture_id = $1 AND half = 2`, [f2]);
  assert.equal(Number(h2subs.rows[0].count), 0, 'carry-forward reads half 1, inserts nothing');
});

// ── 4. week-close force-complete (queue path) + bookkeeping ──────────────────

let mw4: string;
let f4: string;

test('week-close: force-completes, bookkeeps, reveals', async () => {
  mw4 = await mkMatchweek(4, past(2), past(1));
  f4 = await mkFixture(mw4, 'itest-4');

  await orch.scheduleWeekClose(mw4); // deadline in the past → fires immediately
  await waitFor(async () => {
    const r = await q(`SELECT revealed_at FROM matchweeks WHERE id = $1`, [mw4]);
    return r.rows[0].revealed_at !== null;
  }, 'week-close via queue');

  assert.equal((await fixtureState(f4)).state, 'final');

  const marker = await q(`SELECT bookkept_at FROM fixtures WHERE id = $1`, [f4]);
  assert.ok(marker.rows[0].bookkept_at !== null, 'bookkept_at set by bookkeeping txn');

  const wages = await q(
    `SELECT club_id, amount FROM transactions WHERE kind = 'wage_payment' AND memo = $1 ORDER BY club_id`,
    [`fixture:${f4}`],
  );
  assert.equal(wages.rowCount, 2, 'one wage txn per club (memo kept for traceability)');
  assert.ok(wages.rows.every((r) => Number(r.amount) === 1300), '13 contracts × wage 100');

  const sp = await q(
    `SELECT fatigue, season_minutes FROM squad_players WHERE season_id = $1`, [seasonId],
  );
  assert.equal(sp.rowCount, 26);
  // fixture ids are random UUIDs and feed the engine seed, so each run rolls a
  // fresh match — send-offs (45') are possible and legitimate
  const played = sp.rows.filter((r) => r.season_minutes > 0);
  assert.equal(played.length, 22, 'both lineups accrued minutes');
  assert.ok(played.every((r) => r.season_minutes === 90 || r.season_minutes === 45), 'minutes are 90, or 45 for a send-off');
  assert.ok(played.filter((r) => r.season_minutes === 90).length >= 20, 'send-offs are rare');
  assert.equal(sp.rows.filter((r) => r.season_minutes === 0).length, 4, 'reserves did not play');
  // between-week tick ran inside week-close: players who played carry real fatigue
  // (recovered once), unused reserves decayed below their 0.1 seed
  assert.ok(sp.rows.filter((r) => r.season_minutes > 0).every((r) => r.fatigue > 0.12));
  assert.ok(sp.rows.filter((r) => r.season_minutes === 0).every((r) => r.fatigue < 0.1));

  const fam = await q(`SELECT count(*) FROM familiarity WHERE season_id = $1`, [seasonId]);
  assert.equal(Number(fam.rows[0].count), 110, '55 dyads per club — lineup players only');
});

// ── 5. idempotency: every job no-ops on re-run ───────────────────────────────

test('idempotent re-runs: sim jobs, bookkeeping, week-close all no-op', async () => {
  const snapshot = async () => ({
    results: (await q(`SELECT count(*) FROM half_results WHERE fixture_id = $1`, [f4])).rows[0].count,
    wages: (await q(`SELECT count(*) FROM transactions WHERE memo = $1`, [`fixture:${f4}`])).rows[0].count,
    minutes: (await q(`SELECT sum(season_minutes) FROM squad_players WHERE season_id = $1`, [seasonId])).rows[0].sum,
    fam: (await q(`SELECT sum(value) FROM familiarity WHERE season_id = $1`, [seasonId])).rows[0].sum,
    revealed: (await q(`SELECT revealed_at FROM matchweeks WHERE id = $1`, [mw4])).rows[0].revealed_at,
    bookkeptAt: (await q(`SELECT bookkept_at FROM fixtures WHERE id = $1`, [f4])).rows[0].bookkept_at,
  });

  const beforeSnap = await snapshot();
  assert.equal((await orch.runSimHalf1(f4)).status, 'skipped:state');
  assert.equal((await orch.runSimHalf2(f4)).status, 'skipped:state');
  assert.equal(await orch.applyBookkeeping(f4), 'skipped:done');
  assert.equal(await orch.runWeekClose(mw4), 'skipped:revealed');
  assert.deepEqual(await snapshot(), beforeSnap, 'no writes on re-run');
});

// ── 6. bookkeeping detail via stub engine ────────────────────────────────────

test('bookkeeping: injuries, red cards, sent-off minutes, just_returned, familiarity', async () => {
  const injuredPlayer = playersA[3];
  const redPlayer = playersB[4]; // sent off in half 1 → zero half-2 minutes
  const returnedPlayer = playersA[7];

  const stubEngine: SimEngine = {
    simulateHalf(fixture, _squads, tactics) {
      const ids = [...tactics.home.players, ...tactics.away.players].map((p) => p.playerId);
      const half = fixture.half;
      const playerState = Object.fromEntries(ids.map((id) => {
        const sentOff = id === redPlayer;
        return [id, {
          fatigue: half === 1 || sentOff ? 0.3 : 0.55, // sent-off: frozen at H1 value
          cards: { yellows: 0 as const, sentOff },
          injured: id === injuredPlayer && half === 2,
          minutesPlayed: half === 1 || sentOff ? 45 : 90, // sent-off: zero half-2 minutes
        }];
      }));
      const events: MatchEvent[] = half === 2
        ? [
            { t: 3000, type: 'injury', playerId: injuredPlayer, outcome: 'fail' },
            { t: 3200, type: 'goal', playerId: playersA[10], outcome: 'success' },
          ]
        : [
            { t: 0, type: 'kickoff' },
            { t: 1800, type: 'card', playerId: redPlayer, meta: { card: 'red' } },
          ];
      const zero: [number, number] = [0, 0];
      const stats: HalfStats = {
        possession: [50, 50], shots: zero, shotsOnTarget: zero, xg: zero, passAccuracy: [80, 80],
        aerialsWon: zero, ppda: [12, 12], fieldTilt: [50, 50], playerRatings: {}, heatmaps: {},
      };
      const result: HalfResult = {
        events, frames: [], stats,
        endState: {
          v: 2,
          score: half === 1 ? [0, 0] : [1, 0],
          playerState, subsUsed: [0, 0], rngState: '0'.repeat(32),
        },
      };
      return result;
    },
  };
  const stub: OrchestratorCore = createCore({ pool, engine: stubEngine });

  // heal whatever the real-engine match in the week-close test inflicted, so both
  // stored defaults are valid again and this fixture reuses the exact t4 lineups
  await q(`UPDATE squad_players SET injury_weeks_left = 0, suspended_next = FALSE, just_returned = FALSE WHERE season_id = $1`, [seasonId]);
  await q(`UPDATE squad_players SET just_returned = TRUE WHERE player_id = $1`, [returnedPlayer]);
  const minutesBefore = async (playerId: string): Promise<number> => Number(
    (await q(`SELECT season_minutes FROM squad_players WHERE player_id = $1`, [playerId])).rows[0].season_minutes,
  );
  const beforeMinutes = await minutesBefore(injuredPlayer);
  const beforeRedMinutes = await minutesBefore(redPlayer);

  const mw = await mkMatchweek(6, past(2), past(1));
  const f = await mkFixture(mw, 'itest-6');
  assert.equal((await stub.runSimHalf1(f)).status, 'simmed');
  assert.equal((await stub.runSimHalf2(f, { force: true })).status, 'simmed');
  assert.equal(await stub.applyBookkeeping(f), 'applied');

  const injured = await q(
    `SELECT injury_weeks_left FROM squad_players WHERE player_id = $1`, [injuredPlayer],
  );
  assert.equal(injured.rows[0].injury_weeks_left, injuryWeeks('itest-6', injuredPlayer), 'deterministic severity draw');
  assert.ok(injured.rows[0].injury_weeks_left >= 1);

  const red = await q(
    `SELECT suspended_next, season_minutes, fatigue FROM squad_players WHERE player_id = $1`, [redPlayer],
  );
  assert.equal(red.rows[0].suspended_next, true);
  assert.equal(red.rows[0].season_minutes, beforeRedMinutes + 45, 'sent off at HT → zero half-2 minutes');
  assert.ok(Math.abs(red.rows[0].fatigue - 0.3) < 1e-6, 'sent-off fatigue frozen at the H1 value');

  const returned = await q(`SELECT just_returned FROM squad_players WHERE player_id = $1`, [returnedPlayer]);
  assert.equal(returned.rows[0].just_returned, false, 'playing consumes the just_returned flag');

  const sp = await q(
    `SELECT fatigue, season_minutes FROM squad_players WHERE player_id = $1`, [injuredPlayer],
  );
  assert.equal(sp.rows[0].season_minutes, beforeMinutes + 90);
  assert.ok(Math.abs(sp.rows[0].fatigue - 0.55) < 1e-6, 'absolute fatigue from end state');

  // familiarity: second bookkept match together → ~0.10 per dyad
  const fam = await q(
    `SELECT min(value) AS lo, max(value) AS hi, count(*) FROM familiarity WHERE club_id = $1 AND season_id = $2`,
    [clubA, seasonId],
  );
  assert.equal(Number(fam.rows[0].count), 55);
  // a send-off in the earlier real-engine match halves that player's co-minutes
  assert.ok(fam.rows[0].lo > 0.045 && fam.rows[0].hi < 0.11, `two matches → ~0.10 (0.075 via send-off), got [${fam.rows[0].lo}, ${fam.rows[0].hi}]`);

  // idempotent re-run of the stub path too
  assert.equal(await stub.applyBookkeeping(f), 'skipped:done');
  const again = await q(`SELECT season_minutes FROM squad_players WHERE player_id = $1`, [injuredPlayer]);
  assert.equal(again.rows[0].season_minutes, beforeMinutes + 90);
});

// ── failure taxonomy ─────────────────────────────────────────────────────────

test('DB trigger violations classify as assertion failures, not retryable', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      client.query(`UPDATE fixtures SET state = 'awaiting_ht' WHERE id = $1`, [f4]), // final → awaiting_ht is illegal
      (err: unknown) => {
        assert.ok(isAssertionFailure(err), `expected P0001 classification, got ${(err as Error).message}`);
        return true;
      },
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('missing default_tactics at force time falls back to a synthesized best XI', async () => {
  await q(`DELETE FROM default_tactics WHERE club_id = $1`, [clubB]);
  const mw = await mkMatchweek(7, past(2), past(1));
  const f = await mkFixture(mw, 'itest-7');
  assert.equal((await orch.runSimHalf1(f)).status, 'simmed', 'the league never blocks on a missing default');

  const sub = await q(
    `SELECT payload, is_default FROM tactics_submissions WHERE fixture_id = $1 AND club_id = $2 AND half = 1`,
    [f, clubB],
  );
  assert.equal(sub.rows[0].is_default, true);
  const ids: string[] = sub.rows[0].payload.players.map((p: { playerId: string }) => p.playerId);
  assert.equal(new Set(ids).size, 11, 'synthesized lineup fields 11 unique players');
  assert.ok(ids.includes(playersB[0]), 'GK drafted');
  assert.ok(!ids.includes(playersB[4]), 'suspended player (red card in the stub match) excluded');

  await q(`INSERT INTO default_tactics (club_id, payload) VALUES ($1, $2)`, [clubB, JSON.stringify(tacticsFor(playersB))]);
});

// ── between-week tick ────────────────────────────────────────────────────────

function mkTickStub(redCardH1: string): SimEngine {
  return {
    simulateHalf(fixture, _squads, tactics) {
      const ids = [...tactics.home.players, ...tactics.away.players].map((p) => p.playerId);
      const half = fixture.half;
      const playerState = Object.fromEntries(ids.map((id) => [
        id, { fatigue: half === 1 ? 0.3 : 0.55, cards: { yellows: 0 as const, sentOff: false }, injured: false, minutesPlayed: half === 1 ? 45 : 90 },
      ]));
      const events: MatchEvent[] = half === 1
        ? [{ t: 0, type: 'kickoff' }, { t: 1800, type: 'card', playerId: redCardH1, meta: { card: 'red' } }]
        : [{ t: 5400, type: 'halfEnd' }];
      const zero: [number, number] = [0, 0];
      const stats: HalfStats = {
        possession: [50, 50], shots: zero, shotsOnTarget: zero, xg: zero, passAccuracy: [80, 80],
        aerialsWon: zero, ppda: [12, 12], fieldTilt: [50, 50], playerRatings: {}, heatmaps: {},
      };
      return {
        events, frames: [], stats,
        endState: { v: 2, score: [0, 0], playerState, subsUsed: [0, 0], rngState: '0'.repeat(32) },
      } satisfies HalfResult;
    },
  };
}

test('tick: injuries heal (just_returned at 0), served suspensions clear, issued ones stay, fatigue recovers', async () => {
  const healed = playersA[8]; // 1 week left → returns
  const stillOut = playersA[9]; // 3 weeks left → 2
  const served = playersB[7]; // suspended FOR this week
  const sentOffNow = playersA[2]; // red card DURING this week
  await q(`UPDATE squad_players SET injury_weeks_left = 1 WHERE player_id = $1`, [healed]);
  await q(`UPDATE squad_players SET injury_weeks_left = 3, just_returned = FALSE WHERE player_id = $1`, [stillOut]);
  await q(`UPDATE squad_players SET suspended_next = TRUE WHERE player_id = $1`, [served]);
  const fatigueBefore = (await q(`SELECT fatigue FROM squad_players WHERE player_id = $1`, [stillOut])).rows[0].fatigue;

  const tickCore: OrchestratorCore = createCore({ pool, engine: mkTickStub(sentOffNow) });
  const mw = await mkMatchweek(8, past(2), past(1));
  await mkFixture(mw, 'itest-8');
  assert.equal(await tickCore.runWeekClose(mw), 'closed');

  const state = async (id: string) =>
    (await q(`SELECT injury_weeks_left, just_returned, suspended_next, fatigue FROM squad_players WHERE player_id = $1`, [id])).rows[0];

  const h = await state(healed);
  assert.equal(h.injury_weeks_left, 0);
  assert.equal(h.just_returned, true, 'decrement reaching 0 raises the re-injury flag');
  const s = await state(stillOut);
  assert.equal(s.injury_weeks_left, 2);
  assert.equal(s.just_returned, false, 'flag only on the week the player returns');

  assert.equal((await state(served)).suspended_next, false, 'suspension served this week is cleared');
  assert.equal((await state(sentOffNow)).suspended_next, true, 'suspension issued this week survives the tick');

  // stillOut did not play (injured → excluded by the auto-lineup): pure recovery, level-0 medical = ×0.6
  assert.ok(Math.abs(s.fatigue - fatigueBefore * 0.6) < 1e-6, `expected ${fatigueBefore} × 0.6, got ${s.fatigue}`);

  // exactly-once: a re-run after reveal must not decrement or recover again
  assert.equal(await tickCore.runWeekClose(mw), 'skipped:revealed');
  assert.equal((await state(stillOut)).injury_weeks_left, 2, 'no double decrement on retry');
});

test('transfer-week tick: recovery runs, one-match bans are NOT consumed by a bye', async () => {
  const suspended = playersA[2]; // still suspended from the previous test
  const injured = playersA[9]; // 2 weeks left
  const fatigueBefore = (await q(`SELECT fatigue FROM squad_players WHERE player_id = $1`, [injured])).rows[0].fatigue;

  const mw = await mkMatchweek(9, past(2), past(1), 'transfer');
  assert.equal(await orch.runWeekClose(mw), 'closed');

  const rows = await q(
    `SELECT player_id, injury_weeks_left, suspended_next, fatigue FROM squad_players WHERE player_id = ANY($1)`,
    [[suspended, injured]],
  );
  const byId = new Map(rows.rows.map((r) => [r.player_id, r]));
  assert.equal(byId.get(suspended)!.suspended_next, true, 'ban carries past the bye to the next played matchweek');
  assert.equal(byId.get(injured)!.injury_weeks_left, 1, 'injuries heal through the transfer week');
  assert.ok(Math.abs(byId.get(injured)!.fatigue - fatigueBefore * 0.6) < 1e-6, 'fatigue recovers through the bye');
  const revealed = await q(`SELECT revealed_at FROM matchweeks WHERE id = $1`, [mw]);
  assert.ok(revealed.rows[0].revealed_at !== null);
});

// ── eligibility ──────────────────────────────────────────────────────────────
// (Rejection of invalid fresh submissions moved to the API layer — validation
// now happens BEFORE insert; see league-api.test.ts. The sim-path fallback
// below is the orchestration-side guarantee.)

test('stale default: an injured starter is excluded by the next auto-lineup', async () => {
  // clean slate, then injure one of club B's default starters
  await q(`UPDATE squad_players SET injury_weeks_left = 0, suspended_next = FALSE, just_returned = FALSE WHERE season_id = $1`, [seasonId]);
  const victim = playersB[5];
  await q(`UPDATE squad_players SET injury_weeks_left = 4 WHERE player_id = $1`, [victim]);

  const mw = await mkMatchweek(11, past(2), past(1));
  const f = await mkFixture(mw, 'itest-11');
  assert.equal((await orch.runSimHalf1(f)).status, 'simmed');

  const subB = await q(
    `SELECT payload, is_default FROM tactics_submissions WHERE fixture_id = $1 AND club_id = $2 AND half = 1`,
    [f, clubB],
  );
  assert.equal(subB.rows[0].is_default, true);
  const idsB: string[] = subB.rows[0].payload.players.map((p: { playerId: string }) => p.playerId);
  assert.equal(new Set(idsB).size, 11);
  assert.ok(!idsB.includes(victim), 'injured starter excluded from the auto-lineup');
  assert.ok(idsB.includes(playersB[0]), 'GK still drafted');

  // club A's stored default is fully valid → used verbatim, not replaced
  const subA = await q(
    `SELECT payload FROM tactics_submissions WHERE fixture_id = $1 AND club_id = $2 AND half = 1`,
    [f, clubA],
  );
  const idsA: string[] = subA.rows[0].payload.players.map((p: { playerId: string }) => p.playerId);
  assert.deepEqual(idsA, playersA.slice(0, 11), 'valid default passes through untouched');
});
