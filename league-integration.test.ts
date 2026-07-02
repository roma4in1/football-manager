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
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  AssertionFailure,
  createCore,
  createOrchestrator,
  injuryWeeks,
  isAssertionFailure,
  type Orchestrator,
  type OrchestratorCore,
} from './league-orchestrator.ts';
import type {
  Attributes, HalfResult, HalfStats, MatchEvent, Phase, SimEngine, Tactics, Vec2,
} from './engine-types.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let orch: Orchestrator;
const assertions: Error[] = [];

// ── seeded league state (filled in before()) ─────────────────────────────────

let seasonId: string;
let clubA: string;
let clubB: string;
let playersA: string[] = []; // 11 uuids, formation order (0 = GK, 10 = ST)
let playersB: string[] = [];

const q = (text: string, params?: unknown[]) => pool.query(text, params);

async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 25_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

// ── synthetic squad + tactics (deterministic, no rng — realism lives in the harness) ──

const ATTR_KEYS: Array<keyof Attributes> = [
  'passing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing', 'tackling', 'marking',
  'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility', 'decisions',
  'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'aggression',
  'gkReflexes', 'gkPositioning', 'gkDistribution',
];

const FORMATION: Array<{ def: Vec2; att: Vec2 }> = [
  { def: { x: 6, y: 34 }, att: { x: 13, y: 34 } },
  { def: { x: 16, y: 25 }, att: { x: 40, y: 25 } },
  { def: { x: 16, y: 43 }, att: { x: 40, y: 43 } },
  { def: { x: 19, y: 9 }, att: { x: 58, y: 8 } },
  { def: { x: 19, y: 59 }, att: { x: 58, y: 60 } },
  { def: { x: 30, y: 34 }, att: { x: 55, y: 34 } },
  { def: { x: 34, y: 20 }, att: { x: 66, y: 20 } },
  { def: { x: 34, y: 48 }, att: { x: 66, y: 48 } },
  { def: { x: 44, y: 10 }, att: { x: 86, y: 11 } },
  { def: { x: 44, y: 58 }, att: { x: 86, y: 57 } },
  { def: { x: 46, y: 34 }, att: { x: 93, y: 34 } },
];

const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05, buildUp: 0.3, counterPress: 0.55,
  progression: 0.6, counterAttack: 0.85, finalThird: 1.0,
};

function flatAttributes(isGk: boolean): Attributes {
  const attrs = {} as Attributes;
  for (const k of ATTR_KEYS) {
    attrs[k] = k.startsWith('gk') ? (isGk ? 16 : 4) : isGk ? 10 : 12;
  }
  return attrs;
}

function tacticsFor(playerIds: string[]): Tactics {
  return {
    players: playerIds.map((playerId, i) => {
      const slot = FORMATION[i];
      const anchors = {} as Record<Phase, Vec2>;
      for (const [phase, t] of Object.entries(PHASE_BLEND) as Array<[Phase, number]>) {
        anchors[phase] = { x: slot.def.x + (slot.att.x - slot.def.x) * t, y: slot.def.y + (slot.att.y - slot.def.y) * t };
      }
      return {
        playerId,
        anchors,
        instructions: {
          riskAppetite: 0.5, shootingBias: i === 10 ? 0.7 : 0.4, dribbleBias: 0.4,
          pressingIntensity: 0.5, holdPosition: i === 0 ? 0.95 : 0.5, crossBias: 0.4,
        },
        zones: {},
      };
    }),
    team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
    bench: [],
    setPieceTakers: { corners: playerIds[8], freeKicks: playerIds[5], penalties: playerIds[10] },
  };
}

async function seedClub(name: string, managerEmail: string): Promise<{ clubId: string; playerIds: string[] }> {
  const manager = await q(`INSERT INTO managers (email, display_name) VALUES ($1, $2) RETURNING id`, [managerEmail, name]);
  const club = await q(`INSERT INTO clubs (manager_id, name) VALUES ($1, $2) RETURNING id`, [manager.rows[0].id, name]);
  const clubId = club.rows[0].id as string;
  await q(
    `INSERT INTO club_seasons (club_id, season_id, transfer_budget, wage_cap) VALUES ($1, $2, 100000, 10000)`,
    [clubId, seasonId],
  );
  const playerIds: string[] = [];
  for (let i = 0; i < 11; i++) {
    const p = await q(
      `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, market_value, attributes, physical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [`${name} Player ${i}`, '2000-01-15', i === 0 ? 'GK' : 'MF', i === 0 ? 190 : 180, 78, 1_000_000,
        JSON.stringify(flatAttributes(i === 0)), JSON.stringify({ injuryProneness: 10 })],
    );
    const playerId = p.rows[0].id as string;
    playerIds.push(playerId);
    await q(
      `INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`,
      [playerId, clubId, seasonId],
    );
    await q(
      `INSERT INTO squad_players (club_id, season_id, player_id, fatigue) VALUES ($1, $2, $3, 0.1)`,
      [clubId, seasonId, playerId],
    );
  }
  await q(`INSERT INTO default_tactics (club_id, payload) VALUES ($1, $2)`, [clubId, JSON.stringify(tacticsFor(playerIds))]);
  return { clubId, playerIds };
}

async function mkMatchweek(number: number, opensAt: Date, deadlineAt: Date): Promise<string> {
  const r = await q(
    `INSERT INTO matchweeks (season_id, number, opens_at, deadline_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [seasonId, number, opensAt, deadlineAt],
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

async function submitTactics(fixtureId: string, clubId: string, half: 1 | 2): Promise<void> {
  const ids = clubId === clubA ? playersA : playersB;
  await q(
    `INSERT INTO tactics_submissions (fixture_id, club_id, half, payload) VALUES ($1, $2, $3, $4)`,
    [fixtureId, clubId, half, JSON.stringify(tacticsFor(ids))],
  );
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
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(`cannot reach test database at ${DATABASE_URL} — run \`npm run db:test:up\` first`, { cause: err });
  }
  await pool.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public`);
  await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

  const season = await q(
    `INSERT INTO seasons (number, matchweek_count, transfer_week) VALUES (1, 10, 5) RETURNING id`,
  );
  seasonId = season.rows[0].id;
  await q(`UPDATE seasons SET phase = 'auction' WHERE id = $1`, [seasonId]);
  await q(`UPDATE seasons SET phase = 'regular' WHERE id = $1`, [seasonId]);

  ({ clubId: clubA, playerIds: playersA } = await seedClub('Alpha', 'alpha@test.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub('Beta', 'beta@test.io'));

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
  assert.equal(await orch.notifyTacticsSubmitted(f, 1), 'waiting');
  await submitTactics(f, clubB, 1);
  assert.equal(await orch.notifyTacticsSubmitted(f, 1), 'enqueued');

  await waitFor(async () => (await fixtureState(f)).state === 'awaiting_ht', 'half 1 sim via queue');
  const { ht } = await fixtureState(f);
  assert.ok(ht && Math.abs(hoursFromNow(ht) - 12) < 0.2, `fresh submission → ~12h HT window, got ${ht}`);

  const h1 = await q(`SELECT 1 FROM half_results WHERE fixture_id = $1 AND half = 1`, [f]);
  const fr = await q(`SELECT 1 FROM replay_frames WHERE fixture_id = $1 AND half = 1`, [f]);
  assert.equal(h1.rowCount, 1);
  assert.equal(fr.rowCount, 1);

  await submitTactics(f, clubA, 2);
  assert.equal(await orch.notifyTacticsSubmitted(f, 2), 'waiting');
  await submitTactics(f, clubB, 2);
  assert.equal(await orch.notifyTacticsSubmitted(f, 2), 'enqueued');

  await waitFor(async () => (await fixtureState(f)).state === 'final', 'half 2 sim via queue');
  const h2 = await q(`SELECT end_state FROM half_results WHERE fixture_id = $1 AND half = 2`, [f]);
  assert.equal(h2.rowCount, 1);
  const minutes = Object.values(h2.rows[0].end_state.playerState as Record<string, { minutesPlayed: number }>);
  assert.ok(minutes.every((p) => p.minutesPlayed === 90));

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

  const wages = await q(
    `SELECT club_id, amount FROM transactions WHERE kind = 'wage_payment' AND memo = $1 ORDER BY club_id`,
    [`fixture:${f4}`],
  );
  assert.equal(wages.rowCount, 2, 'one wage txn per club');
  assert.ok(wages.rows.every((r) => Number(r.amount) === 1100), '11 contracts × wage 100');

  const sp = await q(
    `SELECT fatigue, season_minutes FROM squad_players WHERE season_id = $1`, [seasonId],
  );
  assert.equal(sp.rowCount, 22);
  assert.ok(sp.rows.every((r) => r.season_minutes === 90), 'exactly one bookkept match so far');
  assert.ok(sp.rows.every((r) => r.fatigue > 0.1), 'fatigue advanced from the 0.1 baseline');

  const fam = await q(`SELECT count(*) FROM familiarity WHERE season_id = $1`, [seasonId]);
  assert.equal(Number(fam.rows[0].count), 110, '55 dyads per club');
});

// ── 5. idempotency: every job no-ops on re-run ───────────────────────────────

test('idempotent re-runs: sim jobs, bookkeeping, week-close all no-op', async () => {
  const snapshot = async () => ({
    results: (await q(`SELECT count(*) FROM half_results WHERE fixture_id = $1`, [f4])).rows[0].count,
    wages: (await q(`SELECT count(*) FROM transactions WHERE memo = $1`, [`fixture:${f4}`])).rows[0].count,
    minutes: (await q(`SELECT sum(season_minutes) FROM squad_players WHERE season_id = $1`, [seasonId])).rows[0].sum,
    fam: (await q(`SELECT sum(value) FROM familiarity WHERE season_id = $1`, [seasonId])).rows[0].sum,
    revealed: (await q(`SELECT revealed_at FROM matchweeks WHERE id = $1`, [mw4])).rows[0].revealed_at,
  });

  const beforeSnap = await snapshot();
  assert.equal((await orch.runSimHalf1(f4)).status, 'skipped:state');
  assert.equal((await orch.runSimHalf2(f4)).status, 'skipped:state');
  assert.equal(await orch.applyBookkeeping(f4), 'skipped:done');
  assert.equal(await orch.runWeekClose(mw4), 'skipped:revealed');
  assert.deepEqual(await snapshot(), beforeSnap, 'no writes on re-run');
});

// ── 6. bookkeeping detail via stub engine ────────────────────────────────────

test('bookkeeping: injuries, red cards, just_returned, familiarity increments', async () => {
  const injuredPlayer = playersA[3];
  const redPlayer = playersB[4];
  const returnedPlayer = playersA[7];

  const stubEngine: SimEngine = {
    simulateHalf(fixture, squads) {
      const ids = [...squads.home, ...squads.away].map((p) => p.playerId);
      const half = fixture.half;
      const playerState = Object.fromEntries(ids.map((id) => [
        id, { fatigue: half === 1 ? 0.3 : 0.55, cards: 0 as const, injured: id === injuredPlayer && half === 2, minutesPlayed: half === 1 ? 45 : 90 },
      ]));
      const events: MatchEvent[] = half === 2
        ? [
            { t: 3000, type: 'injury', playerId: injuredPlayer, outcome: 'fail' },
            { t: 3100, type: 'card', playerId: redPlayer, meta: { card: 'red' } },
            { t: 3200, type: 'goal', playerId: squads.home[10].playerId, outcome: 'success' },
          ]
        : [{ t: 0, type: 'kickoff' }];
      const zero: [number, number] = [0, 0];
      const stats: HalfStats = {
        possession: [50, 50], shots: zero, shotsOnTarget: zero, xg: zero, passAccuracy: [80, 80],
        aerialsWon: zero, ppda: [12, 12], fieldTilt: [50, 50], playerRatings: {}, heatmaps: {},
      };
      const result: HalfResult = {
        events, frames: [], stats,
        endState: {
          score: half === 1 ? [0, 0] : [1, 0],
          playerState, subsUsed: [0, 0], rngState: '0'.repeat(32),
        },
      };
      return result;
    },
  };
  const stub: OrchestratorCore = createCore({ pool, engine: stubEngine });

  await q(`UPDATE squad_players SET just_returned = TRUE WHERE player_id = $1`, [returnedPlayer]);
  const beforeMinutes = Number(
    (await q(`SELECT season_minutes FROM squad_players WHERE player_id = $1`, [injuredPlayer])).rows[0].season_minutes,
  );

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

  const red = await q(`SELECT suspended_next FROM squad_players WHERE player_id = $1`, [redPlayer]);
  assert.equal(red.rows[0].suspended_next, true);

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
  assert.ok(fam.rows[0].lo > 0.09 && fam.rows[0].hi < 0.11, `two matches → ~0.10, got [${fam.rows[0].lo}, ${fam.rows[0].hi}]`);

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

test('missing default_tactics at force time is an assertion failure', async () => {
  await q(`DELETE FROM default_tactics WHERE club_id = $1`, [clubB]);
  const mw = await mkMatchweek(7, past(2), past(1));
  const f = await mkFixture(mw, 'itest-7');
  await assert.rejects(orch.runSimHalf1(f), (err: unknown) => err instanceof AssertionFailure);
  assert.equal((await fixtureState(f)).state, 'scheduled', 'failed force leaves fixture untouched');
  await q(`INSERT INTO default_tactics (club_id, payload) VALUES ($1, $2)`, [clubB, JSON.stringify(tacticsFor(playersB))]);
});
