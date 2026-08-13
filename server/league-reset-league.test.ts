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
  const players = await seedPoolPlayers(pool, 2 * LEAGUE_CFG.squadMin + 8, 'Pool', null);
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

// ── THE SIXTH LEAGUE-BLIND INSTANCE'S CAUSE, on TWO leagues ─────────────────
// Every defect in this family is invisible at one league. This one needs two
// for a second reason as well: two leagues hold two COPIES of the same
// footballer, and returning both to templates would collide on
// `players_template_identity` — so the naive `SET league_id = NULL` does not
// merely leave the bug, it errors.

test('RESET RETURNS THE POOL TO TEMPLATES — across two leagues, collapsing their copies', async () => {
  // start from the empty state the previous test left, then build two leagues
  // that each hold their own copy of the same 12 identities
  await pool.query('TRUNCATE seasons, clubs, matchweeks, fixtures CASCADE');
  await pool.query('UPDATE players SET league_id = NULL');
  await pool.query(`DELETE FROM players p USING (
      SELECT id, row_number() OVER (PARTITION BY full_name, birth_date ORDER BY id) AS rn FROM players
    ) r WHERE p.id = r.id AND r.rn > 1`);
  await pool.query('DELETE FROM leagues');

  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status, club_capacity) VALUES ('League A', 'active', 2) RETURNING id`);
  const { rows: [b] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status, club_capacity) VALUES ('League B', 'active', 2) RETURNING id`);
  // each league gets its OWN COPY of every template (phase 4's copyPoolInto)
  for (const l of [a.id, b.id]) {
    await pool.query(
      `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, foot,
                            market_value, attributes, physical, source_meta, league_id)
       SELECT full_name, birth_date, position, height_cm, weight_kg, foot,
              market_value, attributes, physical, source_meta, $1
       FROM players WHERE league_id IS NULL`, [l]);
    const { rows: [m] } = await pool.query<{ id: string }>(
      `INSERT INTO managers (email, display_name) VALUES ($1, 'M') RETURNING id`,
      [`m-${l}@demo.io`]);
    await pool.query(`INSERT INTO clubs (manager_id, name, league_id) VALUES ($1, $2, $3)`,
      [m.id, `Club ${l.slice(0, 8)}`, l]);
    await pool.query(
      `INSERT INTO seasons (number, phase, matchweek_count, transfer_week, league_id)
       VALUES (1, 'regular', 14, 7, $1)`, [l]);
  }
  // and the templates are consumed, exactly as setupSeason's claim leaves them
  await pool.query(`DELETE FROM players WHERE league_id IS NULL`);

  const identities = Number((await pool.query(
    `SELECT count(DISTINCT (full_name, birth_date))::int AS n FROM players`)).rows[0].n);
  assert.equal(await count('players'), identities * 2, 'two leagues, two copies of every identity');
  assert.equal(await count('leagues'), 2);

  // the DRY-RUN names both leagues rather than implying there is one
  const dry = await script(['reset-league.ts']);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /leagues {2}2 — ALL of them are removed/);
  assert.match(dry.out, /League A/);
  assert.match(dry.out, /League B/);
  assert.match(dry.out, /per-league copies collapsed/);
  assert.equal(await count('leagues'), 2, 'a dry-run still writes nothing');

  const { code, out } = await script(['reset-league.ts', '--confirm']);
  assert.equal(code, 0, out);

  // THE POINT: every surviving row is a TEMPLATE, one per identity
  assert.equal(await count('players'), identities, 'the per-league copies collapsed to one row each');
  assert.equal(
    Number((await pool.query(`SELECT count(*)::int AS n FROM players WHERE league_id IS NULL`)).rows[0].n),
    identities,
    'every survivor is unclaimed — this is the pool setupSeason will claim',
  );
  assert.equal(await count('leagues'), 0, 'no ghost league rows survive a reset');
  assert.equal(await count('seasons'), 0);
  assert.equal(await count('clubs'), 0);
  assert.ok(await count('managers') > 0, 'managers are kept, as always');

  // AND THE TWO COUNTS AGREE: what setup-production would report is what
  // setupSeason's guard will claim — the disagreement that found this bug.
  const asSetupProductionSees = Number((await pool.query(
    `SELECT count(*)::int AS n FROM players WHERE league_id IS NULL`)).rows[0].n);
  const asTheGuardSees = Number((await pool.query(
    `SELECT count(*)::int AS n FROM players p WHERE p.league_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id)`)).rows[0].n);
  assert.equal(asSetupProductionSees, asTheGuardSees);
});
