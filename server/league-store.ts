/**
 * league-store.ts — typed data access for the league wrapper.
 *
 * Every function takes a Queryable (pool or client) so callers compose them
 * inside their own transactions — the orchestrator passes locked PoolClients,
 * the API passes the shared pool for single-statement reads.
 * No business logic here beyond shaping rows into engine/API types.
 */

import type { QueryResult } from 'pg';
import type { HalfResult, HalfTimeState, MatchEvent, SquadPlayer, Tactics } from '@fm/engine/types';
import type { EligiblePlayer } from '@fm/engine/eligibility';
import type { FixtureState } from '@fm/engine/state-machine';

/** Satisfied by pg.Pool, pg.Client and pg.PoolClient — callers pick the txn scope. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export interface FixtureRow {
  id: string;
  matchweekId: string;
  homeClubId: string;
  awayClubId: string;
  state: FixtureState;
  htDeadline: Date | null;
  bookkeptAt: Date | null;
  seed: string;
}

export interface MatchweekRow {
  id: string;
  seasonId: string;
  number: number;
  kind: 'regular' | 'transfer';
  opensAt: Date;
  deadlineAt: Date;
  revealedAt: Date | null;
}

export interface SubmissionRow {
  clubId: string;
  half: 1 | 2;
  payload: Tactics;
  isDefault: boolean;
}

export interface StoredHalfResult {
  events: MatchEvent[];
  stats: unknown;
  endState: HalfTimeState;
}

const fixtureFromRow = (r: Record<string, unknown>): FixtureRow => ({
  id: r.id as string,
  matchweekId: r.matchweek_id as string,
  homeClubId: r.home_club_id as string,
  awayClubId: r.away_club_id as string,
  state: r.state as FixtureState,
  htDeadline: r.ht_deadline as Date | null,
  bookkeptAt: r.bookkept_at as Date | null,
  seed: r.seed as string,
});

export async function getFixture(c: Queryable, id: string, forUpdate = false): Promise<FixtureRow | null> {
  const { rows } = await c.query(
    `SELECT id, matchweek_id, home_club_id, away_club_id, state, ht_deadline, bookkept_at, seed
     FROM fixtures WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? fixtureFromRow(rows[0]) : null;
}

export async function getMatchweek(c: Queryable, id: string, forUpdate = false): Promise<MatchweekRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, number, kind, opens_at, deadline_at, revealed_at FROM matchweeks WHERE id = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, seasonId: r.season_id, number: r.number, kind: r.kind,
    opensAt: r.opens_at, deadlineAt: r.deadline_at, revealedAt: r.revealed_at,
  };
}

export async function matchweekByNumber(c: Queryable, seasonId: string, number: number): Promise<MatchweekRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, number, kind, opens_at, deadline_at, revealed_at FROM matchweeks
     WHERE season_id = $1 AND number = $2`,
    [seasonId, number],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, seasonId: r.season_id, number: r.number, kind: r.kind,
    opensAt: r.opens_at, deadlineAt: r.deadline_at, revealedAt: r.revealed_at,
  };
}

export async function listFixtures(c: Queryable, matchweekId: string): Promise<FixtureRow[]> {
  const { rows } = await c.query(
    `SELECT id, matchweek_id, home_club_id, away_club_id, state, ht_deadline, bookkept_at, seed
     FROM fixtures WHERE matchweek_id = $1 ORDER BY id`,
    [matchweekId],
  );
  return rows.map(fixtureFromRow);
}

/** Transaction-stable timestamp; all deadline logic compares against DB time. */
export async function dbNow(c: Queryable): Promise<Date> {
  const { rows } = await c.query(`SELECT now() AS now`);
  return rows[0].now as Date;
}

// ── tactics ──────────────────────────────────────────────────────────────────

export async function getSubmissions(c: Queryable, fixtureId: string, half: 1 | 2): Promise<SubmissionRow[]> {
  const { rows } = await c.query(
    `SELECT club_id, half, payload, is_default FROM tactics_submissions
     WHERE fixture_id = $1 AND half = $2 ORDER BY club_id`,
    [fixtureId, half],
  );
  return rows.map((r) => ({ clubId: r.club_id, half: r.half, payload: r.payload, isDefault: r.is_default }));
}

/** Auto-fill a missing submission from the club's standing default. No-op if already submitted. */
export async function insertDefaultSubmission(
  c: Queryable, fixtureId: string, clubId: string, half: 1 | 2,
): Promise<void> {
  await c.query(
    `INSERT INTO tactics_submissions (fixture_id, club_id, half, payload, is_default)
     SELECT $1, $2, $3, payload, TRUE FROM default_tactics WHERE club_id = $2
     ON CONFLICT (fixture_id, club_id, half) DO NOTHING`,
    [fixtureId, clubId, half],
  );
}

export async function insertSubmission(
  c: Queryable, fixtureId: string, clubId: string, half: 1 | 2, payload: Tactics, isDefault: boolean,
): Promise<void> {
  await c.query(
    `INSERT INTO tactics_submissions (fixture_id, club_id, half, payload, is_default)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (fixture_id, club_id, half) DO NOTHING`,
    [fixtureId, clubId, half, JSON.stringify(payload), isDefault],
  );
}

/** Persist the actually-used auto-lineup when a stored default was stale/invalid. */
export async function updateSubmissionPayload(
  c: Queryable, fixtureId: string, clubId: string, half: 1 | 2, payload: Tactics,
): Promise<void> {
  await c.query(
    `UPDATE tactics_submissions SET payload = $4, is_default = TRUE
     WHERE fixture_id = $1 AND club_id = $2 AND half = $3`,
    [fixtureId, clubId, half, JSON.stringify(payload)],
  );
}

/** Fresh manager submission via the API: PUT semantics, resubmission replaces. */
export async function upsertSubmission(
  c: Queryable, fixtureId: string, clubId: string, half: 1 | 2, payload: Tactics,
): Promise<void> {
  await c.query(
    `INSERT INTO tactics_submissions (fixture_id, club_id, half, payload, is_default)
     VALUES ($1, $2, $3, $4, FALSE)
     ON CONFLICT (fixture_id, club_id, half)
     DO UPDATE SET payload = EXCLUDED.payload, is_default = FALSE, submitted_at = now()`,
    [fixtureId, clubId, half, JSON.stringify(payload)],
  );
}

export async function upsertDefaultTactics(c: Queryable, clubId: string, payload: Tactics): Promise<void> {
  await c.query(
    `INSERT INTO default_tactics (club_id, payload) VALUES ($1, $2)
     ON CONFLICT (club_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [clubId, JSON.stringify(payload)],
  );
}

/** Which halves each club has submitted — booleans only, payloads never leave this query. */
export async function submissionFlags(c: Queryable, fixtureId: string): Promise<Map<string, { half1: boolean; half2: boolean }>> {
  const { rows } = await c.query(
    `SELECT club_id, half FROM tactics_submissions WHERE fixture_id = $1`,
    [fixtureId],
  );
  const out = new Map<string, { half1: boolean; half2: boolean }>();
  for (const r of rows) {
    const e = out.get(r.club_id) ?? { half1: false, half2: false };
    if (r.half === 1) e.half1 = true;
    else e.half2 = true;
    out.set(r.club_id, e);
  }
  return out;
}

// ── squads ───────────────────────────────────────────────────────────────────

export async function loadSquad(c: Queryable, clubId: string, seasonId: string): Promise<SquadPlayer[]> {
  const { rows } = await c.query(
    `SELECT sp.player_id, sp.fatigue, p.attributes, p.physical, p.height_cm, p.weight_kg, p.foot
     FROM squad_players sp JOIN players p ON p.id = sp.player_id
     WHERE sp.club_id = $1 AND sp.season_id = $2 ORDER BY sp.player_id`,
    [clubId, seasonId],
  );
  const fam = await c.query(
    `SELECT player_a, player_b, value FROM familiarity WHERE club_id = $1 AND season_id = $2`,
    [clubId, seasonId],
  );
  const famMap = new Map<string, Record<string, number>>();
  const link = (a: string, b: string, v: number): void => {
    if (!famMap.has(a)) famMap.set(a, {});
    famMap.get(a)![b] = v;
  };
  for (const r of fam.rows) {
    link(r.player_a, r.player_b, r.value);
    link(r.player_b, r.player_a, r.value);
  }
  return rows.map((r) => ({
    playerId: r.player_id,
    attributes: r.attributes,
    physical: {
      heightCm: r.height_cm,
      weightKg: r.weight_kg ?? Math.round(r.height_cm - 105),
      preferredFoot: r.foot,
      injuryProneness: r.physical?.injuryProneness ?? 10,
    },
    fatigue: r.fatigue,
    familiarity: famMap.get(r.player_id) ?? {},
  }));
}

/** Squad shaped for eligibility validation / best-XI (league-eligibility.ts). */
export async function loadEligibilitySquad(c: Queryable, clubId: string, seasonId: string): Promise<EligiblePlayer[]> {
  const { rows } = await c.query(
    `SELECT sp.player_id, sp.injury_weeks_left, sp.suspended_next, p.position, p.attributes
     FROM squad_players sp JOIN players p ON p.id = sp.player_id
     WHERE sp.club_id = $1 AND sp.season_id = $2 ORDER BY sp.player_id`,
    [clubId, seasonId],
  );
  return rows.map((r) => ({
    playerId: r.player_id,
    position: r.position,
    attributes: r.attributes,
    injuryWeeksLeft: r.injury_weeks_left,
    suspendedNext: r.suspended_next,
  }));
}

/** clubId → medical facility level (club_seasons); missing rows read as level 0. */
/** clubId → training facility level — the season-end-growth PR's input. */
export async function getTrainingLevels(c: Queryable, seasonId: string, clubIds: string[]): Promise<Map<string, number>> {
  const { rows } = await c.query(
    `SELECT club_id, training_level FROM club_seasons WHERE season_id = $1 AND club_id = ANY($2)`,
    [seasonId, clubIds],
  );
  return new Map(rows.map((r) => [r.club_id, r.training_level]));
}

export interface FacilitiesRow {
  trainingLevel: number;
  medicalLevel: number;
  transferBudget: number;
}

export async function getFacilities(
  c: Queryable, seasonId: string, clubId: string, forUpdate = false,
): Promise<FacilitiesRow | null> {
  const { rows } = await c.query(
    `SELECT training_level, medical_level, transfer_budget FROM club_seasons
     WHERE season_id = $1 AND club_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [seasonId, clubId],
  );
  return rows[0]
    ? { trainingLevel: rows[0].training_level, medicalLevel: rows[0].medical_level, transferBudget: Number(rows[0].transfer_budget) }
    : null;
}

/**
 * Spendable budget: transfer_budget minus every debiting txn kind that draws
 * on it, PLUS transfer-fee credits — selling a player mid-season funds new
 * signings and facilities. wage_payment rides the wage-cap system, not this.
 */
export async function budgetRemaining(c: Queryable, seasonId: string, clubId: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT cs.transfer_budget
       - COALESCE((SELECT SUM(t.amount) FROM transactions t
           WHERE t.season_id = $1 AND t.club_id = $2
             AND t.kind IN ('auction_win', 'pool_signing', 'transfer_fee', 'facility_investment')), 0)
       + COALESCE((SELECT SUM(t.amount) FROM transactions t
           WHERE t.season_id = $1 AND t.to_club_id = $2 AND t.kind = 'transfer_fee'), 0) AS remaining
     FROM club_seasons cs WHERE cs.season_id = $1 AND cs.club_id = $2`,
    [seasonId, clubId],
  );
  return rows[0] ? Number(rows[0].remaining) : 0;
}

/** Raise a facility one level + record the txn — caller holds the row lock. */
export async function applyFacilityInvestment(
  c: Queryable, seasonId: string, clubId: string, facility: 'training' | 'medical', cost: number,
): Promise<void> {
  const column = facility === 'training' ? 'training_level' : 'medical_level';
  await c.query(
    `UPDATE club_seasons SET ${column} = ${column} + 1 WHERE season_id = $1 AND club_id = $2`,
    [seasonId, clubId],
  );
  await c.query(
    `INSERT INTO transactions (season_id, kind, club_id, amount, memo)
     VALUES ($1, 'facility_investment', $2, $3, $4)`,
    [seasonId, clubId, cost, `${facility} facility upgrade`],
  );
}

export async function getMedicalLevels(c: Queryable, seasonId: string, clubIds: string[]): Promise<Map<string, number>> {
  const { rows } = await c.query(
    `SELECT club_id, medical_level FROM club_seasons WHERE season_id = $1 AND club_id = ANY($2)`,
    [seasonId, clubIds],
  );
  return new Map(rows.map((r) => [r.club_id, r.medical_level]));
}

/** playerId → clubId for every squad player of the given clubs this season. */
export async function squadClubMap(c: Queryable, seasonId: string, clubIds: string[]): Promise<Map<string, string>> {
  const { rows } = await c.query(
    `SELECT player_id, club_id FROM squad_players WHERE season_id = $1 AND club_id = ANY($2)`,
    [seasonId, clubIds],
  );
  return new Map(rows.map((r) => [r.player_id, r.club_id]));
}

// ── results ──────────────────────────────────────────────────────────────────

/** Idempotent: retried jobs re-insert the identical deterministic result, conflict is ignored. */
export async function insertHalfResult(c: Queryable, fixtureId: string, half: 1 | 2, result: HalfResult): Promise<void> {
  await c.query(
    `INSERT INTO half_results (fixture_id, half, events, stats, end_state)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (fixture_id, half) DO NOTHING`,
    [fixtureId, half, JSON.stringify(result.events), JSON.stringify(result.stats), JSON.stringify(result.endState)],
  );
  await c.query(
    `INSERT INTO replay_frames (fixture_id, half, frames)
     VALUES ($1, $2, $3) ON CONFLICT (fixture_id, half) DO NOTHING`,
    [fixtureId, half, JSON.stringify(result.frames)],
  );
}

export async function getHalfResult(c: Queryable, fixtureId: string, half: 1 | 2): Promise<StoredHalfResult | null> {
  const { rows } = await c.query(
    `SELECT events, stats, end_state FROM half_results WHERE fixture_id = $1 AND half = $2`,
    [fixtureId, half],
  );
  const r = rows[0];
  return r ? { events: r.events, stats: r.stats, endState: r.end_state } : null;
}

/** State changes go through the DB trigger; an exception here is an assertion failure upstream. */
export async function transitionFixture(
  c: Queryable, id: string, state: FixtureState, htDeadline?: Date,
): Promise<void> {
  if (htDeadline !== undefined) {
    await c.query(`UPDATE fixtures SET state = $2, ht_deadline = $3 WHERE id = $1`, [id, state, htDeadline]);
  } else {
    await c.query(`UPDATE fixtures SET state = $2 WHERE id = $1`, [id, state]);
  }
}

// ── bookkeeping ──────────────────────────────────────────────────────────────

export const bookkeepingMemo = (fixtureId: string): string => `fixture:${fixtureId}`;

/**
 * Applied-marker for post-match bookkeeping: first write of its transaction.
 * Callers short-circuit on a non-null fixtures.bookkept_at (read under the
 * FOR UPDATE lock), so a retried job never double-applies increments.
 */
export async function markBookkept(c: Queryable, fixtureId: string): Promise<void> {
  await c.query(`UPDATE fixtures SET bookkept_at = now() WHERE id = $1`, [fixtureId]);
}

export async function activeWageSum(c: Queryable, clubId: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(wage), 0)::bigint AS total FROM contracts WHERE club_id = $1 AND released_at IS NULL`,
    [clubId],
  );
  return Number(rows[0].total);
}

export async function insertWageTxn(
  c: Queryable, seasonId: string, clubId: string, amount: number, fixtureId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO transactions (season_id, kind, club_id, amount, memo)
     VALUES ($1, 'wage_payment', $2, $3, $4)`,
    [seasonId, clubId, amount, bookkeepingMemo(fixtureId)],
  );
}

/** Post-match per-player write: absolute fatigue, minutes delta, consume just_returned. */
export async function applyPlayerMatchState(
  c: Queryable, seasonId: string, playerId: string, fatigue: number, minutes: number,
): Promise<void> {
  await c.query(
    `UPDATE squad_players
     SET fatigue = $3, season_minutes = season_minutes + $4,
         just_returned = CASE WHEN $4 > 0 THEN FALSE ELSE just_returned END
     WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId, fatigue, minutes],
  );
}

export async function applyInjury(c: Queryable, seasonId: string, playerId: string, weeks: number): Promise<void> {
  await c.query(
    `UPDATE squad_players SET injury_weeks_left = GREATEST(injury_weeks_left, $3)
     WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId, weeks],
  );
}

export async function applySuspension(c: Queryable, seasonId: string, playerId: string): Promise<void> {
  await c.query(
    `UPDATE squad_players SET suspended_next = TRUE WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId],
  );
}

/** player_a < player_b enforced by CHECK; caller passes canonically ordered ids. */
export async function bumpFamiliarity(
  c: Queryable, clubId: string, seasonId: string, playerA: string, playerB: string, increment: number,
): Promise<void> {
  await c.query(
    `INSERT INTO familiarity (club_id, season_id, player_a, player_b, value)
     VALUES ($1, $2, $3, $4, LEAST(1.0, $5))
     ON CONFLICT (club_id, season_id, player_a, player_b)
     DO UPDATE SET value = LEAST(1.0, familiarity.value + EXCLUDED.value)`,
    [clubId, seasonId, playerA, playerB, increment],
  );
}

export async function revealMatchweek(c: Queryable, matchweekId: string): Promise<void> {
  await c.query(
    `UPDATE matchweeks SET revealed_at = now() WHERE id = $1 AND revealed_at IS NULL`,
    [matchweekId],
  );
}

// ── auction ──────────────────────────────────────────────────────────────────
// One row per (season, player) — schema UNIQUE. An unsold/forfeited lot is
// re-nominated by RE-OPENING its row (new opens_at/closes_at); bids only count
// toward the current opening (placed_at >= opens_at), so stale bids from a
// failed opening never resurrect.

export interface LotRow {
  id: string;
  seasonId: string;
  playerId: string;
  opensAt: Date;
  closesAt: Date;
  wonBy: string | null;
}

const lotFromRow = (r: Record<string, unknown>): LotRow => ({
  id: r.id as string,
  seasonId: r.season_id as string,
  playerId: r.player_id as string,
  opensAt: r.opens_at as Date,
  closesAt: r.closes_at as Date,
  wonBy: r.won_by as string | null,
});

export async function getLot(c: Queryable, id: string, forUpdate = false): Promise<LotRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, player_id, opens_at, closes_at, won_by FROM auction_lots WHERE id = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? lotFromRow(rows[0]) : null;
}

export async function liveLot(c: Queryable, seasonId: string): Promise<LotRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, player_id, opens_at, closes_at, won_by FROM auction_lots
     WHERE season_id = $1 AND won_by IS NULL AND closes_at > now()
     ORDER BY closes_at DESC LIMIT 1`,
    [seasonId],
  );
  return rows[0] ? lotFromRow(rows[0]) : null;
}

export async function lotForPlayer(c: Queryable, seasonId: string, playerId: string): Promise<LotRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, player_id, opens_at, closes_at, won_by FROM auction_lots
     WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId],
  );
  return rows[0] ? lotFromRow(rows[0]) : null;
}

export async function insertLot(
  c: Queryable, seasonId: string, playerId: string, opensAt: Date, closesAt: Date,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO auction_lots (season_id, player_id, opens_at, closes_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [seasonId, playerId, opensAt, closesAt],
  );
  return rows[0].id;
}

export async function reopenLot(c: Queryable, lotId: string, opensAt: Date, closesAt: Date): Promise<void> {
  await c.query(
    `UPDATE auction_lots SET opens_at = $2, closes_at = $3 WHERE id = $1 AND won_by IS NULL`,
    [lotId, opensAt, closesAt],
  );
}

export async function extendLot(c: Queryable, lotId: string, closesAt: Date): Promise<void> {
  await c.query(`UPDATE auction_lots SET closes_at = $2 WHERE id = $1`, [lotId, closesAt]);
}

export async function setLotWinner(c: Queryable, lotId: string, clubId: string): Promise<void> {
  await c.query(`UPDATE auction_lots SET won_by = $2 WHERE id = $1`, [lotId, clubId]);
}

export async function lotCount(c: Queryable, seasonId: string): Promise<number> {
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM auction_lots WHERE season_id = $1`, [seasonId]);
  return rows[0].n;
}

export interface BidRow { clubId: string; amount: number; placedAt: Date }

/** Highest bid of the CURRENT opening; earlier bid wins amount ties. */
export async function highBid(c: Queryable, lotId: string, opensAt: Date): Promise<BidRow | null> {
  const { rows } = await c.query(
    `SELECT club_id, amount, placed_at FROM auction_bids
     WHERE lot_id = $1 AND placed_at >= $2
     ORDER BY amount DESC, placed_at ASC LIMIT 1`,
    [lotId, opensAt],
  );
  const r = rows[0];
  return r ? { clubId: r.club_id, amount: Number(r.amount), placedAt: r.placed_at } : null;
}

export async function insertBid(c: Queryable, lotId: string, clubId: string, amount: number): Promise<void> {
  await c.query(
    `INSERT INTO auction_bids (lot_id, club_id, amount) VALUES ($1, $2, $3)`,
    [lotId, clubId, amount],
  );
}

export interface PoolPlayer {
  playerId: string;
  fullName: string;
  position: string;
  marketValue: number;
  birthDate: string;
}

/** Uncontracted players not currently on a live lot. */
export async function poolPlayers(c: Queryable, seasonId: string): Promise<PoolPlayer[]> {
  const { rows } = await c.query(
    `SELECT p.id, p.full_name, p.position, p.market_value, p.birth_date
     FROM players p
     WHERE NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id AND ct.released_at IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM auction_lots l
         WHERE l.player_id = p.id AND l.season_id = $1 AND l.won_by IS NULL AND l.closes_at > now()
       )
     ORDER BY p.market_value DESC, p.full_name`,
    [seasonId],
  );
  return rows.map((r) => ({
    playerId: r.id, fullName: r.full_name, position: r.position,
    marketValue: Number(r.market_value), birthDate: r.birth_date,
  }));
}

export interface AuctionClubRow {
  clubId: string;
  name: string;
  transferBudget: number;
  wageCap: number;
}

/** Seed order v1 = club name ascending (no rankings yet — DECISIONS.md). */
export async function clubsBySeed(c: Queryable, seasonId: string): Promise<AuctionClubRow[]> {
  const { rows } = await c.query(
    `SELECT cl.id, cl.name, cs.transfer_budget, cs.wage_cap
     FROM clubs cl JOIN club_seasons cs ON cs.club_id = cl.id AND cs.season_id = $1
     ORDER BY cl.name ASC`,
    [seasonId],
  );
  return rows.map((r) => ({
    clubId: r.id, name: r.name, transferBudget: Number(r.transfer_budget), wageCap: Number(r.wage_cap),
  }));
}

export async function auctionSpend(c: Queryable, seasonId: string, clubId: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM transactions
     WHERE season_id = $1 AND club_id = $2 AND kind = 'auction_win'`,
    [seasonId, clubId],
  );
  return Number(rows[0].total);
}

export async function squadCount(c: Queryable, seasonId: string, clubId: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM squad_players WHERE season_id = $1 AND club_id = $2`,
    [seasonId, clubId],
  );
  return rows[0].n;
}

export async function squadCounts(c: Queryable, seasonId: string): Promise<Map<string, number>> {
  const { rows } = await c.query(
    `SELECT club_id, count(*)::int AS n FROM squad_players WHERE season_id = $1 GROUP BY club_id`,
    [seasonId],
  );
  return new Map(rows.map((r) => [r.club_id, r.n]));
}

export async function signPlayer(
  c: Queryable, seasonId: string, clubId: string, playerId: string, wage: number, duration: number, price: number,
): Promise<void> {
  await c.query(
    `INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, $4, $5)`,
    [playerId, clubId, seasonId, wage, duration],
  );
  await c.query(
    `INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`,
    [clubId, seasonId, playerId],
  );
  await c.query(
    `INSERT INTO transactions (season_id, kind, club_id, player_id, amount, memo)
     VALUES ($1, 'auction_win', $2, $3, $4, 'season-start auction')`,
    [seasonId, clubId, playerId, price],
  );
}

/** Winner's duration pick — only while the season is still in the auction phase. */
export async function setContractDuration(
  c: Queryable, seasonId: string, clubId: string, playerId: string, duration: number,
): Promise<boolean> {
  const res = await c.query(
    `UPDATE contracts SET duration = $4
     WHERE player_id = $3 AND club_id = $2 AND season_signed = $1 AND released_at IS NULL
       AND EXISTS (SELECT 1 FROM seasons s WHERE s.id = $1 AND s.phase = 'auction')`,
    [seasonId, clubId, playerId, duration],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface OwnSigning {
  playerId: string;
  fullName: string;
  position: string;
  wage: number;
  duration: number;
  price: number;
}

export async function ownSignings(c: Queryable, seasonId: string, clubId: string): Promise<OwnSigning[]> {
  const { rows } = await c.query(
    `SELECT ct.player_id, p.full_name, p.position, ct.wage, ct.duration,
            COALESCE((SELECT t.amount FROM transactions t
                      WHERE t.season_id = $1 AND t.club_id = $2 AND t.player_id = ct.player_id
                        AND t.kind = 'auction_win' LIMIT 1), 0) AS price
     FROM contracts ct JOIN players p ON p.id = ct.player_id
     WHERE ct.season_signed = $1 AND ct.club_id = $2 AND ct.released_at IS NULL
     ORDER BY p.full_name`,
    [seasonId, clubId],
  );
  return rows.map((r) => ({
    playerId: r.player_id, fullName: r.full_name, position: r.position,
    wage: Number(r.wage), duration: r.duration, price: Number(r.price),
  }));
}

// ── mid-season transfer window ───────────────────────────────────────────────
// Offers live in transfer_offers (resolved rows immutable — SQL trigger); the
// player move itself is UPDATEs: contracts.club_id and squad_players.club_id
// (the PK is (season, player), so fatigue/injury/suspension state rides along)
// plus a familiarity wipe at the selling club — a club change is always
// familiarity-cold (DECISIONS.md).

export type TransferOfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface TransferOfferRow {
  id: string;
  seasonId: string;
  playerId: string;
  buyerClubId: string;
  sellerClubId: string;
  fee: number;
  status: TransferOfferStatus;
  createdAt: Date;
}

const offerFromRow = (r: Record<string, unknown>): TransferOfferRow => ({
  id: r.id as string,
  seasonId: r.season_id as string,
  playerId: r.player_id as string,
  buyerClubId: r.buyer_club_id as string,
  sellerClubId: r.seller_club_id as string,
  fee: Number(r.fee),
  status: r.status as TransferOfferStatus,
  createdAt: r.created_at as Date,
});

export async function getOffer(c: Queryable, id: string, forUpdate = false): Promise<TransferOfferRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, player_id, buyer_club_id, seller_club_id, fee, status, created_at
     FROM transfer_offers WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? offerFromRow(rows[0]) : null;
}

/** One live offer per (buyer, player) — re-offering replaces the fee. */
export async function upsertPendingOffer(
  c: Queryable, seasonId: string, playerId: string, buyerClubId: string, sellerClubId: string, fee: number,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO transfer_offers (season_id, player_id, buyer_club_id, seller_club_id, fee)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (season_id, player_id, buyer_club_id) WHERE status = 'pending'
     DO UPDATE SET fee = EXCLUDED.fee, seller_club_id = EXCLUDED.seller_club_id, created_at = now()
     RETURNING id`,
    [seasonId, playerId, buyerClubId, sellerClubId, fee],
  );
  return rows[0].id;
}

/** pending → resolved; false when the offer was already resolved (or missing). */
export async function resolveOffer(c: Queryable, offerId: string, status: TransferOfferStatus): Promise<boolean> {
  const res = await c.query(
    `UPDATE transfer_offers SET status = $2, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
    [offerId, status],
  );
  return (res.rowCount ?? 0) > 0;
}

/** A player just moved: every OTHER pending offer on them is dead. */
export async function expirePendingOffersForPlayer(
  c: Queryable, seasonId: string, playerId: string, exceptOfferId: string,
): Promise<void> {
  await c.query(
    `UPDATE transfer_offers SET status = 'expired', resolved_at = now()
     WHERE season_id = $1 AND player_id = $2 AND status = 'pending' AND id <> $3`,
    [seasonId, playerId, exceptOfferId],
  );
}

/** Window deadline: everything still pending expires with the week close. */
export async function expirePendingOffers(c: Queryable, seasonId: string): Promise<void> {
  await c.query(
    `UPDATE transfer_offers SET status = 'expired', resolved_at = now()
     WHERE season_id = $1 AND status = 'pending'`,
    [seasonId],
  );
}

export interface OfferView extends TransferOfferRow {
  playerName: string;
  buyerName: string;
  sellerName: string;
}

/** Every offer the club made or received this season, newest first. */
export async function listOffers(c: Queryable, seasonId: string, clubId: string): Promise<OfferView[]> {
  const { rows } = await c.query(
    `SELECT o.id, o.season_id, o.player_id, o.buyer_club_id, o.seller_club_id, o.fee, o.status, o.created_at,
            p.full_name AS player_name, cb.name AS buyer_name, cs.name AS seller_name
     FROM transfer_offers o
     JOIN players p ON p.id = o.player_id
     JOIN clubs cb ON cb.id = o.buyer_club_id
     JOIN clubs cs ON cs.id = o.seller_club_id
     WHERE o.season_id = $1 AND (o.buyer_club_id = $2 OR o.seller_club_id = $2)
     ORDER BY (o.status = 'pending') DESC, o.created_at DESC`,
    [seasonId, clubId],
  );
  return rows.map((r) => ({
    ...offerFromRow(r),
    playerName: r.player_name,
    buyerName: r.buyer_name,
    sellerName: r.seller_name,
  }));
}

export interface ActiveContractRow { clubId: string; wage: number; duration: number }

/** forUpdate locks the contract row — transfers of one player serialize here. */
export async function activeContract(c: Queryable, playerId: string, forUpdate = false): Promise<ActiveContractRow | null> {
  const { rows } = await c.query(
    `SELECT club_id, wage, duration FROM contracts WHERE player_id = $1 AND released_at IS NULL
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [playerId],
  );
  return rows[0] ? { clubId: rows[0].club_id, wage: Number(rows[0].wage), duration: rows[0].duration } : null;
}

/** Lock the player row (pool-signing races serialize here); null = unknown id. */
export async function lockPlayer(c: Queryable, playerId: string): Promise<{ marketValue: number } | null> {
  const { rows } = await c.query(`SELECT market_value FROM players WHERE id = $1 FOR UPDATE`, [playerId]);
  return rows[0] ? { marketValue: Number(rows[0].market_value) } : null;
}

/**
 * Move a contracted player buyer←seller: contract and per-season state keep
 * their values (wage, duration, fatigue, injuries, suspension — only club_id
 * changes); the player's dyads at the selling club are wiped so a club change
 * is familiarity-cold everywhere; the fee txn debits buyer, credits seller.
 */
export async function transferPlayer(
  c: Queryable, seasonId: string, playerId: string, buyerClubId: string, sellerClubId: string, fee: number,
): Promise<void> {
  await c.query(
    `UPDATE contracts SET club_id = $2 WHERE player_id = $1 AND released_at IS NULL`,
    [playerId, buyerClubId],
  );
  await c.query(
    `UPDATE squad_players SET club_id = $3 WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId, buyerClubId],
  );
  await c.query(
    `DELETE FROM familiarity WHERE club_id = $1 AND season_id = $2 AND (player_a = $3 OR player_b = $3)`,
    [sellerClubId, seasonId, playerId],
  );
  await c.query(
    `INSERT INTO transactions (season_id, kind, club_id, to_club_id, player_id, amount, memo)
     VALUES ($1, 'transfer_fee', $2, $3, $4, $5, 'transfer window')`,
    [seasonId, buyerClubId, sellerClubId, playerId, fee],
  );
}

/** Fixed-price pool signing during the window; price = market value. */
export async function signFromPool(
  c: Queryable, seasonId: string, clubId: string, playerId: string, wage: number, duration: number, price: number,
): Promise<void> {
  await c.query(
    `INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, $4, $5)`,
    [playerId, clubId, seasonId, wage, duration],
  );
  await c.query(
    `INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`,
    [clubId, seasonId, playerId],
  );
  await c.query(
    `INSERT INTO transactions (season_id, kind, club_id, player_id, amount, memo)
     VALUES ($1, 'pool_signing', $2, $3, $4, 'transfer window pool signing')`,
    [seasonId, clubId, playerId, price],
  );
}

export interface MarketPlayerRow {
  playerId: string;
  fullName: string;
  position: string;
  wage: number;
  marketValue: number;
  injuryWeeksLeft: number;
}

/** Every club's contracted squad with wages — the browse-other-squads view. */
export async function contractedSquads(
  c: Queryable, seasonId: string,
): Promise<Array<{ clubId: string; name: string; players: MarketPlayerRow[] }>> {
  const { rows } = await c.query(
    `SELECT cl.id AS club_id, cl.name, sp.player_id, p.full_name, p.position, p.market_value,
            ct.wage, sp.injury_weeks_left
     FROM clubs cl
     JOIN club_seasons cs ON cs.club_id = cl.id AND cs.season_id = $1
     JOIN squad_players sp ON sp.club_id = cl.id AND sp.season_id = $1
     JOIN players p ON p.id = sp.player_id
     JOIN contracts ct ON ct.player_id = sp.player_id AND ct.released_at IS NULL
     ORDER BY cl.name, p.full_name`,
    [seasonId],
  );
  const byClub = new Map<string, { clubId: string; name: string; players: MarketPlayerRow[] }>();
  for (const r of rows) {
    if (!byClub.has(r.club_id)) byClub.set(r.club_id, { clubId: r.club_id, name: r.name, players: [] });
    byClub.get(r.club_id)!.players.push({
      playerId: r.player_id, fullName: r.full_name, position: r.position,
      wage: Number(r.wage), marketValue: Number(r.market_value), injuryWeeksLeft: r.injury_weeks_left,
    });
  }
  return [...byClub.values()];
}

// ── schedule generation (auction completion) ────────────────────────────────

export async function getSeasonRow(
  c: Queryable, seasonId: string, forUpdate = false,
): Promise<{ id: string; phase: string; transferWeek: number } | null> {
  const { rows } = await c.query(
    `SELECT id, phase, transfer_week FROM seasons WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [seasonId],
  );
  return rows[0] ? { id: rows[0].id, phase: rows[0].phase, transferWeek: rows[0].transfer_week } : null;
}

export async function updateSeasonSchedule(
  c: Queryable, seasonId: string, matchweekCount: number, transferWeek: number,
): Promise<void> {
  await c.query(
    `UPDATE seasons SET matchweek_count = $2, transfer_week = $3 WHERE id = $1`,
    [seasonId, matchweekCount, transferWeek],
  );
}

export async function transitionSeason(c: Queryable, seasonId: string, phase: string): Promise<void> {
  await c.query(`UPDATE seasons SET phase = $2 WHERE id = $1`, [seasonId, phase]);
}

export async function insertMatchweek(
  c: Queryable, seasonId: string, number: number, kind: 'regular' | 'transfer', opensAt: Date, deadlineAt: Date,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO matchweeks (season_id, number, kind, opens_at, deadline_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [seasonId, number, kind, opensAt, deadlineAt],
  );
  return rows[0].id;
}

export async function insertFixture(
  c: Queryable, matchweekId: string, homeClubId: string, awayClubId: string, seed: string,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed) VALUES ($1, $2, $3, $4) RETURNING id`,
    [matchweekId, homeClubId, awayClubId, seed],
  );
  return rows[0].id;
}

// ── between-week tick ────────────────────────────────────────────────────────
// All tick statements run in ONE transaction with revealMatchweek, under the
// matchweek row lock — revealed_at doubles as the tick's applied-marker.

/** Injuries heal one week; a decrement that reaches 0 raises the re-injury flag. */
export async function decrementInjuries(c: Queryable, seasonId: string): Promise<void> {
  await c.query(
    `UPDATE squad_players
     SET injury_weeks_left = injury_weeks_left - 1,
         just_returned = CASE WHEN injury_weeks_left = 1 THEN TRUE ELSE just_returned END
     WHERE season_id = $1 AND injury_weeks_left > 0`,
    [seasonId],
  );
}

/**
 * Players shown a red card in this matchweek's fixtures — the suspensions
 * ISSUED this week, derived from the immutable match events rather than a
 * snapshot (retry-safe; see DECISIONS.md).
 */
export async function redCardedPlayerIds(c: Queryable, matchweekId: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT DISTINCT e->>'playerId' AS player_id
     FROM half_results hr
     JOIN fixtures f ON f.id = hr.fixture_id,
     LATERAL jsonb_array_elements(hr.events) e
     WHERE f.matchweek_id = $1 AND e->>'type' = 'card' AND e->'meta'->>'card' = 'red'`,
    [matchweekId],
  );
  return rows.map((r) => r.player_id).filter((id): id is string => id !== null);
}

/** Clear served suspensions: everyone still flagged except this week's red cards. */
export async function clearServedSuspensions(c: Queryable, seasonId: string, issuedThisWeek: string[]): Promise<void> {
  await c.query(
    `UPDATE squad_players SET suspended_next = FALSE
     WHERE season_id = $1 AND suspended_next AND NOT (player_id = ANY($2))`,
    [seasonId, issuedThisWeek],
  );
}

// ── auth sessions ────────────────────────────────────────────────────────────

/**
 * Single-use redemption: the session id is derived from the magic link's jti,
 * so a second redeem of the same link conflicts on the PK. Returns whether the
 * session was created (false = link already redeemed).
 */
export async function createSession(
  c: Queryable, sessionId: string, managerId: string, expiresAt: Date,
): Promise<boolean> {
  const res = await c.query(
    `INSERT INTO sessions (id, manager_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [sessionId, managerId, expiresAt],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface SessionContext {
  managerId: string;
  email: string;
  displayName: string;
  clubId: string | null;
  clubName: string | null;
}

export async function getSessionContext(c: Queryable, sessionId: string): Promise<SessionContext | null> {
  const { rows } = await c.query(
    `SELECT m.id AS manager_id, m.email, m.display_name, cl.id AS club_id, cl.name AS club_name
     FROM sessions s
     JOIN managers m ON m.id = s.manager_id
     LEFT JOIN clubs cl ON cl.manager_id = m.id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const r = rows[0];
  if (!r) return null;
  return { managerId: r.manager_id, email: r.email, displayName: r.display_name, clubId: r.club_id, clubName: r.club_name };
}

export async function managerIdByEmail(c: Queryable, email: string): Promise<string | null> {
  const { rows } = await c.query(`SELECT id FROM managers WHERE email = $1`, [email]);
  return rows[0]?.id ?? null;
}

// ── API read models ──────────────────────────────────────────────────────────

export interface SeasonRow { id: string; number: number; phase: string }

export async function currentSeason(c: Queryable): Promise<SeasonRow | null> {
  const { rows } = await c.query(`SELECT id, number, phase FROM seasons ORDER BY number DESC LIMIT 1`);
  return rows[0] ?? null;
}

/** The active matchweek: earliest unrevealed; falls back to the latest when all are revealed. */
export async function currentMatchweek(c: Queryable, seasonId: string): Promise<MatchweekRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, number, kind, opens_at, deadline_at, revealed_at FROM matchweeks
     WHERE season_id = $1
     ORDER BY (revealed_at IS NOT NULL), CASE WHEN revealed_at IS NULL THEN number ELSE -number END
     LIMIT 1`,
    [seasonId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, seasonId: r.season_id, number: r.number, kind: r.kind,
    opensAt: r.opens_at, deadlineAt: r.deadline_at, revealedAt: r.revealed_at,
  };
}

export async function fixtureForClub(c: Queryable, matchweekId: string, clubId: string): Promise<FixtureRow | null> {
  const { rows } = await c.query(
    `SELECT id, matchweek_id, home_club_id, away_club_id, state, ht_deadline, bookkept_at, seed
     FROM fixtures WHERE matchweek_id = $1 AND (home_club_id = $2 OR away_club_id = $2)`,
    [matchweekId, clubId],
  );
  return rows[0] ? fixtureFromRow(rows[0]) : null;
}

export async function clubNames(c: Queryable, clubIds: string[]): Promise<Map<string, string>> {
  const { rows } = await c.query(`SELECT id, name FROM clubs WHERE id = ANY($1)`, [clubIds]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function playerNames(c: Queryable, seasonId: string, clubIds: string[]): Promise<Map<string, string>> {
  const { rows } = await c.query(
    `SELECT sp.player_id, p.full_name FROM squad_players sp JOIN players p ON p.id = sp.player_id
     WHERE sp.season_id = $1 AND sp.club_id = ANY($2)`,
    [seasonId, clubIds],
  );
  return new Map(rows.map((r) => [r.player_id, r.full_name]));
}

export interface SquadViewRow {
  playerId: string;
  fullName: string;
  position: string;
  attributes: unknown;
  fatigue: number;
  injuryWeeksLeft: number;
  suspendedNext: boolean;
  justReturned: boolean;
  seasonMinutes: number;
}

export async function loadSquadView(c: Queryable, clubId: string, seasonId: string): Promise<SquadViewRow[]> {
  const { rows } = await c.query(
    `SELECT sp.player_id, p.full_name, p.position, p.attributes, sp.fatigue,
            sp.injury_weeks_left, sp.suspended_next, sp.just_returned, sp.season_minutes
     FROM squad_players sp JOIN players p ON p.id = sp.player_id
     WHERE sp.club_id = $1 AND sp.season_id = $2 ORDER BY p.full_name`,
    [clubId, seasonId],
  );
  return rows.map((r) => ({
    playerId: r.player_id, fullName: r.full_name, position: r.position, attributes: r.attributes,
    fatigue: r.fatigue, injuryWeeksLeft: r.injury_weeks_left, suspendedNext: r.suspended_next,
    justReturned: r.just_returned, seasonMinutes: r.season_minutes,
  }));
}

export interface HalfResultView { half: 1 | 2; stats: unknown; events: MatchEvent[]; score: [number, number] }

/**
 * EMBARGO IS ENFORCED HERE, IN SQL: rows come back only when the matchweek is
 * revealed, or the viewer is a participant and the fixture is final. Callers
 * must not re-derive visibility in JS. The predicate is shared by every
 * post-final read (results, replays) — one rule, one place.
 * Placeholders: $1 = fixtureId, $2 = viewerClubId.
 */
const EMBARGO_VISIBLE = `f.id = $1 AND f.state = 'final'
       AND (mw.revealed_at IS NOT NULL OR $2 IN (f.home_club_id, f.away_club_id))`;

export async function embargoedResult(c: Queryable, fixtureId: string, viewerClubId: string): Promise<HalfResultView[]> {
  const { rows } = await c.query(
    `SELECT hr.half, hr.stats, hr.events, hr.end_state->'score' AS score
     FROM fixtures f
     JOIN matchweeks mw ON mw.id = f.matchweek_id
     JOIN half_results hr ON hr.fixture_id = f.id
     WHERE ${EMBARGO_VISIBLE}
     ORDER BY hr.half`,
    [fixtureId, viewerClubId],
  );
  return rows.map((r) => ({ half: r.half, stats: r.stats, events: r.events, score: r.score }));
}

/** Replay frames under the SAME embargo rule as results. */
export async function embargoedReplay(
  c: Queryable,
  fixtureId: string,
  viewerClubId: string,
): Promise<Array<{ half: number; frames: unknown[] }>> {
  const { rows } = await c.query(
    `SELECT rf.half, rf.frames
     FROM fixtures f
     JOIN matchweeks mw ON mw.id = f.matchweek_id
     JOIN replay_frames rf ON rf.fixture_id = f.id
     WHERE ${EMBARGO_VISIBLE}
     ORDER BY rf.half`,
    [fixtureId, viewerClubId],
  );
  return rows.map((r) => ({ half: r.half, frames: r.frames }));
}

/** Player ids per club from the fixture's accepted submissions (dot colors). */
export async function fixtureSides(c: Queryable, fixtureId: string): Promise<Record<string, string[]>> {
  const { rows } = await c.query(
    `SELECT club_id, payload FROM tactics_submissions WHERE fixture_id = $1`,
    [fixtureId],
  );
  const sides: Record<string, Set<string>> = {};
  for (const r of rows) {
    const ids = ((r.payload as Tactics).players ?? []).map((p: { playerId: string }) => p.playerId);
    (sides[r.club_id] ??= new Set());
    for (const id of ids) sides[r.club_id].add(id);
  }
  return Object.fromEntries(Object.entries(sides).map(([club, set]) => [club, [...set]]));
}

export interface StandingsRow {
  clubId: string;
  name: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

/** Standings from fixtures in REVEALED matchweeks only — the embargo lives in this join. */
export async function standings(c: Queryable, seasonId: string): Promise<StandingsRow[]> {
  const { rows } = await c.query(
    `WITH played AS (
       SELECT f.home_club_id AS club,
              (hr.end_state->'score'->>0)::int AS gf,
              (hr.end_state->'score'->>1)::int AS ga
       FROM fixtures f
       JOIN matchweeks mw ON mw.id = f.matchweek_id AND mw.season_id = $1 AND mw.revealed_at IS NOT NULL
       JOIN half_results hr ON hr.fixture_id = f.id AND hr.half = 2
       WHERE f.state = 'final'
       UNION ALL
       SELECT f.away_club_id,
              (hr.end_state->'score'->>1)::int,
              (hr.end_state->'score'->>0)::int
       FROM fixtures f
       JOIN matchweeks mw ON mw.id = f.matchweek_id AND mw.season_id = $1 AND mw.revealed_at IS NOT NULL
       JOIN half_results hr ON hr.fixture_id = f.id AND hr.half = 2
       WHERE f.state = 'final'
     )
     SELECT c.id, c.name,
            COUNT(p.club)::int AS played,
            COALESCE(SUM(CASE WHEN p.gf > p.ga THEN 1 ELSE 0 END), 0)::int AS wins,
            COALESCE(SUM(CASE WHEN p.gf = p.ga THEN 1 ELSE 0 END), 0)::int AS draws,
            COALESCE(SUM(CASE WHEN p.gf < p.ga THEN 1 ELSE 0 END), 0)::int AS losses,
            COALESCE(SUM(p.gf), 0)::int AS goals_for,
            COALESCE(SUM(p.ga), 0)::int AS goals_against,
            COALESCE(SUM(CASE WHEN p.gf > p.ga THEN 3 WHEN p.gf = p.ga THEN 1 ELSE 0 END), 0)::int AS points
     FROM clubs c
     JOIN club_seasons cs ON cs.club_id = c.id AND cs.season_id = $1
     LEFT JOIN played p ON p.club = c.id
     GROUP BY c.id, c.name
     ORDER BY points DESC, (COALESCE(SUM(p.gf), 0) - COALESCE(SUM(p.ga), 0)) DESC, goals_for DESC, c.name`,
    [seasonId],
  );
  return rows.map((r) => ({
    clubId: r.id, name: r.name, played: r.played, wins: r.wins, draws: r.draws, losses: r.losses,
    goalsFor: r.goals_for, goalsAgainst: r.goals_against, points: r.points,
  }));
}

/** Weekly fatigue recovery, scaled by the club's medical facility level. */
export async function recoverFatigue(
  c: Queryable, seasonId: string, baseRecovery: number, bonusPerLevel: number,
): Promise<void> {
  await c.query(
    `UPDATE squad_players sp
     SET fatigue = GREATEST(0, sp.fatigue * (1 - LEAST(1, $2::float8 * (1 + $3::float8 * cs.medical_level))))
     FROM club_seasons cs
     WHERE cs.club_id = sp.club_id AND cs.season_id = sp.season_id AND sp.season_id = $1`,
    [seasonId, baseRecovery, bonusPerLevel],
  );
}
