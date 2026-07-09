/**
 * scripts/setup-production.ts — create the league on an EXISTING database.
 *
 * PRODUCTION-SAFE by construction: no bootstrapSchema, no schema drops, no
 * player seeding — it only ever INSERTs the league rows (managers/clubs/
 * club_seasons/seasons) via setupSeason, and refuses to run at all unless the
 * database looks like a virgin league (players loaded, zero seasons, zero
 * clubs). Contrast seed-demo.ts, which is LOCAL-ONLY and DESTRUCTIVE.
 *
 * Usage (docs/DEPLOY.md §1.4):
 *   DATABASE_URL='<session-pooler url>' node scripts/setup-production.ts clubs.json
 *   DATABASE_URL='<session-pooler url>' node scripts/setup-production.ts clubs.json --apply
 *
 * Dry-run is the DEFAULT: without --apply it validates everything, prints the
 * plan, and writes nothing. clubs.json is an array of
 *   { "name": "Club Name", "managerEmail": "real@address" }
 * (2 clubs for a test season, 5–10 for the real league — same file shape;
 * see scripts/clubs.example.json). Emails must be real: login links go there.
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { setupSeason, type ClubSpec } from '../league-setup.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const configPath = args.find((a) => !a.startsWith('--'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is required (the Supabase session-pooler string — docs/DEPLOY.md §1.2)');
if (!configPath) fail('usage: node scripts/setup-production.ts <clubs.json> [--apply]');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── parse + validate the club config before touching the DB ──────────────────

const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
if (!Array.isArray(raw) || raw.length === 0) fail(`${configPath}: expected a non-empty JSON array`);
const clubs: ClubSpec[] = raw.map((c: unknown, i: number) => {
  const club = c as { name?: unknown; managerEmail?: unknown };
  if (typeof club.name !== 'string' || club.name.trim() === '') fail(`${configPath}[${i}]: missing "name"`);
  const email = club.managerEmail;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(`${configPath}[${i}] (${club.name}): "managerEmail" must be a real email — login links are delivered there`);
  }
  return { name: club.name.trim(), managerEmail: email.toLowerCase() };
});
const emails = new Set(clubs.map((c) => c.managerEmail));
if (emails.size !== clubs.length) fail('duplicate manager emails — one manager, one club');

const host = new URL(DATABASE_URL).hostname;
console.log(`league setup — ${clubs.length} clubs against ${host} ${apply ? '(APPLY)' : '(dry-run: pass --apply to write)'}`);

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  // ── guards: only a virgin league is acceptable ──────────────────────────────

  const players = await pool.query(
    `SELECT position, count(*)::int AS n FROM players GROUP BY position ORDER BY position`,
  );
  const poolTotal = players.rows.reduce((a, r) => a + Number(r.n), 0);
  if (poolTotal === 0) fail('player pool is EMPTY — load the pool first (pipeline import); this script never seeds players');

  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM seasons) AS seasons,
            (SELECT count(*)::int  FROM clubs) AS clubs,
            (SELECT count(*)::int  FROM managers) AS managers`,
  );
  if (Number(counts.seasons) > 0) {
    fail(`a season already exists (${counts.seasons} season row${counts.seasons > 1 ? 's' : ''}) — refusing: this script only creates the FIRST season. Rollover owns season N+1; replacing a test league is a manual, deliberate teardown (docs/DEPLOY.md §1.4).`);
  }
  if (Number(counts.clubs) > 0) {
    fail(`${counts.clubs} club(s) already exist without a season — the database is in an unexpected half-state; inspect it before setting up`);
  }

  const { rows: existingManagers } = await pool.query(
    `SELECT email FROM managers WHERE email = ANY($1)`,
    [clubs.map((c) => c.managerEmail)],
  );
  const preExisting = new Set(existingManagers.map((r) => r.email as string));

  // ── the plan ────────────────────────────────────────────────────────────────

  console.log(`  pool     ${poolTotal} players (${players.rows.map((r) => `${r.position} ${r.n}`).join(', ')})`);
  for (const c of clubs) {
    console.log(`  club     ${c.name} — ${c.managerEmail}${preExisting.has(c.managerEmail) ? ' (manager already seeded, will link)' : ''}`);
  }

  if (!apply) {
    // setupSeason's own guards (club count 2–10, pool supply floors) run on
    // apply; replicate nothing here — just stop before any write
    console.log('dry-run complete — nothing written');
    process.exit(0);
  }

  // ── create it (setupSeason is transactional; guards inside throw pre-write) ─

  const { seasonId, clubIds, rounds, transferAfterWeek } = await setupSeason(pool, { clubs });
  const firstNominator = [...clubs.map((c) => c.name)].sort().at(-1); // snake opens with the worst seed = last name ASC

  console.log('created:');
  console.log(`  season   ${seasonId} — phase: auction`);
  console.log(`  schedule ${rounds} regular matchweeks, transfer window after week ${transferAfterWeek}`);
  console.log(`  clubs    ${clubIds.length} (each needs ${LEAGUE_CFG.squadMin} players to complete the auction)`);
  console.log(`  auction  ${firstNominator} nominates first (snake over reverse seed order; seed = club name A→Z)`);
  console.log('next: managers log in via magic link and run the auction');
} finally {
  await pool.end();
}
