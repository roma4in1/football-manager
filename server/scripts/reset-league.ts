/**
 * scripts/reset-league.ts — tear a TEST league back down to zero.
 *
 * Empties the whole league graph — seasons, clubs, matchweeks, fixtures and
 * everything that hangs off them (contracts, squads, results, auctions,
 * transfers, transactions, playoffs…) — while KEEPING the two things a reset
 * should never touch: the imported `players` pool and the `managers` (so
 * setup-production.ts can re-link them). After it runs the database is a virgin
 * league again — exactly the state setup-production.ts §1.4 wants.
 *
 * ── AND SINCE 0003, "VIRGIN" MEANS TEMPLATES ────────────────────────────────
 * `players.league_id IS NULL` is what makes a player an unclaimed TEMPLATE, and
 * it is the only pool `setupSeason` will claim. Before this fix the reset kept
 * the players and left every one of them STAMPED with the id of the league it
 * had just deleted — so the database looked full and was, to the only consumer
 * that matters, empty. The failure was not silent, but it was incoherent:
 * setup-production's own dry-run printed `pool 120 players (DF 40, FW 20, GK 20,
 * MF 40)` and `--apply` then refused with `position_undersupplied: MF has 0 in
 * the pool` — against the same database, seconds apart. That is the sixth
 * instance of the league-blind family and this is its cause.
 *
 * So the teardown now does three things, in this order and in one transaction:
 *   1. TRUNCATE the graph (as before) — contracts and squads go with it, so
 *      nothing references `players` any more;
 *   2. COLLAPSE the pool to ONE ROW PER IDENTITY and un-stamp it. Phase 4 gives
 *      every league its own COPY of a player, so a database with two leagues
 *      holds two rows for the same footballer; un-stamping both would collide on
 *      `players_template_identity` (the partial unique index on
 *      (full_name, birth_date) WHERE league_id IS NULL). An existing template is
 *      preferred as the survivor, then the lowest id — and note that per-league
 *      growth may have moved the copies apart, so the survivor's attributes are
 *      one league's, not an average;
 *   3. DELETE the now-empty `leagues` rows. A league with no clubs, no seasons
 *      and no players is a ghost that phase 4 can surface — `leagueByJoinCode`
 *      would still resolve its code — and `setupSeason` creates a fresh league
 *      row anyway, so leaving them accumulates one per reset. They are DELETEd
 *      rather than TRUNCATEd: `TRUNCATE leagues CASCADE` would empty `players`
 *      as well, because CASCADE truncates every table with a foreign key to the
 *      target whether or not any row points at it.
 *
 * ☠️ THE TRUNCATE IS STILL GLOBAL, AND THAT IS RECORDED RATHER THAN FIXED.
 * It empties EVERY league on the database, not one. That was correct while a
 * database held a single league and it is the same league-blind family in a
 * third form now that phase 4 lets a user make more. Scoping it is not a
 * one-line change — TRUNCATE cannot be filtered, so it becomes ordered DELETEs
 * plus a `--league` argument, which changes this tool's contract with its only
 * caller (a human, and docs/DEPLOY.md §1.5). That is its own slice. What this
 * one does is stop it being a surprise: the plan below NAMES every league it is
 * about to remove.
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

  // THE TRUNCATE IS GLOBAL, so the plan names every league it will remove
  // rather than letting the operator infer there is only one.
  const { rows: leagues } = await pool.query<{ name: string; status: string; clubs: number; players: number }>(
    `SELECT l.name, l.status::text AS status,
            (SELECT count(*)::int FROM clubs c  WHERE c.league_id  = l.id) AS clubs,
            (SELECT count(*)::int FROM players p WHERE p.league_id = l.id) AS players
     FROM leagues l ORDER BY l.created_at, l.id`,
  );
  // what the pool does: how many rows are stamped, and how many are per-league
  // COPIES of an identity that already exists elsewhere (phase 4 makes these)
  const { rows: [poolShape] } = await pool.query<{ stamped: number; dupes: number; identities: number }>(
    `SELECT (SELECT count(*)::int FROM players WHERE league_id IS NOT NULL) AS stamped,
            (SELECT count(*)::int FROM (
               SELECT row_number() OVER (PARTITION BY full_name, birth_date
                                         ORDER BY (league_id IS NULL) DESC, id) AS rn
               FROM players) t WHERE t.rn > 1) AS dupes,
            (SELECT count(DISTINCT (full_name, birth_date))::int FROM players) AS identities`,
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
  if (leagues.length > 0) {
    console.log(`  leagues  ${leagues.length} — ALL of them are removed, not just one:`);
    for (const l of leagues) console.log(`    − ${l.name} (${l.status}) — ${l.clubs} club(s), ${l.players} player row(s)`);
  }
  console.log(`  keep     ${KEPT_TABLES.map((t) => `${t} ${counts[t]}`).join(', ')}`);
  console.log(`  pool     ${counts.players} player row(s) → ${poolShape.identities} template(s)` +
    `${poolShape.dupes > 0 ? ` (${poolShape.dupes} per-league copies collapsed)` : ''}` +
    `${poolShape.stamped > 0 ? `; ${poolShape.stamped} row(s) return to league_id NULL` : ''}`);
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

  // "Already empty" has to mean the POOL too, not just the graph. A database
  // reset by the OLD form has an empty graph and a pool still stamped to a
  // deleted league — the exact state this fix exists for — so an early exit on
  // the graph alone would refuse to repair it.
  const poolNeedsWork = poolShape.stamped > 0 || poolShape.dupes > 0 || leagues.length > 0;
  if (totalToDelete === 0 && !poolNeedsWork) {
    console.log('nothing to delete — the league is already empty and the pool is all templates');
    process.exit(0);
  }

  await pool.query('BEGIN');
  try {
    // 1. the graph. players/managers/sessions are not dependents of these four
    //    roots, so CASCADE never reaches them.
    await pool.query('TRUNCATE seasons, clubs, matchweeks, fixtures CASCADE');

    // 2. THE POOL RETURNS TO TEMPLATES. One row per identity first — two
    //    leagues hold two copies of the same footballer and un-stamping both
    //    would collide on players_template_identity. Prefer a row that is
    //    already a template, then the lowest id.
    await pool.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (PARTITION BY full_name, birth_date
                                       ORDER BY (league_id IS NULL) DESC, id) AS rn
         FROM players
       )
       DELETE FROM players p USING ranked r WHERE p.id = r.id AND r.rn > 1`,
    );
    await pool.query('UPDATE players SET league_id = NULL WHERE league_id IS NOT NULL');

    // 3. the league rows themselves, now that nothing references them. DELETE,
    //    never TRUNCATE: TRUNCATE leagues CASCADE would empty players too.
    await pool.query('DELETE FROM leagues');

    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }

  // ── verify the reset landed and the pool survived ──────────────────────────
  const { rows: [after] } = await pool.query<{
    seasons: number; clubs: number; leagues: number; players: number; templates: number; managers: number;
  }>(
    `SELECT (SELECT count(*)::int FROM seasons)  AS seasons,
            (SELECT count(*)::int FROM clubs)    AS clubs,
            (SELECT count(*)::int FROM leagues)  AS leagues,
            (SELECT count(*)::int FROM players)  AS players,
            (SELECT count(*)::int FROM players WHERE league_id IS NULL) AS templates,
            (SELECT count(*)::int FROM managers) AS managers`,
  );
  console.log('done — league torn down:');
  console.log(`  seasons ${after.seasons}, clubs ${after.clubs}, leagues ${after.leagues} (emptied)`);
  console.log(`  players ${after.players}, managers ${after.managers} (kept)`);
  console.log(`  templates ${after.templates} of ${after.players} — this is the pool setupSeason will claim`);
  if (after.templates !== after.players) {
    fail(`${after.players - after.templates} player row(s) are still stamped with a league after the reset — ` +
      'the pool would look full and read as empty. Inspect before running setup-production.ts.');
  }
  console.log('next: setup-production.ts can create a fresh season on this virgin league (docs/DEPLOY.md §1.4)');
} finally {
  await pool.end();
}
