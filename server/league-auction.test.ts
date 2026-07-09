/**
 * league-auction.test.ts — auction integration tests against real Postgres +
 * pg-boss timers + the HTTP API (fastify inject).
 *
 *   npm run db:test:up && npm run test:auction
 *
 * Tuned tiny for tests: 3s lots, 1.5s soft close, squadMin 2 / squadMax 3.
 * Alpha & Beta (seed order = name asc); snake starts reverse: Beta first.
 * Expected nomination sequence: Beta, Alpha, Alpha, Beta, Beta, …
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createApi, SESSION_COOKIE, type LinkDelivery } from './league-api.ts';
import { doubleRoundRobin, snakeNominator } from './league-auction.ts';
import { wageFromMarketValue } from '@fm/engine/config';
import { createOrchestrator, type Orchestrator } from './league-orchestrator.ts';
import { bootstrapSchema, seedBareClub, seedPoolPlayers, seedSeason, waitFor } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const SECRET = 'auction-test-secret';

let pool: pg.Pool;
let orch: Orchestrator;
let api: FastifyInstance;
let seasonId: string;
let clubAlpha: string, clubBeta: string;
let poolIds: string[] = [];
let cookieAlpha: string, cookieBeta: string;

const delivered: Array<{ email: string; url: string }> = [];
const captureDelivery: LinkDelivery = {
  async sendLoginLink(email, url) {
    delivered.push({ email, url });
  },
};

const q = (text: string, params?: unknown[]) => pool.query(text, params);

async function call(method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: unknown) {
  return api.inject({
    method, url,
    cookies: { [SESSION_COOKIE]: cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function login(email: string): Promise<string> {
  delivered.length = 0;
  await api.inject({ method: 'POST', url: '/api/auth/request-link', payload: { email } });
  const token = new URL(delivered[0].url).searchParams.get('token')!;
  const res = await api.inject({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(token)}` });
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

/** Wait until a lot is resolved (won, or expired past closes_at with the close job done). */
async function waitForResolution(lotId: string): Promise<void> {
  await waitFor(async () => {
    const r = await q(`SELECT won_by, closes_at FROM auction_lots WHERE id = $1`, [lotId]);
    if (!r.rows[0]) return false;
    if (r.rows[0].won_by) return true;
    // unresolved: give the close job a beat after closes_at
    return Date.now() - new Date(r.rows[0].closes_at).getTime() > 2_500;
  }, `lot ${lotId} resolution`, 30_000);
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool, 'auction');
  ({ clubId: clubAlpha } = await seedBareClub(pool, seasonId, 'Alpha', 'alpha@test.io'));
  ({ clubId: clubBeta } = await seedBareClub(pool, seasonId, 'Beta', 'beta@test.io'));
  poolIds = await seedPoolPlayers(pool, 12);

  orch = await createOrchestrator({
    pool,
    connectionString: DATABASE_URL,
    pollingIntervalSeconds: 0.5,
    auctionTuning: { lotSeconds: 3, softCloseSeconds: 1.5, bidIncrementMin: 1, squadMin: 2, squadMax: 3 },
  });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET, delivery: captureDelivery });
  cookieAlpha = await login('alpha@test.io');
  cookieBeta = await login('beta@test.io');
});

after(async () => {
  await api?.close();
  await orch?.stop();
  await pool?.end();
});

// ── pure pieces ──────────────────────────────────────────────────────────────

test('snake order: reverse seed opens, direction flips each round', () => {
  const seeds = ['s1', 's2', 's3'];
  const turns = Array.from({ length: 9 }, (_, i) => snakeNominator(seeds, i));
  assert.deepEqual(turns, ['s3', 's2', 's1', 's1', 's2', 's3', 's3', 's2', 's1']);
});

test('double round-robin: every pair twice with venues swapped, one match per club per round', () => {
  const clubs = ['a', 'b', 'c', 'd'];
  const rounds = doubleRoundRobin(clubs);
  assert.equal(rounds.length, 6, '2·(n−1) rounds');

  const seen = new Map<string, number>();
  for (const round of rounds) {
    assert.equal(round.length, 2, 'n/2 fixtures per round');
    const inRound = new Set<string>();
    for (const { home, away } of round) {
      for (const club of [home, away]) {
        assert.ok(!inRound.has(club), 'a club plays once per round');
        inRound.add(club);
      }
      seen.set(`${home}|${away}`, (seen.get(`${home}|${away}`) ?? 0) + 1);
    }
  }
  assert.equal(seen.size, 12, 'n·(n−1) ordered pairs');
  for (const [pair, count] of seen) {
    assert.equal(count, 1, `${pair} exactly once per venue`);
    const [h, a] = pair.split('|');
    assert.equal(seen.get(`${a}|${h}`), 1, 'reverse venue exists');
  }
});

// ── flow ─────────────────────────────────────────────────────────────────────

let lot0 = ''; // Beta's first nomination

test('state shows the turn; nominating out of turn is 409', async () => {
  const stateAlpha = (await call('GET', '/api/auction/state', cookieAlpha)).json();
  assert.equal(stateAlpha.phase, 'auction');
  assert.equal(stateAlpha.lot, null);
  assert.equal(stateAlpha.turn.clubId, clubBeta, 'reverse seed → Beta nominates first');
  assert.equal(stateAlpha.turn.you, false);
  assert.equal((await call('GET', '/api/auction/state', cookieBeta)).json().turn.you, true);

  const wrongTurn = await call('POST', '/api/auction/nominate', cookieAlpha, { playerId: poolIds[0] });
  assert.equal(wrongTurn.statusCode, 409);
  assert.equal(wrongTurn.json().error, 'not_your_turn');
});

test('nominate → live lot; over-budget and stale bids are rejected; race yields one 409', async () => {
  const nom = await call('POST', '/api/auction/nominate', cookieBeta, { playerId: poolIds[0] });
  assert.equal(nom.statusCode, 200);
  lot0 = nom.json().lotId;

  const second = await call('POST', '/api/auction/nominate', cookieBeta, { playerId: poolIds[1] });
  assert.equal(second.statusCode, 409, 'one lot live at a time');
  assert.equal(second.json().error, 'lot_live');

  const overBudget = await call('POST', '/api/auction/bid', cookieAlpha, { lotId: lot0, amount: 100_001 });
  assert.equal(overBudget.statusCode, 422, 'cannot bid beyond transfer budget');
  assert.equal(overBudget.json().error, 'over_budget');

  assert.equal((await call('POST', '/api/auction/bid', cookieAlpha, { lotId: lot0, amount: 100 })).statusCode, 200);
  const stale = await call('POST', '/api/auction/bid', cookieBeta, { lotId: lot0, amount: 100 });
  assert.equal(stale.statusCode, 409, 'bid must beat the current high');
  assert.equal(stale.json().error, 'outbid');
  assert.equal(stale.json().highBid, 100);

  // simultaneous equal raises: the lot row lock serializes them, loser sees 409
  const [r1, r2] = await Promise.all([
    call('POST', '/api/auction/bid', cookieAlpha, { lotId: lot0, amount: 500 }),
    call('POST', '/api/auction/bid', cookieBeta, { lotId: lot0, amount: 500 }),
  ]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409], 'exactly one of the race wins');
});

test('soft close: a late bid extends the window; winner signs at g(mv)', async () => {
  const before1 = new Date((await call('GET', '/api/auction/state', cookieAlpha)).json().lot.closesAt);
  // land ~1s before close — inside the 1.5s soft-close window
  await new Promise((r) => setTimeout(r, Math.max(0, before1.getTime() - Date.now() - 1_000)));
  const res = await call('POST', '/api/auction/bid', cookieAlpha, { lotId: lot0, amount: 600 });
  assert.equal(res.statusCode, 200);
  const after1 = new Date(res.json().closesAt);
  assert.ok(after1.getTime() > before1.getTime(), `soft close extended: ${before1.toISOString()} → ${after1.toISOString()}`);

  await waitForResolution(lot0);
  const lot = (await q(`SELECT won_by FROM auction_lots WHERE id = $1`, [lot0])).rows[0];
  assert.equal(lot.won_by, clubAlpha, 'highest bidder wins at close');

  const contract = await q(
    `SELECT wage, duration FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [poolIds[0]],
  );
  const mv = Number((await q(`SELECT market_value FROM players WHERE id = $1`, [poolIds[0]])).rows[0].market_value);
  assert.equal(Number(contract.rows[0].wage), wageFromMarketValue(mv), 'wage = g(market value)');
  assert.equal(contract.rows[0].duration, 2, 'signing default duration');

  const txn = await q(
    `SELECT amount FROM transactions WHERE kind = 'auction_win' AND club_id = $1 AND player_id = $2`,
    [clubAlpha, poolIds[0]],
  );
  assert.equal(Number(txn.rows[0].amount), 600, 'winner pays the winning bid');

  const state = (await call('GET', '/api/auction/state', cookieAlpha)).json();
  assert.equal(state.you.remaining, 100_000 - 600, 'budget reflects committed wins');
  assert.equal(state.you.squadCount, 1);
});

test('winner adjusts contract duration while the auction runs; others cannot', async () => {
  const notYours = await call('PUT', '/api/auction/contract-duration', cookieBeta, { playerId: poolIds[0], duration: 4 });
  assert.equal(notYours.statusCode, 409);

  const ok = await call('PUT', '/api/auction/contract-duration', cookieAlpha, { playerId: poolIds[0], duration: 4 });
  assert.equal(ok.statusCode, 204);
  const contract = await q(`SELECT duration FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [poolIds[0]]);
  assert.equal(contract.rows[0].duration, 4);
});

test('wage cap: bid-time rejection, and breach at close forfeits + re-lots', async () => {
  // lots so far: 1 → Alpha's turn
  const nom = await call('POST', '/api/auction/nominate', cookieAlpha, { playerId: poolIds[1] });
  assert.equal(nom.statusCode, 200);
  const lotId = nom.json().lotId as string;

  await q(`UPDATE club_seasons SET wage_cap = 1 WHERE club_id = $1`, [clubBeta]);
  const capped = await call('POST', '/api/auction/bid', cookieBeta, { lotId, amount: 50 });
  assert.equal(capped.statusCode, 422, 'bid-time wage headroom check');
  assert.equal(capped.json().error, 'wage_cap');

  await q(`UPDATE club_seasons SET wage_cap = 10000 WHERE club_id = $1`, [clubBeta]);
  assert.equal((await call('POST', '/api/auction/bid', cookieBeta, { lotId, amount: 50 })).statusCode, 200);
  await q(`UPDATE club_seasons SET wage_cap = 1 WHERE club_id = $1`, [clubBeta]); // breach appears before close

  await waitForResolution(lotId);
  const lot = (await q(`SELECT won_by FROM auction_lots WHERE id = $1`, [lotId])).rows[0];
  assert.equal(lot.won_by, null, 'forfeited — no winner recorded');
  assert.equal(
    (await q(`SELECT count(*) FROM contracts WHERE player_id = $1`, [poolIds[1]])).rows[0].count, '0',
    'no contract on forfeit',
  );
  assert.equal(
    (await q(`SELECT count(*) FROM transactions WHERE kind = 'auction_win' AND club_id = $1`, [clubBeta])).rows[0].count,
    '0', 'no payment on forfeit',
  );
  await q(`UPDATE club_seasons SET wage_cap = 10000 WHERE club_id = $1`, [clubBeta]);

  const poolAgain = (await call('GET', '/api/auction/pool', cookieBeta)).json();
  assert.ok(
    poolAgain.players.some((p: { playerId: string }) => p.playerId === poolIds[1]),
    'forfeited player returns to the pool',
  );
});

test('squadMin gates completion; reaching it generates the schedule and opens the season', async () => {
  // Alpha has 1 player, Beta 0; squadMin 2. Turn order continues: Alpha, Beta, Beta.
  const winLot = async (nominator: string, bidder: string, playerId: string): Promise<void> => {
    const nom = await call('POST', '/api/auction/nominate', nominator, { playerId });
    assert.equal(nom.statusCode, 200, `nominate ${playerId}: ${nom.body}`);
    const lotId = nom.json().lotId as string;
    assert.equal((await call('POST', '/api/auction/bid', bidder, { lotId, amount: 10 })).statusCode, 200);
    await waitForResolution(lotId);
  };

  await winLot(cookieAlpha, cookieBeta, poolIds[2]); // Beta signs → 1/1, still below min for Beta? (Alpha 1, Beta 1)
  assert.equal((await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase, 'auction',
    'auction cannot end while any club is below squadMin');

  await winLot(cookieBeta, cookieAlpha, poolIds[3]); // Alpha signs → Alpha 2, Beta 1 → still open
  assert.equal((await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase, 'auction');

  await winLot(cookieBeta, cookieBeta, poolIds[4]); // Beta self-bids and signs → all at squadMin
  await waitFor(async () =>
    (await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase === 'regular',
  'auction completion transition', 15_000);

  // schedule: 2 clubs → 2 regular rounds + transfer week clamped to after round 1
  const season = await q(`SELECT matchweek_count, transfer_week FROM seasons WHERE id = $1`, [seasonId]);
  assert.equal(season.rows[0].matchweek_count, 2);
  assert.equal(season.rows[0].transfer_week, 1);

  const weeks = await q(
    `SELECT id, number, kind FROM matchweeks WHERE season_id = $1 ORDER BY number`, [seasonId],
  );
  assert.deepEqual(weeks.rows.map((r) => r.kind), ['regular', 'transfer', 'regular']);

  const fixtures = await q(
    `SELECT f.home_club_id, f.away_club_id, mw.kind FROM fixtures f
     JOIN matchweeks mw ON mw.id = f.matchweek_id WHERE mw.season_id = $1 ORDER BY mw.number`,
    [seasonId],
  );
  assert.equal(fixtures.rowCount, 2, 'double round-robin for 2 clubs');
  assert.ok(fixtures.rows.every((r) => r.kind === 'regular'), 'transfer week has no fixtures');
  assert.equal(fixtures.rows[0].home_club_id, fixtures.rows[1].away_club_id, 'venues swap between legs');
  assert.equal(fixtures.rows[0].away_club_id, fixtures.rows[1].home_club_id);

  // duration adjustment window closed with the phase
  const late = await call('PUT', '/api/auction/contract-duration', cookieAlpha, { playerId: poolIds[0], duration: 1 });
  assert.equal(late.statusCode, 409, 'duration pick only during the auction');

  // the new matchweek is live for the normal flow
  const mw = (await call('GET', '/api/matchweek/current', cookieAlpha)).json();
  assert.equal(mw.matchweek.number, 1);
  assert.ok(mw.fixture, 'own fixture exists in matchweek 1');
});
