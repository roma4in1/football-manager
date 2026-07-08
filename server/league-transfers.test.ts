/**
 * league-transfers.test.ts — the mid-season transfer window: phase
 * choreography through the SQL state machine (regular → transfer_window at
 * the pre-transfer week close, back at the transfer week's own close),
 * inter-club offers (contract rides along unchanged), first-come pool
 * signings, bounds/budget/wage enforcement, familiarity-cold moves, and the
 * bye-week tick.
 *
 * Tests share one seeded league and RUN IN ORDER (node --test is sequential
 * per file): freeze-check → window opens → market activity → window closes.
 *
 *   npm run db:test:up && node --test league-transfers.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { LEAGUE_CFG, wageFromMarketValue } from '@fm/engine/config';
import { createApi, SESSION_COOKIE, type LinkDelivery } from './league-api.ts';
import { createCore, createOrchestrator, type Orchestrator, type OrchestratorCore } from './league-orchestrator.ts';
import { createTransferCore, TransferError } from './league-transfers.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, seedClub, seedPoolPlayers, seedSeason } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const SECRET = 'transfers-test-secret';

let pool: pg.Pool;
let orch: Orchestrator;
let core: OrchestratorCore;
let api: FastifyInstance;
let seasonId: string;
let clubA: string, clubB: string;
let playersA: string[], playersB: string[];
let betaExtra: string; // Beta's 14th player — the one Beta can afford to sell
let cookieA: string, cookieB: string;
let mwRegular: string, mwTransfer: string; // week 1 (regular) + week 2 (transfer bye)

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

type Call = { method: 'GET' | 'POST'; url: string; payload?: unknown; as: string };
const call = ({ method, url, payload, as }: Call) =>
  api.inject({
    method,
    url,
    cookies: { [SESSION_COOKIE]: as },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const seasonPhase = async (): Promise<string> =>
  (await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase;

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool); // phase 'regular', legal path
  ({ clubId: clubA, playerIds: playersA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@tw.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub(pool, seasonId, 'Beta', 'beta@tw.io'));

  // Beta's 14th player: one above squadMin (13), so exactly one sale is legal.
  // Distinct fatigue so the transfer test can assert per-season state rides along.
  const extra = await q(
    `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, market_value, attributes, physical)
     VALUES ('Beta Extra', '1999-05-05', 'MF', 181, 77, 2000000, '{}', '{"injuryProneness": 10}') RETURNING id`,
  );
  betaExtra = extra.rows[0].id as string;
  await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 150, 3)`,
    [betaExtra, clubB, seasonId]);
  await q(`INSERT INTO squad_players (club_id, season_id, player_id, fatigue) VALUES ($1, $2, $3, 0.35)`,
    [clubB, seasonId, betaExtra]);

  // the calendar around the window: week 1 (regular, deadline passed, no
  // fixtures) and week 2 (the transfer bye, open for a day)
  mwRegular = await store.insertMatchweek(
    pool, seasonId, 1, 'regular', new Date(Date.now() - 7_200_000), new Date(Date.now() - 60_000),
  );
  mwTransfer = await store.insertMatchweek(
    pool, seasonId, 2, 'transfer', new Date(Date.now() - 60_000), new Date(Date.now() + 86_400_000),
  );

  core = createCore({ pool });
  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 0.5 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET, delivery });
  cookieA = await login('alpha@tw.io');
  cookieB = await login('beta@tw.io');
});

after(async () => {
  await api?.close();
  await orch?.stop();
  await pool?.end();
});

// ── frozen outside the window ────────────────────────────────────────────────

test('market is frozen while the season is regular: every action 409s', async () => {
  const offer = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: betaExtra, fee: 5000 }, as: cookieA });
  assert.equal(offer.statusCode, 409);
  assert.equal(offer.json().error, 'window_closed');
  const sign = await call({ method: 'POST', url: '/api/transfer/sign', payload: { playerId: betaExtra }, as: cookieA });
  assert.equal(sign.statusCode, 409);

  const state = (await call({ method: 'GET', url: '/api/transfer/state', as: cookieA })).json();
  assert.equal(state.windowOpen, false);
  assert.equal(state.deadlineAt, null);
});

// ── the window opens at the pre-transfer week close ──────────────────────────

test('closing the last pre-transfer matchweek opens the window (regular → transfer_window)', async () => {
  assert.equal(await core.runWeekClose(mwRegular), 'closed');
  assert.equal(await seasonPhase(), 'transfer_window');

  const state = (await call({ method: 'GET', url: '/api/transfer/state', as: cookieA })).json();
  assert.equal(state.windowOpen, true);
  assert.ok(state.deadlineAt, 'the transfer bye matchweek deadline is the window clock');
  assert.equal(state.you.squadCount, 13);
  assert.equal(state.you.budgetRemaining, 100_000);
});

// ── pool signings ────────────────────────────────────────────────────────────

let cheapPool: string[]; // two cheap free agents

test('pool signing: fixed price = market value, wage = g(mv), txn recorded', async () => {
  cheapPool = await seedPoolPlayers(pool, 2, 'Free');
  await q(`UPDATE players SET market_value = 8000 WHERE id = ANY($1)`, [cheapPool]);

  const market = (await call({ method: 'GET', url: '/api/transfer/market', as: cookieA })).json();
  assert.equal(market.pool.length, 2);
  assert.equal(market.pool[0].wage, wageFromMarketValue(8000));
  assert.equal(market.clubs.length, 2);
  assert.ok(market.clubs.some((c: { you: boolean }) => c.you));

  const res = await call({ method: 'POST', url: '/api/transfer/sign', payload: { playerId: cheapPool[0] }, as: cookieA });
  assert.equal(res.statusCode, 204);

  const contract = await q(`SELECT club_id, wage, duration FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [cheapPool[0]]);
  assert.equal(contract.rows[0].club_id, clubA);
  assert.equal(Number(contract.rows[0].wage), wageFromMarketValue(8000));
  assert.equal(contract.rows[0].duration, LEAGUE_CFG.transferContractDuration);
  const squad = await q(`SELECT club_id FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, cheapPool[0]]);
  assert.equal(squad.rows[0].club_id, clubA);
  const txn = await q(`SELECT amount FROM transactions WHERE kind = 'pool_signing' AND player_id = $1`, [cheapPool[0]]);
  assert.equal(Number(txn.rows[0].amount), 8000);

  const state = (await call({ method: 'GET', url: '/api/transfer/state', as: cookieA })).json();
  assert.equal(state.you.budgetRemaining, 100_000 - 8000);
  assert.equal(state.you.squadCount, 14);
});

// ── inter-club transfer ──────────────────────────────────────────────────────

let acceptedOfferId: string;

test('offer → accept: fee moves buyer→seller, contract and season state ride along, familiarity cold', async () => {
  // pre-existing dyad at Beta involving the outgoing player — must be wiped
  const [fa, fb] = [betaExtra, playersB[3]].sort();
  await q(`INSERT INTO familiarity (club_id, season_id, player_a, player_b, value) VALUES ($1, $2, $3, $4, 0.6)`,
    [clubB, seasonId, fa, fb]);

  // fatigue as it stands NOW (the week-1 close already ticked recovery) —
  // the move must carry this exact value to the new club
  const fatigueBefore = Number((await q(
    `SELECT fatigue FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, betaExtra],
  )).rows[0].fatigue);
  assert.ok(fatigueBefore > 0, 'precondition: some fatigue to carry');

  const offer = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: betaExtra, fee: 5000 }, as: cookieA });
  assert.equal(offer.statusCode, 200);
  acceptedOfferId = offer.json().offerId;

  // the seller sees it pending; a non-seller cannot resolve it
  const betaState = (await call({ method: 'GET', url: '/api/transfer/state', as: cookieB })).json();
  const pending = betaState.offers.find((o: { id: string }) => o.id === acceptedOfferId);
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.playerName, 'Beta Extra');
  const notSeller = await call({ method: 'POST', url: `/api/transfer/offer/${acceptedOfferId}/accept`, as: cookieA });
  assert.equal(notSeller.statusCode, 404, 'only the addressed seller resolves an offer');

  const accepted = await call({ method: 'POST', url: `/api/transfer/offer/${acceptedOfferId}/accept`, as: cookieB });
  assert.equal(accepted.statusCode, 204);

  // contract transferred UNCHANGED: wage 150, duration 3 (DECISIONS.md wage rule)
  const contract = await q(`SELECT club_id, wage, duration FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [betaExtra]);
  assert.equal(contract.rows[0].club_id, clubA);
  assert.equal(Number(contract.rows[0].wage), 150);
  assert.equal(contract.rows[0].duration, 3);

  // per-season state rides along (PK is (season, player) — club_id flips)
  const squad = await q(`SELECT club_id, fatigue FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, betaExtra]);
  assert.equal(squad.rows[0].club_id, clubA);
  assert.ok(Math.abs(Number(squad.rows[0].fatigue) - fatigueBefore) < 1e-6, 'fatigue is the player\'s, not the club\'s');

  // fee txn: buyer debited, seller credited
  const txn = await q(`SELECT club_id, to_club_id, amount FROM transactions WHERE kind = 'transfer_fee' AND player_id = $1`, [betaExtra]);
  assert.equal(txn.rowCount, 1);
  assert.equal(txn.rows[0].club_id, clubA);
  assert.equal(txn.rows[0].to_club_id, clubB);
  assert.equal(Number(txn.rows[0].amount), 5000);

  // familiarity-cold: dyads at the selling club wiped, none at the buying club
  const fam = await q(`SELECT count(*) FROM familiarity WHERE season_id = $1 AND (player_a = $2 OR player_b = $2)`, [seasonId, betaExtra]);
  assert.equal(Number(fam.rows[0].count), 0, 'a club change is familiarity-cold everywhere');

  // budget is bidirectional: the sale funds the seller
  const alpha = (await call({ method: 'GET', url: '/api/transfer/state', as: cookieA })).json();
  assert.equal(alpha.you.budgetRemaining, 100_000 - 8000 - 5000);
  const beta = (await call({ method: 'GET', url: '/api/transfer/state', as: cookieB })).json();
  assert.equal(beta.you.budgetRemaining, 100_000 + 5000);
  // ...and facilities sees the same spendable number (one budget, one rule)
  const betaFac = (await call({ method: 'GET', url: '/api/facilities', as: cookieB })).json();
  assert.equal(betaFac.budgetRemaining, 100_000 + 5000);
});

test('accepting an offer is blocked when the seller is at the squad floor', async () => {
  // Beta is back at 13 = squadMin: offering for any Beta player is refused
  const res = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersB[5], fee: 2000 }, as: cookieA });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'seller_at_floor');
});

test('reject: offer resolved, nothing moves, re-resolution 409s', async () => {
  const offer = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[7], fee: 3000 }, as: cookieB });
  assert.equal(offer.statusCode, 200);
  const offerId = offer.json().offerId;

  const rejected = await call({ method: 'POST', url: `/api/transfer/offer/${offerId}/reject`, as: cookieA });
  assert.equal(rejected.statusCode, 204);

  const row = await q(`SELECT status, resolved_at FROM transfer_offers WHERE id = $1`, [offerId]);
  assert.equal(row.rows[0].status, 'rejected');
  assert.ok(row.rows[0].resolved_at);
  const contract = await q(`SELECT club_id FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [playersA[7]]);
  assert.equal(contract.rows[0].club_id, clubA, 'rejection moves nothing');

  const again = await call({ method: 'POST', url: `/api/transfer/offer/${offerId}/accept`, as: cookieA });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'offer_resolved');
});

test('re-offering replaces the pending fee instead of stacking offers', async () => {
  const first = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[8], fee: 1000 }, as: cookieB });
  const second = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[8], fee: 2500 }, as: cookieB });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().offerId, first.json().offerId, 'same pending row');
  const rows = await q(
    `SELECT fee FROM transfer_offers WHERE season_id = $1 AND player_id = $2 AND buyer_club_id = $3 AND status = 'pending'`,
    [seasonId, playersA[8], clubB],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(Number(rows.rows[0].fee), 2500);
  await call({ method: 'POST', url: `/api/transfer/offer/${second.json().offerId}/reject`, as: cookieA });
});

test('buyer constraints: own player, over budget, wage cap, squad cap', async () => {
  const own = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[2], fee: 1000 }, as: cookieA });
  assert.equal(own.statusCode, 409);
  assert.equal(own.json().error, 'own_player');

  const rich = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[2], fee: 10_000_000 }, as: cookieB });
  assert.equal(rich.statusCode, 422);
  assert.equal(rich.json().error, 'over_budget');

  // wage cap: Beta's bill is 13 × 100 — a cap just above it can't absorb a 100-wage signing
  await q(`UPDATE club_seasons SET wage_cap = 1350 WHERE club_id = $1 AND season_id = $2`, [clubB, seasonId]);
  const capped = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[2], fee: 1000 }, as: cookieB });
  assert.equal(capped.statusCode, 422);
  assert.equal(capped.json().error, 'wage_cap');
  await q(`UPDATE club_seasons SET wage_cap = 10000 WHERE club_id = $1 AND season_id = $2`, [clubB, seasonId]);

  // squad cap, at the core with tuned bounds (defaults would need 18 signings)
  const tuned = createTransferCore({ pool, tuning: { squadMax: 13 } });
  await assert.rejects(tuned.makeOffer(clubB, playersA[2], 1000), (err: unknown) => {
    assert.ok(err instanceof TransferError);
    assert.equal(err.body.error, 'squad_full');
    return true;
  });
});

test('a stale offer expires on response: the player already moved', async () => {
  const offer = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: playersA[9], fee: 1200 }, as: cookieB });
  assert.equal(offer.statusCode, 200);
  const offerId = offer.json().offerId;

  // the player moves under the offer (as if a rival's bid landed first) —
  // contract AND per-season row, the same two writes a real transfer makes
  await q(`UPDATE contracts SET club_id = $2 WHERE player_id = $1 AND released_at IS NULL`, [playersA[9], clubB]);
  await q(`UPDATE squad_players SET club_id = $3 WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[9], clubB]);

  const res = await call({ method: 'POST', url: `/api/transfer/offer/${offerId}/accept`, as: cookieA });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'player_moved');
  const row = await q(`SELECT status FROM transfer_offers WHERE id = $1`, [offerId]);
  assert.equal(row.rows[0].status, 'expired', 'the stale offer is expired, and that expiry COMMITS');
});

// ── contested pool player: first-come under the player row lock ──────────────

test('two clubs race for the same free agent: exactly one signs, the loser 409s', async () => {
  const target = cheapPool[1];
  const [a, b] = await Promise.all([
    call({ method: 'POST', url: '/api/transfer/sign', payload: { playerId: target }, as: cookieA }),
    call({ method: 'POST', url: '/api/transfer/sign', payload: { playerId: target }, as: cookieB }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [204, 409], `got ${a.statusCode}/${b.statusCode}`);
  assert.equal((a.statusCode === 409 ? a : b).json().error, 'not_free');

  const contracts = await q(`SELECT count(*) FROM contracts WHERE player_id = $1 AND released_at IS NULL`, [target]);
  assert.equal(Number(contracts.rows[0].count), 1, 'one contract, no double signing');
  const txns = await q(`SELECT count(*) FROM transactions WHERE kind = 'pool_signing' AND player_id = $1`, [target]);
  assert.equal(Number(txns.rows[0].count), 1);

  // the loser retrying deterministically 409s
  const loser = a.statusCode === 409 ? cookieA : cookieB;
  const retry = await call({ method: 'POST', url: '/api/transfer/sign', payload: { playerId: target }, as: loser });
  assert.equal(retry.statusCode, 409);
});

// ── the window closes at its own deadline ────────────────────────────────────

test('transfer week close: bye tick runs, pending offers expire, phase returns to regular', async () => {
  // a live offer that must die with the window (Beta has 14 now — can sell)
  const beta14 = (await q(
    `SELECT player_id FROM squad_players WHERE season_id = $1 AND club_id = $2 LIMIT 1`, [seasonId, clubB],
  )).rows[0].player_id;
  const offer = await call({ method: 'POST', url: '/api/transfer/offer', payload: { playerId: beta14, fee: 900 }, as: cookieA });
  assert.equal(offer.statusCode, 200);

  // tick preconditions: fatigue, a healing injury, an unserved ban
  await q(`UPDATE squad_players SET fatigue = 0.5 WHERE season_id = $1`, [seasonId]);
  await q(`UPDATE squad_players SET injury_weeks_left = 2 WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[3]]);
  await q(`UPDATE squad_players SET suspended_next = TRUE WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[4]]);

  await q(`UPDATE matchweeks SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [mwTransfer]);
  assert.equal(await core.runWeekClose(mwTransfer), 'closed');

  assert.equal(await seasonPhase(), 'regular', 'deadline auto-advance: transfer_window → regular');
  const mw = await q(`SELECT revealed_at FROM matchweeks WHERE id = $1`, [mwTransfer]);
  assert.ok(mw.rows[0].revealed_at, 'the bye week reveals like any other');

  const pending = await q(`SELECT count(*) FROM transfer_offers WHERE season_id = $1 AND status = 'pending'`, [seasonId]);
  assert.equal(Number(pending.rows[0].count), 0, 'nothing stays pending past the deadline');
  assert.equal(
    (await q(`SELECT status FROM transfer_offers WHERE id = $1`, [offer.json().offerId])).rows[0].status,
    'expired',
  );

  // bye-week tick: recovery + healing run, the ban is NOT consumed
  const fatigue = await q(`SELECT fatigue FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[0]]);
  assert.ok(Number(fatigue.rows[0].fatigue) < 0.5, 'fatigue recovers over the bye');
  const injury = await q(`SELECT injury_weeks_left FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[3]]);
  assert.equal(injury.rows[0].injury_weeks_left, 1, 'injuries heal over the bye');
  const ban = await q(`SELECT suspended_next FROM squad_players WHERE season_id = $1 AND player_id = $2`, [seasonId, playersA[4]]);
  assert.equal(ban.rows[0].suspended_next, true, 'a bye does not serve a one-match ban');

  // and the market is frozen again
  const late = await call({ method: 'POST', url: '/api/transfer/sign', payload: { playerId: cheapPool[0] }, as: cookieB });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'window_closed');
});
