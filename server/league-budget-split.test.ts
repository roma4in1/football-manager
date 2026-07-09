/**
 * league-budget-split.test.ts — the pre-auction budget split (6b): the split
 * binds (fixed bidding balance, locked at first bid), reserve never re-enters
 * bidding, unspent bring half-converts at completion, facilities and the
 * mid-season window spend the reserve, and the reserve earns its growth tick
 * when it carries to the next season. The multi-season competitiveness gate
 * lives in growth-harness.ts (scenario 4, CI fixture mode).
 *
 *   npm run db:test:up && node --test league-budget-split.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { AuctionError, createAuctionCore, type AuctionCore } from './league-auction.ts';
import { createTransferCore } from './league-transfers.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, seedBareClub, seedPoolPlayers, seedSeason } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let auction: AuctionCore;
let seasonId: string;
let clubA: string, clubB: string;
let poolIds: string[];

const q = (text: string, params?: unknown[]) => pool.query(text, params);
const moneyOf = async (clubId: string) => (await store.getFacilities(pool, seasonId, clubId))!;

async function preContract(clubId: string, playerId: string): Promise<void> {
  await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`,
    [playerId, clubId, seasonId]);
  await q(`INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`, [clubId, seasonId, playerId]);
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool, 'auction');
  ({ clubId: clubA } = await seedBareClub(pool, seasonId, 'Alpha', 'a@split.io'));
  ({ clubId: clubB } = await seedBareClub(pool, seasonId, 'Beta', 'b@split.io'));
  poolIds = await seedPoolPlayers(pool, 12, 'SP');
  auction = createAuctionCore({
    pool,
    armClose: async () => {},
    scheduleWeekClose: async () => {},
    tuning: { lotSeconds: 0.5, softCloseSeconds: 0.2, bidIncrementMin: 1, squadMin: 2, squadMax: 3 },
  });
});

after(async () => {
  await pool?.end();
});

test('split: set and re-set freely before bidding; garbage rejected', async () => {
  await auction.setSplit(clubA, 60_000);
  let m = await moneyOf(clubA);
  assert.equal(m.auctionBudget, 40_000);
  assert.equal(m.reserveBalance, 60_000);

  // re-split adjusts by the DIFFERENCE, not additively
  await auction.setSplit(clubA, 70_000);
  m = await moneyOf(clubA);
  assert.equal(m.auctionBudget, 30_000);
  assert.equal(m.reserveBalance, 70_000);

  for (const bad of [-1, 100_001, 0.5]) {
    await assert.rejects(auction.setSplit(clubA, bad), (err: unknown) => {
      assert.ok(err instanceof AuctionError);
      assert.equal(err.body.error, 'bad_split');
      return true;
    });
  }
});

test('bidding balance = bring, reserve NEVER re-enters bidding, split locks at first bid', async () => {
  // toward completion (squadMin 2): A pre-contracts 1, B pre-contracts 2
  await preContract(clubA, poolIds[0]);
  await preContract(clubB, poolIds[1]);
  await preContract(clubB, poolIds[2]);

  // B nominates (reverse seed order), A bids
  const turn = (await auction.state(clubA)).turn;
  assert.equal(turn?.clubId, clubB, 'reverse seed: Beta opens');
  const { lotId } = await auction.nominate(clubB, poolIds[3]);

  // A's pot is 100k but the split brought 30k: reserve is INVISIBLE to bidding
  await assert.rejects(auction.bid(clubA, lotId, 30_001), (err: unknown) => {
    assert.ok(err instanceof AuctionError);
    assert.equal(err.body.error, 'over_budget');
    assert.equal(err.body.remaining, 30_000);
    return true;
  });
  await auction.bid(clubA, lotId, 25_000);

  // the first bid BINDS the split
  await assert.rejects(auction.setSplit(clubA, 10_000), (err: unknown) => {
    assert.ok(err instanceof AuctionError);
    assert.equal(err.body.error, 'split_locked');
    return true;
  });
  const you = (await auction.state(clubA)).you;
  assert.equal(you.splitLocked, true);
  assert.equal(you.auctionBudget, 30_000);
  assert.equal(you.remaining, 30_000, 'bids don’t debit until won');
  assert.equal(you.reserve, 70_000);

  // timed close → A wins → both clubs at squadMin → completion
  let res: Awaited<ReturnType<typeof auction.closeLot>> = 'skipped';
  for (let i = 0; i < 60 && res === 'skipped'; i++) {
    await new Promise((r) => setTimeout(r, 150));
    res = await auction.closeLot(lotId);
  }
  assert.equal(res, 'completed');
});

test('completion half-converts unspent bring to reserve — over-bringing costs', async () => {
  // A brought 30k, spent 25k → leftover 5k → +2.5k reserve
  const a = await moneyOf(clubA);
  assert.equal(a.reserveBalance, 70_000 + Math.floor(5_000 * LEAGUE_CFG.auctionLeftoverToReserve));
  // B never split (brought all 100k), spent 0 → +50k reserve — half was LOST
  const b = await moneyOf(clubB);
  assert.equal(b.reserveBalance, Math.floor(100_000 * LEAGUE_CFG.auctionLeftoverToReserve));
  assert.equal((await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase, 'regular');
});

test('facilities spend the reserve', async () => {
  // the toy auction banked ~72.5k; facilities cost real millions since the
  // economy rescale — top up so the level is affordable, then check the debit
  await q(`UPDATE club_seasons SET reserve_balance = reserve_balance + $3 WHERE club_id = $1 AND season_id = $2`,
    [clubA, seasonId, LEAGUE_CFG.facilityCostByLevel[0]]);
  const before_ = (await moneyOf(clubA)).reserveBalance;
  await store.applyFacilityInvestment(pool, seasonId, clubA, 'medical', LEAGUE_CFG.facilityCostByLevel[0]);
  const after_ = await moneyOf(clubA);
  assert.equal(after_.reserveBalance, before_ - LEAGUE_CFG.facilityCostByLevel[0]);
  assert.equal(after_.medicalLevel, 1);
});

test('the mid-season window spends and credits the reserve', async () => {
  await q(`UPDATE seasons SET phase = 'transfer_window' WHERE id = $1`, [seasonId]);
  const transfers = createTransferCore({ pool, tuning: { squadMin: 1, squadMax: 5 } });

  // inter-club: fee moves reserve→reserve
  const aBefore = (await moneyOf(clubA)).reserveBalance;
  const bBefore = (await moneyOf(clubB)).reserveBalance;
  const { offerId } = await transfers.makeOffer(clubA, poolIds[1], 5_000); // a B player
  await transfers.respondOffer(clubB, offerId, true);
  assert.equal((await moneyOf(clubA)).reserveBalance, aBefore - 5_000);
  assert.equal((await moneyOf(clubB)).reserveBalance, bBefore + 5_000);

  // pool signing: fixed price debits the reserve
  await q(`UPDATE players SET market_value = 8000 WHERE id = $1`, [poolIds[5]]);
  await transfers.signPoolPlayer(clubB, poolIds[5]);
  assert.equal((await moneyOf(clubB)).reserveBalance, bBefore + 5_000 - 8_000);
  await q(`UPDATE seasons SET phase = 'regular' WHERE id = $1`, [seasonId]);
});

test('the reserve earns its growth tick when it carries to the next season', async () => {
  await q(`UPDATE club_seasons SET reserve_balance = 40000 WHERE club_id = $1 AND season_id = $2`, [clubA, seasonId]);
  const nextId = await store.createNextSeason(pool, seasonId, LEAGUE_CFG.reserveGrowthRate);
  const next = (await q(
    `SELECT auction_budget, reserve_balance, transfer_budget FROM club_seasons WHERE season_id = $1 AND club_id = $2`,
    [nextId, clubA],
  )).rows[0];
  assert.equal(Number(next.reserve_balance), Math.floor(40_000 * (1 + LEAGUE_CFG.reserveGrowthRate)));
  assert.equal(next.auction_budget, null, 'the new draft starts unsplit (bring everything until set)');
  assert.equal(Number(next.transfer_budget), 100_000, 'the allotment itself is fresh');
});
