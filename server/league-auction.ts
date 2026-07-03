/**
 * league-auction.ts — season-start open ascending auction.
 *
 * Rules (DECISIONS.md):
 *  - One lot live at a time, league-wide visible. Nomination order is a snake
 *    over reverse seed order; seed v1 = club name ascending (no rankings yet).
 *  - Lot lifecycle: nominate → live for auctionLotSeconds; any bid landing
 *    with less than auctionSoftCloseSeconds left extends the close to
 *    now + auctionSoftCloseSeconds. Timer fires via pg-boss ('auction-close');
 *    an extended lot's early timer no-ops on the closes_at re-check.
 *  - Winner signs at wage = wageFromMarketValue(mv), duration =
 *    auctionDefaultContractDuration, adjustable 1–4 while phase='auction'
 *    (no schema slot for a per-bid duration — see DECISIONS.md).
 *  - Wage-cap breach at close ⇒ FORFEIT + re-lot: no contract, no payment,
 *    the player returns to the pool. Bid-time checks make this rare.
 *  - Unsold/forfeited lots are re-nominated by RE-OPENING the same row
 *    (UNIQUE(season, player)); only bids from the current opening count.
 *  - Completion: no live lot and every club at squadMin ⇒ season →
 *    'regular' (state machine trigger), double round-robin schedule generated,
 *    transfer week inserted after seasons.transfer_week (clamped), week-close
 *    timers armed. No pass mechanism in v1 — the auction runs until the last
 *    club reaches squadMin.
 *
 * Concurrency: nominations serialize on the seasons row lock; bids serialize
 * on the lot row lock (FOR UPDATE) — a losing race surfaces as 409 with the
 * current high bid.
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { LEAGUE_CFG, wageFromMarketValue } from '@fm/engine/config';
import * as store from './league-store.ts';

export class AuctionError extends Error {
  readonly status: 404 | 409 | 422;
  readonly body: Record<string, unknown>;
  constructor(status: 404 | 409 | 422, body: { error: string } & Record<string, unknown>) {
    super(body.error);
    this.name = 'AuctionError';
    this.status = status;
    this.body = body;
  }
}

// ── pure pieces ──────────────────────────────────────────────────────────────

/** Snake over reverse seed order: worst seed opens, order flips each round. */
export function snakeNominator(clubIdsBySeed: string[], lotIndex: number): string {
  const n = clubIdsBySeed.length;
  const round = Math.floor(lotIndex / n);
  const reversed = [...clubIdsBySeed].reverse();
  const order = round % 2 === 0 ? reversed : clubIdsBySeed;
  return order[lotIndex % n];
}

export interface Pairing { home: string; away: string }

/** Double round-robin via the circle method; odd club counts get a bye. */
export function doubleRoundRobin(clubIds: string[]): Pairing[][] {
  const teams: Array<string | null> = [...clubIds];
  if (teams.length % 2 === 1) teams.push(null);
  const n = teams.length;
  const rounds = n - 1;
  const rot = teams.slice(1);
  const firstLeg: Pairing[][] = [];
  for (let r = 0; r < rounds; r++) {
    const arr = [teams[0], ...rot];
    const pairs: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a && b) pairs.push(r % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
    }
    firstLeg.push(pairs);
    rot.push(rot.shift()!);
  }
  const secondLeg = firstLeg.map((pairs) => pairs.map(({ home, away }) => ({ home: away, away: home })));
  return [...firstLeg, ...secondLeg];
}

// ── core ─────────────────────────────────────────────────────────────────────

export interface AuctionTuning {
  lotSeconds?: number;
  softCloseSeconds?: number;
  squadMin?: number;
  squadMax?: number;
}

export interface AuctionCoreOptions {
  pool: pg.Pool;
  /** Arm the pg-boss close timer for a lot (orchestrator provides). */
  armClose: (lotId: string, at: Date) => Promise<void>;
  /** Arm week-close timers for generated matchweeks (orchestrator provides). */
  scheduleWeekClose: (matchweekId: string) => Promise<void>;
  tuning?: AuctionTuning;
}

export interface AuctionStateView {
  phase: string;
  lot: {
    lotId: string;
    player: store.PoolPlayer;
    opensAt: Date;
    closesAt: Date;
    highBid: { clubId: string; clubName: string; amount: number } | null;
  } | null;
  turn: { clubId: string; name: string; you: boolean } | null;
  clubs: Array<{ clubId: string; name: string; remaining: number; squadCount: number; you: boolean }>;
  you: { remaining: number; squadCount: number; wageBill: number; wageCap: number };
  signings: store.OwnSigning[];
  squadMin: number;
  squadMax: number;
}

export interface AuctionCore {
  state(viewerClubId: string): Promise<AuctionStateView>;
  poolPlayers(): Promise<store.PoolPlayer[]>;
  nominate(clubId: string, playerId: string): Promise<{ lotId: string; closesAt: Date }>;
  bid(clubId: string, lotId: string, amount: number): Promise<{ closesAt: Date }>;
  closeLot(lotId: string): Promise<'won' | 'forfeited' | 'unsold' | 'skipped' | 'completed'>;
  setDuration(clubId: string, playerId: string, duration: number): Promise<void>;
}

export function createAuctionCore(opts: AuctionCoreOptions): AuctionCore {
  const { pool, armClose, scheduleWeekClose } = opts;
  const lotSeconds = opts.tuning?.lotSeconds ?? LEAGUE_CFG.auctionLotSeconds;
  const softCloseSeconds = opts.tuning?.softCloseSeconds ?? LEAGUE_CFG.auctionSoftCloseSeconds;
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

  async function auctionSeason(c: store.Queryable): Promise<store.SeasonRow> {
    const season = await store.currentSeason(c);
    if (!season) throw new AuctionError(409, { error: 'no_season' });
    if (season.phase !== 'auction') throw new AuctionError(409, { error: 'wrong_phase', phase: season.phase });
    return season;
  }

  async function playerById(c: store.Queryable, seasonId: string, playerId: string): Promise<store.PoolPlayer> {
    const inPool = (await store.poolPlayers(c, seasonId)).find((p) => p.playerId === playerId);
    if (!inPool) throw new AuctionError(404, { error: 'not_in_pool' });
    return inPool;
  }

  async function nominate(clubId: string, playerId: string): Promise<{ lotId: string; closesAt: Date }> {
    const armed = await withTxn(async (c) => {
      const season = await auctionSeason(c);
      // seasons row lock serializes nominations league-wide
      await store.getSeasonRow(c, season.id, true);
      if (await store.liveLot(c, season.id)) throw new AuctionError(409, { error: 'lot_live' });

      const clubs = await store.clubsBySeed(c, season.id);
      const turn = snakeNominator(clubs.map((x) => x.clubId), await store.lotCount(c, season.id));
      if (turn !== clubId) throw new AuctionError(409, { error: 'not_your_turn', turnClubId: turn });

      const player = await playerById(c, season.id, playerId);
      const now = await store.dbNow(c);
      const closesAt = new Date(now.getTime() + lotSeconds * 1000);
      const existing = await store.lotForPlayer(c, season.id, player.playerId);
      let lotId: string;
      if (existing) {
        if (existing.wonBy) throw new AuctionError(409, { error: 'already_sold' });
        await store.reopenLot(c, existing.id, now, closesAt); // failed lot re-opens; old bids don't count
        lotId = existing.id;
      } else {
        lotId = await store.insertLot(c, season.id, player.playerId, now, closesAt);
      }
      return { lotId, closesAt };
    });
    await armClose(armed.lotId, armed.closesAt);
    return armed;
  }

  async function bid(clubId: string, lotId: string, amount: number): Promise<{ closesAt: Date }> {
    const out = await withTxn(async (c) => {
      const lot = await store.getLot(c, lotId, true); // row lock serializes bids per lot
      if (!lot) throw new AuctionError(404, { error: 'not_found' });
      const now = await store.dbNow(c);
      if (lot.wonBy || now >= lot.closesAt || now < lot.opensAt) {
        throw new AuctionError(409, { error: 'lot_closed' });
      }

      const high = await store.highBid(c, lotId, lot.opensAt);
      const minimum = (high?.amount ?? 0) + LEAGUE_CFG.bidIncrementMin;
      if (!Number.isInteger(amount) || amount < minimum) {
        // covers the simultaneous-bid race: second txn sees the first bid
        throw new AuctionError(409, { error: 'outbid', highBid: high?.amount ?? 0, minimum });
      }

      const clubs = await store.clubsBySeed(c, lot.seasonId);
      const club = clubs.find((x) => x.clubId === clubId);
      if (!club) throw new AuctionError(404, { error: 'not_found' });
      const remaining = club.transferBudget - (await store.auctionSpend(c, lot.seasonId, clubId));
      if (amount > remaining) throw new AuctionError(422, { error: 'over_budget', remaining });
      if ((await store.squadCount(c, lot.seasonId, clubId)) >= squadMax) {
        throw new AuctionError(422, { error: 'squad_full', squadMax });
      }
      const player = (await c.query(`SELECT market_value FROM players WHERE id = $1`, [lot.playerId])).rows[0];
      const wage = wageFromMarketValue(Number(player.market_value));
      if ((await store.activeWageSum(c, clubId)) + wage > club.wageCap) {
        throw new AuctionError(422, { error: 'wage_cap', wage, wageCap: club.wageCap });
      }

      await store.insertBid(c, lotId, clubId, amount);
      // soft close: late bids extend the window
      let closesAt = lot.closesAt;
      if (lot.closesAt.getTime() - now.getTime() < softCloseSeconds * 1000) {
        closesAt = new Date(now.getTime() + softCloseSeconds * 1000);
        await store.extendLot(c, lotId, closesAt);
      }
      return { closesAt, extended: closesAt.getTime() !== lot.closesAt.getTime() };
    });
    if (out.extended) await armClose(lotId, out.closesAt);
    return { closesAt: out.closesAt };
  }

  async function closeLot(lotId: string): Promise<'won' | 'forfeited' | 'unsold' | 'skipped' | 'completed'> {
    const result = await withTxn(async (c) => {
      const lot = await store.getLot(c, lotId, true);
      if (!lot || lot.wonBy) return 'skipped' as const;
      const now = await store.dbNow(c);
      if (lot.closesAt > now) return 'skipped' as const; // extended — a later timer owns it

      const high = await store.highBid(c, lotId, lot.opensAt);
      if (!high) return 'unsold' as const; // player silently returns to the pool

      const clubs = await store.clubsBySeed(c, lot.seasonId);
      const winner = clubs.find((x) => x.clubId === high.clubId)!;
      const mv = Number((await c.query(`SELECT market_value FROM players WHERE id = $1`, [lot.playerId])).rows[0].market_value);
      const wage = wageFromMarketValue(mv);
      const wageBill = await store.activeWageSum(c, high.clubId);
      const count = await store.squadCount(c, lot.seasonId, high.clubId);
      if (wageBill + wage > winner.wageCap || count >= squadMax) {
        return 'forfeited' as const; // DECISIONS.md: forfeit + re-lot, cap stays hard
      }

      await store.signPlayer(
        c, lot.seasonId, high.clubId, lot.playerId, wage, LEAGUE_CFG.auctionDefaultContractDuration, high.amount,
      );
      await store.setLotWinner(c, lotId, high.clubId);
      return 'won' as const;
    });
    if (result === 'skipped') return result;
    const completed = await maybeComplete();
    return completed ? 'completed' : result;
  }

  /** Auction ends when no lot is live and every club has reached squadMin. */
  async function maybeComplete(): Promise<boolean> {
    const generated = await withTxn(async (c) => {
      const season = await store.currentSeason(c);
      if (!season || season.phase !== 'auction') return null;
      const row = await store.getSeasonRow(c, season.id, true);
      if (!row || row.phase !== 'auction') return null;
      if (await store.liveLot(c, season.id)) return null;

      const clubs = await store.clubsBySeed(c, season.id);
      const counts = await store.squadCounts(c, season.id);
      if (!clubs.every((club) => (counts.get(club.clubId) ?? 0) >= squadMin)) return null;

      // schedule: double round-robin in seed order, weekly cadence from now
      const schedule = doubleRoundRobin(clubs.map((x) => x.clubId));
      const rounds = schedule.length;
      const transferAfter = Math.max(1, Math.min(row.transferWeek, rounds - 1));
      await store.updateSeasonSchedule(c, season.id, rounds, transferAfter);

      const cadenceMs = LEAGUE_CFG.matchweekCadenceDays * 86_400_000;
      const start = await store.dbNow(c);
      const matchweekIds: string[] = [];
      let number = 0;
      let cursor = start;
      const addWeek = async (kind: 'regular' | 'transfer'): Promise<string> => {
        number += 1;
        const deadline = new Date(cursor.getTime() + cadenceMs);
        const id = await store.insertMatchweek(c, season.id, number, kind, cursor, deadline);
        cursor = deadline;
        matchweekIds.push(id);
        return id;
      };
      for (let r = 0; r < rounds; r++) {
        const mwId = await addWeek('regular');
        for (const { home, away } of schedule[r]) {
          await store.insertFixture(c, mwId, home, away, randomUUID());
        }
        if (r + 1 === transferAfter) await addWeek('transfer'); // bye — no fixtures
      }

      await store.transitionSeason(c, season.id, 'regular'); // guarded by the SQL state machine
      return matchweekIds;
    });
    if (!generated) return false;
    for (const mwId of generated) await scheduleWeekClose(mwId);
    return true;
  }

  async function state(viewerClubId: string): Promise<AuctionStateView> {
    const season = await store.currentSeason(pool);
    if (!season) throw new AuctionError(409, { error: 'no_season' });
    const clubs = await store.clubsBySeed(pool, season.id);
    const counts = await store.squadCounts(pool, season.id);
    const names = new Map(clubs.map((x) => [x.clubId, x.name]));

    const lot = season.phase === 'auction' ? await store.liveLot(pool, season.id) : null;
    let lotView: AuctionStateView['lot'] = null;
    if (lot) {
      const player = (await store.poolPlayers(pool, season.id)).find((p) => p.playerId === lot.playerId)
        ?? await loadLotPlayer(lot.playerId);
      const high = await store.highBid(pool, lot.id, lot.opensAt);
      lotView = {
        lotId: lot.id,
        player,
        opensAt: lot.opensAt,
        closesAt: lot.closesAt,
        highBid: high ? { clubId: high.clubId, clubName: names.get(high.clubId) ?? '?', amount: high.amount } : null,
      };
    }

    let turn: AuctionStateView['turn'] = null;
    if (season.phase === 'auction' && !lot) {
      const turnClubId = snakeNominator(clubs.map((x) => x.clubId), await store.lotCount(pool, season.id));
      turn = { clubId: turnClubId, name: names.get(turnClubId) ?? '?', you: turnClubId === viewerClubId };
    }

    const clubViews = [];
    let you: AuctionStateView['you'] = { remaining: 0, squadCount: 0, wageBill: 0, wageCap: 0 };
    for (const club of clubs) {
      const remaining = club.transferBudget - (await store.auctionSpend(pool, season.id, club.clubId));
      const view = {
        clubId: club.clubId,
        name: club.name,
        remaining,
        squadCount: counts.get(club.clubId) ?? 0,
        you: club.clubId === viewerClubId,
      };
      clubViews.push(view);
      if (view.you) {
        you = {
          remaining,
          squadCount: view.squadCount,
          wageBill: await store.activeWageSum(pool, club.clubId),
          wageCap: club.wageCap,
        };
      }
    }

    return {
      phase: season.phase,
      lot: lotView,
      turn,
      clubs: clubViews,
      you,
      signings: await store.ownSignings(pool, season.id, viewerClubId),
      squadMin,
      squadMax,
    };
  }

  async function loadLotPlayer(playerId: string): Promise<store.PoolPlayer> {
    const { rows } = await pool.query(
      `SELECT id, full_name, position, market_value, birth_date FROM players WHERE id = $1`, [playerId],
    );
    const r = rows[0];
    return { playerId: r.id, fullName: r.full_name, position: r.position, marketValue: Number(r.market_value), birthDate: r.birth_date };
  }

  async function setDuration(clubId: string, playerId: string, duration: number): Promise<void> {
    if (!Number.isInteger(duration) || duration < 1 || duration > 4) {
      throw new AuctionError(422, { error: 'invalid_duration' });
    }
    const season = await store.currentSeason(pool);
    if (!season) throw new AuctionError(409, { error: 'no_season' });
    const ok = await store.setContractDuration(pool, season.id, clubId, playerId, duration);
    if (!ok) throw new AuctionError(409, { error: 'not_adjustable' }); // not yours, or phase moved on
  }

  return {
    state,
    poolPlayers: async () => {
      const season = await store.currentSeason(pool);
      if (!season) throw new AuctionError(409, { error: 'no_season' });
      return store.poolPlayers(pool, season.id);
    },
    nominate,
    bid,
    closeLot,
    setDuration,
  };
}
