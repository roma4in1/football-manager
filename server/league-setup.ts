/**
 * league-setup.ts — season creation for an ARBITRARY club count.
 *
 * The league was designed "8+ clubs" but only ever ran at 8; this module is
 * the one place that knows how N flows into scheduling, the transfer week,
 * and auction feasibility. Supported range: 2–10 clubs (5–10 is the real
 * league range; 2 stays for demos/tests). Odd N works via the schedule
 * generator's bye (circle method — every club byes exactly once per leg).
 *
 * Pool-supply guards run HERE, at setup time — a drained pool must fail
 * loudly at config time, never mid-auction:
 *  - completability floor: every club can reach squadMin even if the other
 *    N−1 clubs hoard to squadMax → pool ≥ (N−1)·squadMax + squadMin;
 *  - per-position floor: bestXI needs a 4-4-2 (GK 1 / DF 4 / MF 4 / FW 2)
 *    per club → each position's pool supply ≥ N × that minimum.
 */

import type pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';

export class SetupError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`season setup rejected: ${issues.join('; ')}`);
    this.name = 'SetupError';
    this.issues = issues;
  }
}

/** Regular matchweeks for N clubs: 2(N−1) even, 2N odd (one bye per leg). */
export function expectedRounds(nClubs: number): number {
  return nClubs % 2 === 0 ? 2 * (nClubs - 1) : 2 * nClubs;
}

/** bestXI's 4-4-2 demand — the per-club positional minimum a squad needs. */
export const POSITION_XI_MIN: Record<string, number> = { GK: 1, DF: 4, MF: 4, FW: 2 };

export function validatePoolSupply(
  poolByPosition: Record<string, number>,
  nClubs: number,
  squadMin: number = LEAGUE_CFG.squadMin,
  squadMax: number = LEAGUE_CFG.squadMax,
): string[] {
  const issues: string[] = [];
  const total = Object.values(poolByPosition).reduce((a, b) => a + b, 0);
  const drainSafe = (nClubs - 1) * squadMax + squadMin;
  if (total < drainSafe) {
    issues.push(
      `pool_drainable: ${total} players cannot guarantee completion — ` +
      `${nClubs - 1} clubs hoarding to squadMax ${squadMax} leaves the last below squadMin ${squadMin} (need ≥ ${drainSafe})`,
    );
  }
  for (const [position, perClub] of Object.entries(POSITION_XI_MIN)) {
    const supply = poolByPosition[position] ?? 0;
    const need = nClubs * perClub;
    if (supply < need) {
      issues.push(`position_undersupplied: ${position} has ${supply} in the pool, ${nClubs} clubs need ≥ ${need} (${perClub} each for a 4-4-2)`);
    }
  }
  return issues;
}

export interface ClubSpec {
  name: string;
  managerEmail: string;
  budget?: number;
  wageCap?: number;
}

export interface SeasonSpec {
  number?: number;
  /** the league this season belongs to (0003); one is created per setup */
  leagueName?: string;
  /**
   * PHASE 4: start a season INTO AN EXISTING LEAGUE — one created by
   * `POST /api/leagues`, whose pool `copyPoolInto` has already stamped and whose
   * clubs `POST /api/leagues/join` has already seated. Three things change when
   * it is present, and each is the same fact seen once: THE POOL IS ALREADY THIS
   * LEAGUE'S. The supply guard counts the league's rows instead of the
   * templates; no league row is inserted; and the template CLAIM is skipped,
   * because claiming would drag any un-copied template into a league that did
   * not copy it.
   */
  leagueId?: string;
  clubs: ClubSpec[];
  /** regular-week number the transfer week follows; default: halfway */
  transferAfterWeek?: number;
  defaultBudget?: number;
  defaultWageCap?: number;
  /** MUST match the auction tuning the season will run (defaults: LEAGUE_CFG) */
  squadMin?: number;
  squadMax?: number;
}

/**
 * Create a season in the auction phase for spec.clubs — N-agnostic.
 * matchweek_count is exact from N up front (the schema CHECK
 * `0 < transfer_week < matchweek_count` therefore holds at insert, not just
 * after auction completion), and the pool guards throw before any write.
 */
export async function setupSeason(
  pool: pg.Pool,
  spec: SeasonSpec,
): Promise<{ seasonId: string; clubIds: string[]; rounds: number; transferAfterWeek: number }> {
  const n = spec.clubs.length;
  const issues: string[] = [];
  if (n < 2) issues.push(`need at least 2 clubs, got ${n}`);
  if (n > 10) issues.push(`supported club range is 2–10, got ${n} (bands/auction untested beyond)`);
  const names = new Set(spec.clubs.map((c) => c.name));
  if (names.size !== n) issues.push('duplicate club names');
  if (issues.length) throw new SetupError(issues);

  const rounds = expectedRounds(n);
  const transferAfterWeek = Math.max(1, Math.min(spec.transferAfterWeek ?? Math.floor(rounds / 2), rounds - 1));

  // LEAGUE-BLIND, THE THIRD INSTANCE — and the fix is `league_id IS NULL`
  // rather than "this league's id", because THE ONLY POOL THIS SETUP WILL EVER
  // CLAIM IS THE TEMPLATES: line ~180 runs `UPDATE players SET league_id = $1
  // WHERE league_id IS NULL`. The old form counted every uncontracted row in the
  // database, so from the SECOND league onward it counted other leagues' players
  // as supply and passed for the wrong reason — while the update below would
  // have claimed only the templates it never counted. One league hid it, which
  // is the family's signature.
  // ...and PHASE 4 makes the predicate conditional rather than constant: a
  // season started into an existing league counts THAT LEAGUE's copied pool,
  // because that is the pool its auction will draw from.
  const { rows: poolRows } = spec.leagueId
    ? await pool.query(
      `SELECT p.position, count(*)::int AS n
       FROM players p
       WHERE p.league_id = $1
         AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id)
       GROUP BY p.position`,
      [spec.leagueId],
    )
    : await pool.query(
      `SELECT p.position, count(*)::int AS n
       FROM players p
       WHERE p.league_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id)
       GROUP BY p.position`,
    );
  const byPosition = Object.fromEntries(poolRows.map((r) => [r.position, Number(r.n)]));
  const supplyIssues = validatePoolSupply(byPosition, n, spec.squadMin, spec.squadMax);
  if (supplyIssues.length) throw new SetupError(supplyIssues);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // THE LEAGUE (0003). Setup still creates exactly one — self-service
    // create/join is phase 4 — but seasons and clubs are league-scoped now, so
    // it has to exist before them.
    let leagueId: string;
    if (spec.leagueId) {
      // an existing lobby league starts its season: it becomes 'active'
      await client.query(`UPDATE leagues SET status = 'active' WHERE id = $1`, [spec.leagueId]);
      leagueId = spec.leagueId;
    } else {
      const league = await client.query(
        `INSERT INTO leagues (name, status, club_capacity) VALUES ($1, 'active', $2) RETURNING id`,
        [spec.leagueName ?? 'League', Math.min(10, Math.max(2, n))],
      );
      leagueId = league.rows[0].id as string;
    }
    const season = await client.query(
      `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [spec.number ?? 1, rounds, transferAfterWeek, leagueId],
    );
    const seasonId = season.rows[0].id as string;
    await client.query(`UPDATE seasons SET phase = 'auction' WHERE id = $1`, [seasonId]);

    const clubIds: string[] = [];
    for (const club of spec.clubs) {
      // Managers are seeded-not-registered and may already exist (the
      // production setup script pre-checks emails; a rebuilt league reuses
      // them). Link by email instead of duplicating; an existing manager
      // keeps their display_name (the no-op UPDATE only makes RETURNING work).
      const manager = await client.query(
        `INSERT INTO managers (email, display_name) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [club.managerEmail, club.name],
      );
      // A PHASE-4 LEAGUE ALREADY HAS ITS CLUBS — `/leagues` seated the host and
      // `/leagues/join` seated the rest. `clubs UNIQUE (league_id, name)` is the
      // adoption key: the no-op UPDATE only exists to make RETURNING work, the
      // same idiom as the manager upsert above.
      const inserted = await client.query(
        `INSERT INTO clubs (manager_id, name, league_id) VALUES ($1, $2, $3)
         ON CONFLICT (league_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [manager.rows[0].id, club.name, leagueId],
      );
      await client.query(
        `INSERT INTO club_seasons (club_id, season_id, transfer_budget, wage_cap) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [
          inserted.rows[0].id, seasonId,
          club.budget ?? spec.defaultBudget ?? LEAGUE_CFG.defaultTransferBudget,
          club.wageCap ?? spec.defaultWageCap ?? LEAGUE_CFG.defaultWageCap,
        ],
      );
      clubIds.push(inserted.rows[0].id as string);
    }
    // THE POOL BECOMES THIS LEAGUE'S. Imported players arrive unclaimed
    // (league_id NULL = template); setting up the league claims them, which is
    // what makes `contracts_one_active` and the season-end growth pass correct
    // per league without either of them gaining a league predicate.
    // Phase 4 (many leagues) COPIES templates instead of claiming them — with
    // one league the two are equivalent, and claiming keeps this migration
    // behaviour-neutral.
    // ...and a PHASE-4 league skips the claim entirely: `copyPoolInto` already
    // stamped its rows, and claiming here would drag every remaining template
    // into a league that never copied them.
    if (!spec.leagueId) {
      await client.query(`UPDATE players SET league_id = $1 WHERE league_id IS NULL`, [leagueId]);
    }
    await client.query('COMMIT');
    return { seasonId, clubIds, rounds, transferAfterWeek };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
