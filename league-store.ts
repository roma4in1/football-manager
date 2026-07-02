/**
 * league-store.ts — typed data access for the league wrapper.
 *
 * Every function takes a pg ClientBase so callers compose them inside their own
 * transactions (the orchestrator owns transaction boundaries and row locking).
 * No business logic here beyond shaping rows into engine types.
 */

import type { ClientBase } from 'pg';
import type { HalfResult, HalfTimeState, MatchEvent, SquadPlayer, Tactics } from './engine-types.ts';
import type { FixtureState } from './season-state-machine.ts';

export interface FixtureRow {
  id: string;
  matchweekId: string;
  homeClubId: string;
  awayClubId: string;
  state: FixtureState;
  htDeadline: Date | null;
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
  seed: r.seed as string,
});

export async function getFixture(c: ClientBase, id: string, forUpdate = false): Promise<FixtureRow | null> {
  const { rows } = await c.query(
    `SELECT id, matchweek_id, home_club_id, away_club_id, state, ht_deadline, seed
     FROM fixtures WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? fixtureFromRow(rows[0]) : null;
}

export async function getMatchweek(c: ClientBase, id: string): Promise<MatchweekRow | null> {
  const { rows } = await c.query(
    `SELECT id, season_id, number, kind, opens_at, deadline_at, revealed_at FROM matchweeks WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, seasonId: r.season_id, number: r.number, kind: r.kind,
    opensAt: r.opens_at, deadlineAt: r.deadline_at, revealedAt: r.revealed_at,
  };
}

export async function listFixtures(c: ClientBase, matchweekId: string): Promise<FixtureRow[]> {
  const { rows } = await c.query(
    `SELECT id, matchweek_id, home_club_id, away_club_id, state, ht_deadline, seed
     FROM fixtures WHERE matchweek_id = $1 ORDER BY id`,
    [matchweekId],
  );
  return rows.map(fixtureFromRow);
}

/** Transaction-stable timestamp; all deadline logic compares against DB time. */
export async function dbNow(c: ClientBase): Promise<Date> {
  const { rows } = await c.query(`SELECT now() AS now`);
  return rows[0].now as Date;
}

// ── tactics ──────────────────────────────────────────────────────────────────

export async function getSubmissions(c: ClientBase, fixtureId: string, half: 1 | 2): Promise<SubmissionRow[]> {
  const { rows } = await c.query(
    `SELECT club_id, half, payload, is_default FROM tactics_submissions
     WHERE fixture_id = $1 AND half = $2 ORDER BY club_id`,
    [fixtureId, half],
  );
  return rows.map((r) => ({ clubId: r.club_id, half: r.half, payload: r.payload, isDefault: r.is_default }));
}

/** Auto-fill a missing submission from the club's standing default. No-op if already submitted. */
export async function insertDefaultSubmission(
  c: ClientBase, fixtureId: string, clubId: string, half: 1 | 2,
): Promise<void> {
  await c.query(
    `INSERT INTO tactics_submissions (fixture_id, club_id, half, payload, is_default)
     SELECT $1, $2, $3, payload, TRUE FROM default_tactics WHERE club_id = $2
     ON CONFLICT (fixture_id, club_id, half) DO NOTHING`,
    [fixtureId, clubId, half],
  );
}

// ── squads ───────────────────────────────────────────────────────────────────

export async function loadSquad(c: ClientBase, clubId: string, seasonId: string): Promise<SquadPlayer[]> {
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

/** playerId → clubId for every squad player of the given clubs this season. */
export async function squadClubMap(c: ClientBase, seasonId: string, clubIds: string[]): Promise<Map<string, string>> {
  const { rows } = await c.query(
    `SELECT player_id, club_id FROM squad_players WHERE season_id = $1 AND club_id = ANY($2)`,
    [seasonId, clubIds],
  );
  return new Map(rows.map((r) => [r.player_id, r.club_id]));
}

// ── results ──────────────────────────────────────────────────────────────────

/** Idempotent: retried jobs re-insert the identical deterministic result, conflict is ignored. */
export async function insertHalfResult(c: ClientBase, fixtureId: string, half: 1 | 2, result: HalfResult): Promise<void> {
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

export async function getHalfResult(c: ClientBase, fixtureId: string, half: 1 | 2): Promise<StoredHalfResult | null> {
  const { rows } = await c.query(
    `SELECT events, stats, end_state FROM half_results WHERE fixture_id = $1 AND half = $2`,
    [fixtureId, half],
  );
  const r = rows[0];
  return r ? { events: r.events, stats: r.stats, endState: r.end_state } : null;
}

/** State changes go through the DB trigger; an exception here is an assertion failure upstream. */
export async function transitionFixture(
  c: ClientBase, id: string, state: FixtureState, htDeadline?: Date,
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
 * Wage txns double as the bookkeeping-applied marker (single txn per fixture,
 * wages are its first write). Requires positive wages — asserted by the caller.
 */
export async function bookkeepingDone(c: ClientBase, fixtureId: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM transactions WHERE kind = 'wage_payment' AND memo = $1 LIMIT 1`,
    [bookkeepingMemo(fixtureId)],
  );
  return rows.length > 0;
}

export async function activeWageSum(c: ClientBase, clubId: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(wage), 0)::bigint AS total FROM contracts WHERE club_id = $1 AND released_at IS NULL`,
    [clubId],
  );
  return Number(rows[0].total);
}

export async function insertWageTxn(
  c: ClientBase, seasonId: string, clubId: string, amount: number, fixtureId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO transactions (season_id, kind, club_id, amount, memo)
     VALUES ($1, 'wage_payment', $2, $3, $4)`,
    [seasonId, clubId, amount, bookkeepingMemo(fixtureId)],
  );
}

/** Post-match per-player write: absolute fatigue, minutes delta, consume just_returned. */
export async function applyPlayerMatchState(
  c: ClientBase, seasonId: string, playerId: string, fatigue: number, minutes: number,
): Promise<void> {
  await c.query(
    `UPDATE squad_players
     SET fatigue = $3, season_minutes = season_minutes + $4,
         just_returned = CASE WHEN $4 > 0 THEN FALSE ELSE just_returned END
     WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId, fatigue, minutes],
  );
}

export async function applyInjury(c: ClientBase, seasonId: string, playerId: string, weeks: number): Promise<void> {
  await c.query(
    `UPDATE squad_players SET injury_weeks_left = GREATEST(injury_weeks_left, $3)
     WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId, weeks],
  );
}

export async function applySuspension(c: ClientBase, seasonId: string, playerId: string): Promise<void> {
  await c.query(
    `UPDATE squad_players SET suspended_next = TRUE WHERE season_id = $1 AND player_id = $2`,
    [seasonId, playerId],
  );
}

/** player_a < player_b enforced by CHECK; caller passes canonically ordered ids. */
export async function bumpFamiliarity(
  c: ClientBase, clubId: string, seasonId: string, playerA: string, playerB: string, increment: number,
): Promise<void> {
  await c.query(
    `INSERT INTO familiarity (club_id, season_id, player_a, player_b, value)
     VALUES ($1, $2, $3, $4, LEAST(1.0, $5))
     ON CONFLICT (club_id, season_id, player_a, player_b)
     DO UPDATE SET value = LEAST(1.0, familiarity.value + EXCLUDED.value)`,
    [clubId, seasonId, playerA, playerB, increment],
  );
}

export async function revealMatchweek(c: ClientBase, matchweekId: string): Promise<void> {
  await c.query(
    `UPDATE matchweeks SET revealed_at = now() WHERE id = $1 AND revealed_at IS NULL`,
    [matchweekId],
  );
}
