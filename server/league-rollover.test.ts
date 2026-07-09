/**
 * league-rollover.test.ts — the multi-season loop, end to end, TWICE:
 * auction → matchweeks → transfer window → matchweeks → season_end (growth +
 * expiry) → complete → season 2 auction with the correct pool → season 2
 * plays. Every rollover invariant asserted:
 *   - growth carried (a leaver departs at his GROWN state and re-freezes),
 *   - expiries return to the pool, carried contracts don't,
 *   - familiarity carries at the carry factor for both-retained pairs only,
 *   - budgets fresh / facilities + training dial carried,
 *   - the new auction offers exactly (old pool + expiries) and never
 *     re-applies or loses growth on a re-draft.
 *
 *   npm run db:test:up && node --test league-rollover.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { createAuctionCore, type AuctionCore } from './league-auction.ts';
import { createCore, type OrchestratorCore } from './league-orchestrator.ts';
import { setupSeason } from './league-setup.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let core: OrchestratorCore;
let auction: AuctionCore;
let season1: string;
let clubA: string, clubB: string;

// season-1 cast
let expiringA: string[] = []; // duration-1 at club A — must return to the pool
let carriedA: string[] = []; // duration-2 at club A — must carry
let oldTimer: string; // carried A player aged 36 — decline makes growth visible
let neverDrafted: string; // pure pool player — must stay byte-identical

const q = (text: string, params?: unknown[]) => pool.query(text, params);
const attrsOf = async (playerId: string): Promise<Record<string, number>> =>
  (await q(`SELECT attributes FROM players WHERE id = $1`, [playerId])).rows[0].attributes;
const phaseOf = async (seasonId: string): Promise<string> =>
  (await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase;

async function sign(clubId: string, playerId: string, seasonId: string, duration: number): Promise<void> {
  await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, $4)`,
    [playerId, clubId, seasonId, duration]);
  await q(`INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`, [clubId, seasonId, playerId]);
}

/** nominate → bid → timed close, the production path (season-test pattern). */
async function driveFinalLot(bidder: string, playerId: string): Promise<void> {
  const turn = (await auction.state(bidder)).turn;
  assert.ok(turn, 'auction has a nomination turn');
  const { lotId } = await auction.nominate(turn!.clubId, playerId);
  await auction.bid(bidder, lotId, 1_000);
  let res: Awaited<ReturnType<typeof auction.closeLot>> = 'skipped';
  for (let i = 0; i < 60 && res === 'skipped'; i++) {
    await new Promise((r) => setTimeout(r, 150));
    res = await auction.closeLot(lotId);
  }
  assert.equal(res, 'completed', 'the last signing completes the auction and generates the schedule');
}

/** force every deadline into the past, then close week by week in order. */
async function playSeason(seasonId: string): Promise<void> {
  await q(`UPDATE matchweeks SET opens_at = now() - interval '2 hours', deadline_at = now() - interval '1 minute'
           WHERE season_id = $1`, [seasonId]);
  const weeks = await q(`SELECT id FROM matchweeks WHERE season_id = $1 ORDER BY number`, [seasonId]);
  for (const w of weeks.rows) assert.equal(await core.runWeekClose(w.id), 'closed');
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  await seedPoolPlayers(pool, 40, 'RP'); // GK/DF/DF/MF/MF/FW cycle

  const setup = await setupSeason(pool, {
    clubs: [{ name: 'Alpha', managerEmail: 'a@ro.io' }, { name: 'Beta', managerEmail: 'b@ro.io' }],
  });
  season1 = setup.seasonId;
  [clubA, clubB] = setup.clubIds;

  // balanced 13-a-side from the pool: 1 GK, 4 DF, 5 MF, 3 FW per club
  const byPos = async (pos: string): Promise<string[]> =>
    (await q(`SELECT id FROM players p WHERE p.position = $1
              AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id AND ct.released_at IS NULL)
              ORDER BY full_name`, [pos])).rows.map((r) => r.id);
  const [gks, dfs, mfs, fws] = [await byPos('GK'), await byPos('DF'), await byPos('MF'), await byPos('FW')];
  const squadFor = (i: number): string[] => [
    gks[i], ...dfs.slice(i * 4, i * 4 + 4), ...mfs.slice(i * 5, i * 5 + 5), ...fws.slice(i * 3, i * 3 + 3),
  ];
  const squadA = squadFor(0);
  const squadB = squadFor(1);

  // A: 3 expiring (duration 1) + 10 carried (duration 2); B: 12 carried + 1 auction win
  expiringA = [squadA[5], squadA[6], squadA[10]]; // DF, MF, MF — the GK carries
  carriedA = squadA.filter((id) => !expiringA.includes(id));
  for (const id of squadA) await sign(clubA, id, season1, expiringA.includes(id) ? 1 : 2);
  for (const id of squadB.slice(0, 12)) await sign(clubB, id, season1, 2);

  // an old carried player makes growth/decline visible and deterministic
  oldTimer = carriedA[1];
  await q(`UPDATE players SET birth_date = '1990-02-01' WHERE id = $1`, [oldTimer]);
  neverDrafted = (await byPos('GK'))[2]; // stays in the pool both seasons

  core = createCore({ pool });
  auction = createAuctionCore({
    pool,
    armClose: async () => {},
    scheduleWeekClose: async () => {},
    tuning: { lotSeconds: 0.5, softCloseSeconds: 0.2 },
  });
});

after(async () => {
  await pool?.end();
});

// ── season 1: auction → play → rollover ─────────────────────────────────────

test('season 1: auction completes and the season plays to season_end + rollover', async () => {
  // B's 13th: any free agent — the one real lot drives completion
  const free = (await q(
    `SELECT id FROM players p WHERE NOT EXISTS
       (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id AND ct.released_at IS NULL)
     AND p.id <> $1 ORDER BY full_name LIMIT 1`, [neverDrafted],
  )).rows[0].id;
  await driveFinalLot(clubB, free);
  assert.equal(await phaseOf(season1), 'regular');

  // pre-rollover fixtures: familiarity to carry (or not), a facility level to carry
  const [a1, a2] = [carriedA[2], carriedA[3]].sort();
  await q(`INSERT INTO familiarity (club_id, season_id, player_a, player_b, value) VALUES ($1, $2, $3, $4, 0.8)`,
    [clubA, season1, a1, a2]); // both carried → must survive at ×carryOver
  const [m1, m2] = [carriedA[2], expiringA[0]].sort();
  await q(`INSERT INTO familiarity (club_id, season_id, player_a, player_b, value) VALUES ($1, $2, $3, $4, 0.6)`,
    [clubA, season1, m1, m2]); // one leaves → must NOT carry
  await q(`UPDATE club_seasons SET training_level = 2 WHERE club_id = $1 AND season_id = $2`, [clubA, season1]);

  await playSeason(season1);
  assert.equal(await phaseOf(season1), 'complete');
});

// ── the rollover invariants ──────────────────────────────────────────────────

let season2: string;

test('rollover: season 2 exists in the auction phase; expiries in the pool; carries intact', async () => {
  const s2 = await q(`SELECT id, phase, number FROM seasons WHERE number = 2`);
  assert.equal(s2.rowCount, 1);
  season2 = s2.rows[0].id;
  assert.equal(s2.rows[0].phase, 'auction');

  // expiring contracts released; carried contracts still active
  for (const id of expiringA) {
    const c = await q(`SELECT released_at FROM contracts WHERE player_id = $1`, [id]);
    assert.ok(c.rows[0].released_at, 'duration-1 contract expired');
  }
  const carried = await q(
    `SELECT count(*) FROM contracts WHERE club_id = $1 AND released_at IS NULL`, [clubA],
  );
  assert.equal(Number(carried.rows[0].count), carriedA.length, 'duration-2 contracts carry');

  // squad rows for season 2: carried players only, fresh state (off-season heals)
  const rows = await q(
    `SELECT player_id, fatigue, sharpness, injury_weeks_left FROM squad_players WHERE season_id = $1 AND club_id = $2`,
    [season2, clubA],
  );
  assert.equal(rows.rowCount, carriedA.length);
  assert.ok(!rows.rows.some((r) => expiringA.includes(r.player_id)), 'no expired player carried');
  assert.ok(rows.rows.every((r) => Number(r.fatigue) === 0 && r.injury_weeks_left === 0), 'off-season heals');
  assert.ok(rows.rows.every((r) => Math.abs(Number(r.sharpness) - LEAGUE_CFG.sharpnessColdStart) < 1e-6),
    'everyone starts the new season match-rusty');

  // the new auction pool = old pool + expiries, NEVER carried players
  const poolIds = new Set((await store.poolPlayers(pool, season2)).map((p) => p.playerId));
  for (const id of expiringA) assert.ok(poolIds.has(id), 'expired player available to re-draft');
  assert.ok(poolIds.has(neverDrafted), 'untouched pool player still there');
  for (const id of carriedA) assert.ok(!poolIds.has(id), 'carried player NOT in the pool');
});

test('rollover: growth carried exactly once — leavers depart grown, pool players byte-identical', async () => {
  // the old carried player declined (audit.after == current state, no re-apply)
  const audit = await q(
    `SELECT before, after FROM attribute_audit WHERE player_id = $1 AND season_id = $2 AND reason = 'season_growth'`,
    [oldTimer, season1],
  );
  assert.equal(audit.rowCount, 1, 'growth audited in season 1');
  assert.ok(audit.rows[0].after.pace < audit.rows[0].before.pace, 'a 36-year-old declined');
  assert.deepEqual(await attrsOf(oldTimer), audit.rows[0].after, 'current state IS the audited after — nothing re-applied or lost');

  // an expiring player who played also grew, and RE-FREEZES at that state
  const leaverAudit = await q(
    `SELECT after FROM attribute_audit WHERE player_id = $1 AND season_id = $2 AND reason = 'season_growth'`,
    [expiringA[0], season1],
  );
  if ((leaverAudit.rowCount ?? 0) > 0) {
    assert.deepEqual(await attrsOf(expiringA[0]), leaverAudit.rows[0].after, 'leaver departs at his GROWN state');
  }

  // a never-drafted pool player has never been audited and never changed
  const poolAudit = await q(`SELECT count(*) FROM attribute_audit WHERE player_id = $1`, [neverDrafted]);
  assert.equal(Number(poolAudit.rows[0].count), 0);
  const flat = await attrsOf(neverDrafted);
  assert.ok(Object.entries(flat).every(([k, v]) => (k.startsWith('gk') ? v === 16 : v === 10)),
    'frozen pool player byte-identical to seeding');
});

test('rollover: familiarity carries at ×carryOver for both-retained pairs only', async () => {
  const [a1, a2] = [carriedA[2], carriedA[3]].sort();
  // the seeded 0.8 GREW during season 1 (they played together — bookkeeping
  // bumps dyads), so the carry is measured against the end-of-season value
  const endOfSeason1 = Number((await q(
    `SELECT value FROM familiarity WHERE season_id = $1 AND club_id = $2 AND player_a = $3 AND player_b = $4`,
    [season1, clubA, a1, a2],
  )).rows[0].value);
  assert.ok(endOfSeason1 >= 0.8, 'precondition: the dyad accrued through play');
  const kept = await q(
    `SELECT value FROM familiarity WHERE season_id = $1 AND club_id = $2 AND player_a = $3 AND player_b = $4`,
    [season2, clubA, a1, a2],
  );
  assert.equal(kept.rowCount, 1, 'both-retained dyad carried');
  assert.ok(Math.abs(Number(kept.rows[0].value) - endOfSeason1 * LEAGUE_CFG.familiarityCarryOver) < 1e-5);

  const broken = await q(
    `SELECT count(*) FROM familiarity f WHERE f.season_id = $1 AND (f.player_a = $2 OR f.player_b = $2)`,
    [season2, expiringA[0]],
  );
  assert.equal(Number(broken.rows[0].count), 0, 'a broken contract comes back cold');
});

test('rollover: budgets fresh, facilities + training dial carried', async () => {
  const cs = await q(
    `SELECT transfer_budget, wage_cap, training_level, medical_level FROM club_seasons WHERE season_id = $1 AND club_id = $2`,
    [season2, clubA],
  );
  assert.equal(Number(cs.rows[0].transfer_budget), 100_000, 'configured allotment copied');
  assert.equal(cs.rows[0].training_level, 2, 'the building persists');
  assert.equal(await store.budgetRemaining(pool, season2, clubA), 100_000, 'spend is fresh (txns are per-season)');
});

// ── season 2: the loop closes ────────────────────────────────────────────────

test('season 2: auction re-acquires an expired player at his grown state, and the season plays', async () => {
  // A carried 10, needs 3: two direct signings + ONE real lot (a re-draft of an expiry)
  const free = (await store.poolPlayers(pool, season2)).map((p) => p.playerId);
  const direct = free.filter((id) => !expiringA.includes(id)).slice(0, 2);
  for (const id of direct) await sign(clubA, id, season2, 1);

  const grownBefore = await attrsOf(expiringA[0]);
  await driveFinalLot(clubA, expiringA[0]);
  assert.equal(await phaseOf(season2), 'regular', 'season 2 auction completed and scheduled');

  // the re-draft carries the grown state (never re-applied) and is familiarity-cold
  const c = await q(`SELECT club_id FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [expiringA[0]]);
  assert.equal(c.rows[0].club_id, clubA);
  assert.deepEqual(await attrsOf(expiringA[0]), grownBefore, 're-draft neither re-applies nor loses growth');
  const fam = await q(
    `SELECT count(*) FROM familiarity WHERE season_id = $1 AND (player_a = $2 OR player_b = $2)`,
    [season2, expiringA[0]],
  );
  assert.equal(Number(fam.rows[0].count), 0, 're-drafted after a break = cold with everyone');

  const mws = await q(`SELECT count(*) FROM matchweeks WHERE season_id = $1`, [season2]);
  assert.equal(Number(mws.rows[0].count), 3, '2 rounds + the transfer bye');

  // season 2 PLAYS — and its own rollover opens season 3: the loop is closed
  await playSeason(season2);
  assert.equal(await phaseOf(season2), 'complete');
  const s3 = await q(`SELECT phase FROM seasons WHERE number = 3`);
  assert.equal(s3.rows[0]?.phase, 'auction', 'the game repeats indefinitely');
});
