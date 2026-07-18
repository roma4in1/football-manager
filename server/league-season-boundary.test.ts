/**
 * league-season-boundary.test.ts — regression for the N=2 live-test 23514:
 * forcing week closes through a WHOLE small season, the way the admin
 * force-week-close route does (forceMatchweekDeadline + runWeekClose), must
 * walk regular → transfer → last regular → season_end → complete and roll
 * into season 2's auction. Pre-fix, forcing any week whose opens_at was
 * still in the future (every week after the first forced one — the schedule
 * sits on the original cadence) violated CHECK (deadline_at > opens_at):
 * "new row for relation matchweeks violates check constraint
 * matchweeks_check".
 *
 *   npm run db:test:up && node --test league-season-boundary.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createAuctionCore } from './league-auction.ts';
import { createCore, type OrchestratorCore } from './league-orchestrator.ts';
import { setupSeason } from './league-setup.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let core: OrchestratorCore;
let seasonId: string;
let clubIds: string[];

const q = (text: string, params?: unknown[]) => pool.query(text, params);

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  await seedPoolPlayers(pool, 40, 'SB');

  ({ seasonId, clubIds } = await setupSeason(pool, {
    clubs: [{ name: 'Alpha', managerEmail: 'a@sb.io' }, { name: 'Beta', managerEmail: 'b@sb.io' }],
    squadMin: 13,
    squadMax: 18,
  }));

  // pre-contract to squadMin−1 for Beta, squadMin for Alpha; ONE real lot
  // completes the auction through the production closeLot → maybeComplete path
  const freeAgents = await q(`SELECT id, position FROM players ORDER BY full_name`);
  const gks = freeAgents.rows.filter((r) => r.position === 'GK').map((r) => r.id);
  const outfield = freeAgents.rows.filter((r) => r.position !== 'GK').map((r) => r.id);
  const sign = async (clubId: string, playerId: string) => {
    await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 2)`, [playerId, clubId, seasonId]);
    await q(`INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`, [clubId, seasonId, playerId]);
  };
  await sign(clubIds[0], gks[0]);
  for (let i = 0; i < 12; i++) await sign(clubIds[0], outfield[i]);
  await sign(clubIds[1], gks[1]);
  for (let i = 12; i < 23; i++) await sign(clubIds[1], outfield[i]);

  const auction = createAuctionCore({
    pool,
    armClose: async () => {},
    scheduleWeekClose: async () => {},
    // the file's toy squad bounds (13/18) — must match the setupSeason tuning
    // above or completion waits for the LEAGUE_CFG floor these squads never reach
    tuning: { lotSeconds: 0.4, softCloseSeconds: 0.2, bidIncrementMin: 1, squadMin: 13, squadMax: 18 },
  });
  const turn = (await auction.state(clubIds[0])).turn;
  assert.ok(turn, 'auction has a nomination turn');
  const { lotId } = await auction.nominate(turn!.clubId, outfield[30]);
  await auction.bid(clubIds[1], lotId, 1_000);
  let res: Awaited<ReturnType<typeof auction.closeLot>> = 'skipped';
  for (let i = 0; i < 60 && res === 'skipped'; i++) {
    await new Promise((r) => setTimeout(r, 150));
    res = await auction.closeLot(lotId);
  }
  assert.equal(res, 'completed', 'auction completes and generates the schedule');

  core = createCore({ pool });
});

after(async () => {
  await pool?.end();
});

test('N=2: forced closes walk the whole season — the boundary transition never writes an invalid matchweek row', async () => {
  const weeks = await q(`SELECT kind FROM matchweeks WHERE season_id = $1 ORDER BY number`, [seasonId]);
  assert.deepEqual(weeks.rows.map((r) => r.kind), ['regular', 'transfer', 'regular']);

  const expected = ['transfer_window', 'regular', 'complete']; // phase after each forced close
  for (let step = 0; step < 3; step++) {
    const mw = await store.currentMatchweek(pool, seasonId);
    assert.ok(mw && !mw.revealedAt, `an unrevealed matchweek exists at step ${step + 1}`);

    if (step > 0) {
      // the regression condition: every week after the first forced one is
      // still PENDING (opens_at in the future, laid out on the real cadence)
      assert.ok(mw!.opensAt > new Date(), `week #${mw!.number} has not opened yet — forcing it is the regression case`);
    }

    // pre-fix this threw 23514 (matchweeks_check) on every pending week
    assert.equal(await store.forceMatchweekDeadline(pool, mw!.id), true, `force week #${mw!.number}`);
    assert.equal(await core.runWeekClose(mw!.id), 'closed', `close week #${mw!.number}`);

    const phase = (await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase;
    assert.equal(phase, expected[step], `phase after closing week ${step + 1}`);
  }

  // the boundary transition ran to the end: growth+expiry+rollover happened
  // atomically with the final reveal, and season 2 waits in its auction
  const revealed = await q(`SELECT count(*)::int AS n FROM matchweeks WHERE season_id = $1 AND revealed_at IS NOT NULL`, [seasonId]);
  assert.equal(revealed.rows[0].n, 3, 'every matchweek revealed');

  const next = await q(`SELECT id, number, phase FROM seasons WHERE number = 2`);
  assert.equal(next.rowCount, 1, 'season 2 exists');
  assert.equal(next.rows[0].phase, 'auction');

  const carried = await q(`SELECT count(*)::int AS n FROM squad_players WHERE season_id = $1`, [next.rows[0].id]);
  assert.ok(carried.rows[0].n > 0, 'carried contracts have season-2 squad rows');
});

test('forcing an already-revealed week is refused (nothing to force)', async () => {
  const anyWeek = await q(`SELECT id FROM matchweeks WHERE season_id = $1 LIMIT 1`, [seasonId]);
  assert.equal(await store.forceMatchweekDeadline(pool, anyWeek.rows[0].id), false);
});
