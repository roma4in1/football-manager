/**
 * league-auction-floor.test.ts — the completion floor is STRUCTURAL:
 * the auction can never complete while any club is below squadMin on
 * EITHER ledger (squad_players or active contracts), and close jobs that
 * fire after completion (queue lag) can no longer sign anyone.
 *
 * Context (DECISIONS 2026-08-26, open investigation): the live test auction
 * completed with a club at 11/13. The every-club>=squadMin gate reads
 * squad_players only; the recorded suspects are ledger divergence and
 * post-completion mutation. Both are pinned down here.
 *
 *   npm run db:test:up && node --test league-auction-floor.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createAuctionCore, type AuctionCore } from './league-auction.ts';
import { setupSeason } from './league-setup.ts';
import { bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let auction: AuctionCore;
let seasonId: string;
let alpha: string, beta: string;
let poolIds: string[] = [];
let betaGhostContract: string; // Beta's player whose contract is released mid-test

const q = (text: string, params?: unknown[]) => pool.query(text, params);

const phase = async (): Promise<string> =>
  (await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase;

/** closeLot with the poll-until-resolved pattern the season tests use. */
async function settle(lotId: string): Promise<Awaited<ReturnType<AuctionCore['closeLot']>>> {
  let res: Awaited<ReturnType<AuctionCore['closeLot']>> = 'skipped';
  for (let i = 0; i < 60 && res === 'skipped'; i++) {
    await new Promise((r) => setTimeout(r, 120));
    res = await auction.closeLot(lotId);
  }
  return res;
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  poolIds = await seedPoolPlayers(pool, 40, 'FL'); // sized past the setup guard's positional floors

  const setup = await setupSeason(pool, {
    clubs: [{ name: 'Alpha', managerEmail: 'a@fl.io' }, { name: 'Beta', managerEmail: 'b@fl.io' }],
    squadMin: 2,
    squadMax: 4,
  });
  seasonId = setup.seasonId;
  [alpha, beta] = setup.clubIds;

  // both clubs LOOK at squadMin (2) by squad_players…
  const sign = async (clubId: string, playerId: string) => {
    await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`, [playerId, clubId, seasonId]);
    await q(`INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`, [clubId, seasonId, playerId]);
  };
  await sign(alpha, poolIds[0]);
  await sign(alpha, poolIds[1]);
  await sign(beta, poolIds[2]);
  await sign(beta, poolIds[3]);
  // …but Beta's second contract is RELEASED: the ledgers now disagree
  // (squad_players says 2, active contracts say 1) — the recorded suspect
  betaGhostContract = poolIds[3];
  await q(`UPDATE contracts SET released_at = now() WHERE player_id = $1`, [betaGhostContract]);

  auction = createAuctionCore({
    pool,
    armClose: async () => {},
    scheduleWeekClose: async () => {},
    tuning: { lotSeconds: 0.4, softCloseSeconds: 0.2, bidIncrementMin: 1, squadMin: 2, squadMax: 4 },
  });
});

after(async () => {
  await pool?.end();
});

test('ledger divergence blocks completion: a club below squadMin on active contracts cannot pass the gate', async () => {
  // pre-fix, this lot completed the auction: squad_players reads Alpha 3 /
  // Beta 2, both ≥ 2 — but Beta has only ONE active contract
  const turn = (await auction.state(alpha)).turn!;
  const { lotId } = await auction.nominate(turn.clubId, poolIds[10]);
  await auction.bid(alpha, lotId, 10);
  const res = await settle(lotId);

  assert.equal(res, 'won', 'the lot itself sells (to Alpha)');
  assert.equal(await phase(), 'auction', 'completion refused while the contract ledger has Beta below squadMin');
});

test('healing the divergence lets the next close complete the auction', async () => {
  await q(`UPDATE contracts SET released_at = NULL WHERE player_id = $1`, [betaGhostContract]);

  const turn = (await auction.state(alpha)).turn!;
  const { lotId } = await auction.nominate(turn.clubId, poolIds[11]);
  await auction.bid(alpha, lotId, 10); // Alpha 3→4, within squadMax
  const res = await settle(lotId);

  assert.equal(res, 'completed', 'both ledgers at the floor → completion');
  assert.equal(await phase(), 'regular');
});

test('a stale close job firing after completion signs nobody', async () => {
  // a pending-close lot left over from the auction (its job queued behind the
  // completing one) — closing it in phase=regular must be a no-op
  const stale = await q(
    `INSERT INTO auction_lots (season_id, player_id, opens_at, closes_at)
     VALUES ($1, $2, now() - interval '10 seconds', now() - interval '5 seconds') RETURNING id`,
    [seasonId, poolIds[12]],
  );
  const lotId = stale.rows[0].id as string;
  await q(
    `INSERT INTO auction_bids (lot_id, club_id, amount, placed_at) VALUES ($1, $2, 10, now() - interval '7 seconds')`,
    [lotId, beta],
  );

  assert.equal(await auction.closeLot(lotId), 'skipped', 'post-completion close is a no-op');
  const contract = await q(`SELECT 1 FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [poolIds[12]]);
  assert.equal(contract.rowCount, 0, 'no contract was created after the auction ended');
  const squadRow = await q(`SELECT 1 FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, poolIds[12]]);
  assert.equal(squadRow.rowCount, 0, 'no squad row was created after the auction ended');
});
