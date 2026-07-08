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

  const { rows: poolRows } = await pool.query(
    `SELECT p.position, count(*)::int AS n
     FROM players p
     WHERE NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id)
     GROUP BY p.position`,
  );
  const byPosition = Object.fromEntries(poolRows.map((r) => [r.position, Number(r.n)]));
  const supplyIssues = validatePoolSupply(byPosition, n, spec.squadMin, spec.squadMax);
  if (supplyIssues.length) throw new SetupError(supplyIssues);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const season = await client.query(
      `INSERT INTO seasons (number, matchweek_count, transfer_week) VALUES ($1, $2, $3) RETURNING id`,
      [spec.number ?? 1, rounds, transferAfterWeek],
    );
    const seasonId = season.rows[0].id as string;
    await client.query(`UPDATE seasons SET phase = 'auction' WHERE id = $1`, [seasonId]);

    const clubIds: string[] = [];
    for (const club of spec.clubs) {
      const manager = await client.query(
        `INSERT INTO managers (email, display_name) VALUES ($1, $2) RETURNING id`,
        [club.managerEmail, club.name],
      );
      const inserted = await client.query(
        `INSERT INTO clubs (manager_id, name) VALUES ($1, $2) RETURNING id`,
        [manager.rows[0].id, club.name],
      );
      await client.query(
        `INSERT INTO club_seasons (club_id, season_id, transfer_budget, wage_cap) VALUES ($1, $2, $3, $4)`,
        [inserted.rows[0].id, seasonId, club.budget ?? spec.defaultBudget ?? 100_000, club.wageCap ?? spec.defaultWageCap ?? 10_000],
      );
      clubIds.push(inserted.rows[0].id as string);
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
