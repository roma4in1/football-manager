/**
 * scripts/reset-league.ts — tear a TEST league back down to zero.
 *
 * Empties the whole league graph — seasons, clubs, matchweeks, fixtures and
 * everything that hangs off them (contracts, squads, results, auctions,
 * transfers, transactions, playoffs…) — with one
 *   TRUNCATE seasons, clubs, matchweeks, fixtures CASCADE;
 * while KEEPING the two things a reset should never touch: the imported
 * `players` pool and the `managers` (so setup-production.ts can re-link them).
 * After it runs the database is a virgin league again — exactly the state
 * setup-production.ts §1.4 wants.
 *
 * ☠️ THIS DELETES A LEAGUE. Two independent locks make an accidental wipe of a
 *    real friends' season impossible:
 *   1. DRY-RUN BY DEFAULT. It only writes when you pass --confirm; otherwise it
 *      connects, prints exactly what it would delete, and stops.
 *   2. TEST-SEASON GUARD. Even with --confirm it refuses unless the database is
 *      clearly NOT a real league — one of:
 *        • no season exists yet (nothing real to protect), or
 *        • DATABASE_URL points at a local host (localhost/127.0.0.1/::1 — a dev
 *          DB; the real league lives on Supabase), or
 *        • every club's manager email is a test address (sub-addressed like
 *          you+alpha@gmail.com, or an RFC-2606 / demo domain like example.com
 *          or demo.io). A real league's clubs carry real, distinct inboxes, so
 *          this refuses on the production database by construction.
 *      If a season exists with real-looking managers, it will not run — replace
 *      a real season the deliberate way (docs/DEPLOY.md §1.3 cutover), never
 *      with this tool.
 *
 * Usage (from server/, docs/DEPLOY.md §1.5):
 *   DATABASE_URL='<url>' node scripts/reset-league.ts            # dry-run: show the plan
 *   DATABASE_URL='<url>' node scripts/reset-league.ts --confirm  # execute the teardown
 */

import pg from 'pg';
import { classifyReset, isTestEmail } from './reset-league-guard.ts';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is required (the same connection string setup-production.ts uses — docs/DEPLOY.md §1.2)');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// The league graph, ordered leaf → root for a readable "what would be deleted"
// plan. TRUNCATE …CASCADE on the four roots empties all of these; players,
// managers and sessions are intentionally absent (they are kept).
const LEAGUE_TABLES = [
  'auction_bids', 'auction_lots', 'transfer_offers', 'transactions',
  'tactics_submissions', 'default_tactics', 'replay_frames', 'half_results',
  'playoff_ties', 'fixtures', 'matchweeks',
  'familiarity', 'squad_players', 'contracts', 'attribute_audit', 'club_seasons',
  'clubs', 'seasons',
];
const KEPT_TABLES = ['players', 'managers', 'sessions'];

const host = new URL(DATABASE_URL).hostname;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  console.log(`league reset — target ${host} ${confirm ? '(CONFIRM: will delete)' : '(dry-run: pass --confirm to execute)'}`);

  // ── read the current league: seasons, clubs (with manager emails), counts ──
  const { rows: seasons } = await pool.query<{ number: number; phase: string }>(
    `SELECT number, phase FROM seasons ORDER BY number`,
  );
  const { rows: clubs } = await pool.query<{ name: string; email: string }>(
    `SELECT c.name, m.email FROM clubs c JOIN managers m ON m.id = c.manager_id ORDER BY c.name`,
  );

  const counts: Record<string, number> = {};
  for (const t of [...LEAGUE_TABLES, ...KEPT_TABLES]) {
    const { rows: [r] } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = Number(r.n);
  }
  const totalToDelete = LEAGUE_TABLES.reduce((a, t) => a + counts[t], 0);

  // ── classify: is this safe to wipe? ────────────────────────────────────────
  const { safe, reason } = classifyReset({
    host,
    seasonCount: seasons.length,
    clubEmails: clubs.map((c) => c.email),
  });

  // ── print the plan ─────────────────────────────────────────────────────────
  if (seasons.length === 0) {
    console.log('  seasons  none');
  } else {
    console.log(`  seasons  ${seasons.map((s) => `#${s.number} (${s.phase})`).join(', ')}`);
  }
  if (clubs.length > 0) {
    console.log(`  clubs    ${clubs.length}`);
    for (const c of clubs) {
      console.log(`    · ${c.name} — ${c.email}${isTestEmail(c.email) ? '' : '  ⟵ real-looking'}`);
    }
  }
  console.log(`  delete   ${totalToDelete} rows across ${LEAGUE_TABLES.length} tables:`);
  for (const t of LEAGUE_TABLES) {
    if (counts[t] > 0) console.log(`    − ${t.padEnd(20)} ${counts[t]}`);
  }
  console.log(`  keep     ${KEPT_TABLES.map((t) => `${t} ${counts[t]}`).join(', ')}`);
  console.log(`  verdict  ${safe ? '✓ SAFE' : '✗ REFUSE'} — ${reason}`);

  // ── act ─────────────────────────────────────────────────────────────────────
  if (!confirm) {
    console.log(safe
      ? 'dry-run complete — re-run with --confirm to execute'
      : 'dry-run complete — this database is NOT resettable by this tool (see verdict). Nothing written.');
    process.exit(0);
  }

  if (!safe) {
    fail(`refusing to reset: ${reason}. This tool only tears down TEST leagues — never a real season. To replace a real season, use the deliberate psql cutover (docs/DEPLOY.md §1.3).`);
  }

  if (totalToDelete === 0) {
    console.log('nothing to delete — the league is already empty');
    process.exit(0);
  }

  await pool.query('BEGIN');
  try {
    // one statement clears the whole graph; players/managers/sessions are not
    // dependents of these four roots, so CASCADE never reaches them
    await pool.query('TRUNCATE seasons, clubs, matchweeks, fixtures CASCADE');
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }

  // ── verify the reset landed and the pool survived ──────────────────────────
  const { rows: [after] } = await pool.query<{ seasons: number; clubs: number; players: number; managers: number }>(
    `SELECT (SELECT count(*)::int FROM seasons)  AS seasons,
            (SELECT count(*)::int FROM clubs)    AS clubs,
            (SELECT count(*)::int FROM players)  AS players,
            (SELECT count(*)::int FROM managers) AS managers`,
  );
  console.log('done — league torn down:');
  console.log(`  seasons ${after.seasons}, clubs ${after.clubs} (emptied)`);
  console.log(`  players ${after.players}, managers ${after.managers} (kept)`);
  console.log('next: setup-production.ts can create a fresh season on this virgin league (docs/DEPLOY.md §1.4)');
} finally {
  await pool.end();
}
