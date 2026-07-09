/**
 * league-transfers.ts — the mid-season transfer window (the second market).
 *
 * Rules (DECISIONS.md):
 *  - Two markets only exist: the season-start auction and this one fixed
 *    mid-season week. This is NOT a second auction — inter-club transfers +
 *    fixed-price pool signings, open only while phase='transfer_window'.
 *    The window is the transfer BYE matchweek; its week-close is the deadline
 *    (league-orchestrator flips the phase back and expires pending offers).
 *  - Inter-club transfer: buyer offers a fee for a contracted player; the
 *    seller accepts/rejects. On accept the fee moves buyer→seller
 *    (transfer_fee txn) and the CONTRACT rides along unchanged — wage and
 *    duration transfer with the player. Rationale: duration never changes the
 *    weekly wage in our model, so there is nothing to renegotiate; re-deriving
 *    wage from market value would silently rewrite a contract the seller
 *    signed, and the buyer absorbing the existing wage is exactly what makes
 *    the wage-cap check meaningful.
 *  - Pool signing: fixed price = market value, wage = wageFromMarketValue,
 *    FIRST-COME under the player row lock. With the price fixed there is no
 *    dimension left to bid on — a sealed fee bid would reintroduce the
 *    auction this window explicitly is not — and instant resolution keeps
 *    squads knowable mid-window (you can plan transfers around a completed
 *    signing) with no deadline-resolution job or budget encumbrance.
 *  - Bounds reuse the auction's: buyer stays ≤ squadMax and under the wage
 *    cap and budget (now net of facility spend AND credited by own sales);
 *    the seller cannot drop below squadMin.
 *
 * Concurrency: accept locks the offer row, then the player's contract row,
 * then BOTH club_seasons rows in club-id order (the club_seasons row lock is
 * the club's money lock — facilities investment takes the same one). Pool
 * signings serialize on the players row lock. Offer-time checks are advisory;
 * accept-time re-validation under the locks is the enforcement.
 */

import type pg from 'pg';
import { LEAGUE_CFG, wageFromMarketValue } from '@fm/engine/config';
import * as store from './league-store.ts';

export class TransferError extends Error {
  readonly status: 404 | 409 | 422;
  readonly body: Record<string, unknown>;
  constructor(status: 404 | 409 | 422, body: { error: string } & Record<string, unknown>) {
    super(body.error);
    this.name = 'TransferError';
    this.status = status;
    this.body = body;
  }
}

export interface TransferTuning {
  squadMin?: number;
  squadMax?: number;
}

export interface TransferCoreOptions {
  pool: pg.Pool;
  tuning?: TransferTuning;
}

export interface TransferStateView {
  phase: string;
  windowOpen: boolean;
  deadlineAt: Date | null;
  you: {
    budgetRemaining: number;
    wageBill: number;
    wageCap: number;
    squadCount: number;
    squadMin: number;
    squadMax: number;
  };
  offers: store.OfferView[];
}

export interface MarketView {
  pool: Array<store.PoolPlayer & { wage: number }>;
  clubs: Array<{ clubId: string; name: string; you: boolean; players: store.MarketPlayerRow[] }>;
}

export interface TransferCore {
  state(viewerClubId: string): Promise<TransferStateView>;
  market(viewerClubId: string): Promise<MarketView>;
  makeOffer(buyerClubId: string, playerId: string, fee: number): Promise<{ offerId: string }>;
  respondOffer(sellerClubId: string, offerId: string, accept: boolean): Promise<void>;
  signPoolPlayer(clubId: string, playerId: string): Promise<void>;
}

export function createTransferCore(opts: TransferCoreOptions): TransferCore {
  const { pool } = opts;
  const squadMin = opts.tuning?.squadMin ?? LEAGUE_CFG.squadMin;
  const squadMax = opts.tuning?.squadMax ?? LEAGUE_CFG.squadMax;

  async function withTxn<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Transfers only exist in this phase — everywhere else the market is frozen. */
  async function windowSeason(c: store.Queryable): Promise<store.SeasonRow> {
    const season = await store.currentSeason(c);
    if (!season) throw new TransferError(409, { error: 'no_season' });
    if (season.phase !== 'transfer_window') {
      throw new TransferError(409, { error: 'window_closed', phase: season.phase });
    }
    return season;
  }

  /**
   * Money lock + wage cap for one club; club_seasons row lock when forUpdate.
   * The window spends the RESERVE (6b) — what the split held back — never
   * the auction pot.
   */
  async function clubEconomy(
    c: store.Queryable, seasonId: string, clubId: string, forUpdate: boolean,
  ): Promise<{ wageCap: number; remaining: number }> {
    const row = await store.getFacilities(c, seasonId, clubId, forUpdate);
    if (!row) throw new TransferError(404, { error: 'not_found' });
    const clubs = await store.clubsBySeed(c, seasonId);
    const wageCap = clubs.find((x) => x.clubId === clubId)?.wageCap ?? 0;
    return { wageCap, remaining: row.reserveBalance };
  }

  /** Buyer-side bounds shared by offers (advisory), accepts and pool signings. */
  async function checkBuyer(
    c: store.Queryable, seasonId: string, clubId: string, cost: number, wage: number,
  ): Promise<void> {
    if ((await store.squadCount(c, seasonId, clubId)) >= squadMax) {
      throw new TransferError(422, { error: 'squad_full', squadMax });
    }
    const { wageCap, remaining } = await clubEconomy(c, seasonId, clubId, false);
    if (cost > remaining) throw new TransferError(422, { error: 'over_budget', cost, remaining });
    const wageBill = await store.activeWageSum(c, clubId);
    if (wageBill + wage > wageCap) throw new TransferError(422, { error: 'wage_cap', wage, wageCap });
  }

  async function makeOffer(buyerClubId: string, playerId: string, fee: number): Promise<{ offerId: string }> {
    if (!Number.isInteger(fee) || fee <= 0) throw new TransferError(422, { error: 'bad_fee' });
    return withTxn(async (c) => {
      const season = await windowSeason(c);
      const contract = await store.activeContract(c, playerId);
      if (!contract) throw new TransferError(404, { error: 'not_contracted' });
      if (contract.clubId === buyerClubId) throw new TransferError(409, { error: 'own_player' });

      // advisory checks — accept-time re-validation under locks is the law
      await checkBuyer(c, season.id, buyerClubId, fee, contract.wage);
      if ((await store.squadCount(c, season.id, contract.clubId)) <= squadMin) {
        throw new TransferError(422, { error: 'seller_at_floor', squadMin });
      }
      const offerId = await store.upsertPendingOffer(c, season.id, playerId, buyerClubId, contract.clubId, fee);
      return { offerId };
    });
  }

  async function respondOffer(sellerClubId: string, offerId: string, accept: boolean): Promise<void> {
    // a stale offer is EXPIRED and the caller told — the expiry must commit,
    // so it is an outcome of the transaction, not an exception inside it
    const outcome = await withTxn(async (c) => {
      const season = await windowSeason(c);
      const offer = await store.getOffer(c, offerId, true); // offer row lock: one resolution
      if (!offer || offer.sellerClubId !== sellerClubId || offer.seasonId !== season.id) {
        throw new TransferError(404, { error: 'not_found' });
      }
      if (offer.status !== 'pending') throw new TransferError(409, { error: 'offer_resolved', status: offer.status });

      if (!accept) {
        await store.resolveOffer(c, offerId, 'rejected');
        return 'done' as const;
      }

      // contract row lock serializes moves of this player; club_seasons locks
      // in club-id order are the money/roster locks for both sides
      const contract = await store.activeContract(c, offer.playerId, true);
      if (!contract || contract.clubId !== sellerClubId) {
        await store.resolveOffer(c, offerId, 'expired');
        return 'player_moved' as const;
      }
      for (const clubId of [offer.buyerClubId, sellerClubId].sort()) {
        await clubEconomy(c, season.id, clubId, true);
      }
      if ((await store.squadCount(c, season.id, sellerClubId)) <= squadMin) {
        throw new TransferError(422, { error: 'seller_at_floor', squadMin });
      }
      await checkBuyer(c, season.id, offer.buyerClubId, offer.fee, contract.wage);

      await store.transferPlayer(
        c, season.id, offer.playerId, offer.buyerClubId, sellerClubId, offer.fee, LEAGUE_CFG.sharpnessColdStart,
      );
      await store.resolveOffer(c, offerId, 'accepted');
      await store.expirePendingOffersForPlayer(c, season.id, offer.playerId, offerId);
      return 'done' as const;
    });
    if (outcome === 'player_moved') throw new TransferError(409, { error: 'player_moved' });
  }

  async function signPoolPlayer(clubId: string, playerId: string): Promise<void> {
    await withTxn(async (c) => {
      const season = await windowSeason(c);
      const player = await store.lockPlayer(c, playerId); // first-come serializes here
      if (!player) throw new TransferError(404, { error: 'not_found' });
      if (await store.activeContract(c, playerId)) throw new TransferError(409, { error: 'not_free' });

      await clubEconomy(c, season.id, clubId, true); // money lock
      const wage = wageFromMarketValue(player.marketValue);
      await checkBuyer(c, season.id, clubId, player.marketValue, wage);
      await store.signFromPool(
        c, season.id, clubId, playerId, wage, LEAGUE_CFG.transferContractDuration, player.marketValue,
      );
    });
  }

  async function state(viewerClubId: string): Promise<TransferStateView> {
    const season = await store.currentSeason(pool);
    if (!season) throw new TransferError(409, { error: 'no_season' });
    const windowOpen = season.phase === 'transfer_window';

    // the window IS the transfer bye matchweek — its deadline is the clock
    const mw = await store.currentMatchweek(pool, season.id);
    const deadlineAt = windowOpen && mw?.kind === 'transfer' ? mw.deadlineAt : null;

    const { wageCap, remaining } = await clubEconomy(pool, season.id, viewerClubId, false);
    return {
      phase: season.phase,
      windowOpen,
      deadlineAt,
      you: {
        budgetRemaining: remaining,
        wageBill: await store.activeWageSum(pool, viewerClubId),
        wageCap,
        squadCount: await store.squadCount(pool, season.id, viewerClubId),
        squadMin,
        squadMax,
      },
      offers: await store.listOffers(pool, season.id, viewerClubId),
    };
  }

  async function market(viewerClubId: string): Promise<MarketView> {
    const season = await store.currentSeason(pool);
    if (!season) throw new TransferError(409, { error: 'no_season' });
    const pool_ = await store.poolPlayers(pool, season.id);
    const clubs = await store.contractedSquads(pool, season.id);
    return {
      pool: pool_.map((p) => ({ ...p, wage: wageFromMarketValue(p.marketValue) })),
      clubs: clubs.map((cl) => ({ ...cl, you: cl.clubId === viewerClubId })),
    };
  }

  return { state, market, makeOffer, respondOffer, signPoolPlayer };
}
