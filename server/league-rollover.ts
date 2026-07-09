/**
 * league-rollover.ts — season_end → complete → season N+1, the loop that
 * makes the game repeatable.
 *
 * Fires inside the final week-close tick transaction, immediately after
 * season-end growth (league-training.ts) — revealed_at stays the single
 * exactly-once marker for the whole sequence, so a crashed rollover replays
 * cleanly from the reveal. ORDER MATTERS and is the critical invariant:
 *
 *   growth (contracted players only, already applied by the caller)
 *   → contract expiry (leavers depart at their GROWN state and re-freeze in
 *     the pool by nothing ever touching uncontracted attributes)
 *   → season complete (SQL state machine)
 *   → season N+1 created in the AUCTION phase: same clubs, configured
 *     budget/wage-cap values copied with fresh spend, facilities + training
 *     dial carried, carried contracts get fresh squad rows (off-season
 *     heals: fatigue/injuries/bans reset, sharpness back to the cold start),
 *     both-retained pairs keep familiarityCarryOver of their chemistry.
 *
 * v1 scope (DECISIONS.md): NO renegotiation and NO manual release window —
 * duration IS the retention mechanism (picked 1–4 at signing, wage flat by
 * model), expiring players return to the pool and the next auction
 * re-acquires them. season_end and complete flash by in one transaction;
 * nothing needs the pause until a renegotiation feature exists.
 */

import { LEAGUE_CFG } from '@fm/engine/config';
import * as store from './league-store.ts';

export interface RolloverResult {
  nextSeasonId: string;
  expiredPlayerIds: string[];
}

/** Caller holds the tick transaction and has already applied season growth. */
export async function rolloverSeason(c: store.Queryable, seasonId: string): Promise<RolloverResult> {
  const { rows } = await c.query(`SELECT number FROM seasons WHERE id = $1`, [seasonId]);
  const expiredPlayerIds = await store.expireContracts(c, rows[0].number);
  await store.transitionSeason(c, seasonId, 'complete');
  const nextSeasonId = await store.createNextSeason(c, seasonId, LEAGUE_CFG.reserveGrowthRate);
  await store.carrySquadsForward(c, nextSeasonId);
  await store.carryFamiliarityForward(c, seasonId, nextSeasonId, LEAGUE_CFG.familiarityCarryOver);
  return { nextSeasonId, expiredPlayerIds };
}
