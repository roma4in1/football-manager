/**
 * league-reset-league.test.ts — the guarded league teardown (scripts/
 * reset-league.ts), the safety net that must never wipe a real friends'
 * season.
 *
 * Two layers, matching the two locks:
 *  • the pure classifier (reset-league-guard.ts) — decides safe vs refuse with
 *    no DB/DNS, so the "refuses a real league" property is deterministic;
 *  • the script for real (child process) against a populated local database —
 *    dry-run writes nothing, and --confirm empties the whole league graph
 *    (fixtures, contracts, squads, transactions…) while KEEPING players +
 *    managers so setup-production can re-link them.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';
import { setupSeason } from './league-setup.ts';
import { classifyReset, isTestEmail } from './scripts/reset-league-guard.ts';

// ── the pure guard: deterministic, the real safety property ─────────────────

test('isTestEmail: sub-addressing and reserved/demo domains are test; real inboxes are not', () => {
  assert.equal(isTestEmail('you+alpha@gmail.com'), true);   // one human, many "clubs"
  assert.equal(isTestEmail('alice@demo.io'), true);         // seed-demo domain
  assert.equal(isTestEmail('friend@example.com'), true);    // RFC 2606 reserved
  assert.equal(isTestEmail('bob@mailinator.com'), true);
  assert.equal(isTestEmail('realfriend@gmail.com'), false);
  assert.equal(isTestEmail('jane.doe@outlook.com'), false);
  assert.equal(isTestEmail('not-an-email'), false);
});

test('classifyReset: refuses a real league on a remote host, allows the safe cases', () => {
  const remote = 'aws-0-eu-west-3.pooler.supabase.com';

  // a real friends' league on production → REFUSE
  const real = classifyReset({ host: remote, seasonCount: 1, clubEmails: ['a@gmail.com', 'b@outlook.com'] });
  assert.equal(real.safe, false);
  assert.match(real.reason, /real manager emails/);
  assert.deepEqual(real.realEmails, ['a@gmail.com', 'b@outlook.com']);

  // even one real inbox among test ones is enough to refuse
  assert.equal(classifyReset({ host: remote, seasonCount: 1, clubEmails: ['x+1@gmail.com', 'b@outlook.com'] }).safe, false);

  // all-test emails on a remote host → SAFE (a remote test season)
  assert.equal(classifyReset({ host: remote, seasonCount: 1, clubEmails: ['x+1@gmail.com', 'x+2@gmail.com'] }).safe, true);

  // no season → SAFE (nothing real to protect), whatever the host
  assert.equal(classifyReset({ host: remote, seasonCount: 0, clubEmails: [] }).safe, true);

  // local host → SAFE even with real-looking emails (a dev database)
  assert.equal(classifyReset({ host: 'localhost', seasonCount: 1, clubEmails: ['a@gmail.com'] }).safe, true);
});

// ── the script for real, against a populated local database ─────────────────

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const run = promisify(execFile);
let pool: pg.Pool;

const script = async (args: string[]) => {
  try {
    const { stdout, stderr } = await run('node', args, {
      cwd: new URL('./scripts/', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

const count = async (table: string): Promise<number> =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

/** A populated league: season, 2 clubs, and rows in the deep dependent tables
 *  (matchweek, fixture, contract, squad, transaction) to prove the CASCADE. */
async function seedPopulatedLeague(): Promise<void> {
  const players = await seedPoolPlayers(pool, 2 * LEAGUE_CFG.squadMin + 8);
  const { seasonId, clubIds } = await setupSeason(pool, {
    clubs: [
      { name: 'Alpha FC', managerEmail: 'alice@demo.io' },
      { name: 'Beta United', managerEmail: 'bob@demo.io' },
    ],
  });
  const [homeId, awayId] = clubIds;
  const mw = await pool.query(
    `INSERT INTO matchweeks (season_id, number, opens_at, deadline_at)
     VALUES ($1, 1, now(), now() + interval '7 days') RETURNING id`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed) VALUES ($1, $2, $3, 'seed-x')`,
    [mw.rows[0].id, homeId, awayId],
  );
  await pool.query(
    `INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 1000, 2)`,
    [players[0], homeId, seasonId],
  );
  await pool.query(
    `INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`,
    [homeId, seasonId, players[0]],
  );
  await pool.query(
    `INSERT INTO transactions (season_id, kind, club_id, amount) VALUES ($1, 'auction_win', $2, 5000)`,
    [seasonId, homeId],
  );
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  await seedPopulatedLeague();
});

after(async () => {
  await pool?.end();
});

test('dry-run (no --confirm): prints the plan and writes NOTHING', async () => {
  const { code, out } = await script(['reset-league.ts']);
  assert.equal(code, 0, out);
  assert.match(out, /dry-run complete/);
  assert.match(out, /✓ SAFE/);
  // untouched
  assert.equal(await count('seasons'), 1);
  assert.equal(await count('clubs'), 2);
  assert.equal(await count('fixtures'), 1);
  assert.equal(await count('contracts'), 1);
});

test('--confirm: empties the league graph (CASCADE) but keeps players + managers', async () => {
  const playersBefore = await count('players');
  const managersBefore = await count('managers');

  const { code, out } = await script(['reset-league.ts', '--confirm']);
  assert.equal(code, 0, out);
  assert.match(out, /done — league torn down/);

  for (const t of ['seasons', 'clubs', 'club_seasons', 'matchweeks', 'fixtures', 'contracts', 'squad_players', 'transactions']) {
    assert.equal(await count(t), 0, `${t} should be empty after reset`);
  }
  // the pool and the managers survive — a virgin league, ready for setup-production
  assert.equal(await count('players'), playersBefore);
  assert.equal(await count('managers'), managersBefore);
  assert.ok(playersBefore > 0 && managersBefore === 2);
});

test('--confirm on the now-empty league: no season → safe, nothing to delete', async () => {
  const { code, out } = await script(['reset-league.ts', '--confirm']);
  assert.equal(code, 0, out);
  assert.match(out, /already empty|no season exists/);
});
