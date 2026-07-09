/**
 * league-setup-production.test.ts — the production setup script, run for real
 * (child process, like an operator would) against a prepared local database.
 *
 * The properties under test are the SAFETY guards: dry-run writes nothing,
 * apply creates exactly the league rows, a second apply refuses (no duplicate
 * seasons), an empty player pool refuses, and a pre-seeded manager is LINKED
 * (no duplicate row, display_name preserved) — plus seed-demo's non-local
 * host refusal, since that script is the destructive one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const run = promisify(execFile);

let pool: pg.Pool;
let configPath: string;

const script = async (args: string[], env: Record<string, string> = {}) => {
  try {
    const { stdout, stderr } = await run('node', args, {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL, ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);

  configPath = join(mkdtempSync(join(tmpdir(), 'fm-setup-')), 'clubs.json');
  writeFileSync(configPath, JSON.stringify([
    { name: 'Alpha FC', managerEmail: 'alice@test.io' },
    { name: 'Beta United', managerEmail: 'bob@test.io' },
  ]));
});

after(async () => {
  await pool?.end();
});

test('empty player pool → refuses before any write', async () => {
  const { code, out } = await script(['scripts/setup-production.ts', configPath, '--apply']);
  assert.equal(code, 1);
  assert.match(out, /player pool is EMPTY/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM seasons')).rows[0].count), 0);
});

test('dry-run (no --apply): validates, prints the plan, writes NOTHING', async () => {
  await seedPoolPlayers(pool, 2 * LEAGUE_CFG.squadMin + 8);
  // alice is pre-seeded with her own display name — the script must plan a link
  await pool.query(`INSERT INTO managers (email, display_name) VALUES ('alice@test.io', 'Alice Original')`);

  const { code, out } = await script(['scripts/setup-production.ts', configPath]);
  assert.equal(code, 0);
  assert.match(out, /dry-run complete — nothing written/);
  assert.match(out, /alice@test\.io \(manager already seeded, will link\)/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM seasons')).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM clubs')).rows[0].count), 0);
});

test('apply: creates season+clubs, links the existing manager, opens the auction', async () => {
  const { code, out } = await script(['scripts/setup-production.ts', configPath, '--apply']);
  assert.equal(code, 0, out);
  assert.match(out, /phase: auction/);
  assert.match(out, /Beta United nominates first/); // reverse seed order — last name A→Z opens

  const season = await pool.query(`SELECT phase FROM seasons`);
  assert.equal(season.rows.length, 1);
  assert.equal(season.rows[0].phase, 'auction');
  assert.equal(Number((await pool.query('SELECT count(*) FROM clubs')).rows[0].count), 2);

  // linked, not duplicated — and her display name survived
  const alice = await pool.query(`SELECT id, display_name FROM managers WHERE email = 'alice@test.io'`);
  assert.equal(alice.rows.length, 1);
  assert.equal(alice.rows[0].display_name, 'Alice Original');
  const aliceClub = await pool.query(`SELECT name FROM clubs WHERE manager_id = $1`, [alice.rows[0].id]);
  assert.equal(aliceClub.rows[0].name, 'Alpha FC');

  // players untouched by setup (no contracts written — the auction assigns them)
  assert.equal(Number((await pool.query('SELECT count(*) FROM contracts')).rows[0].count), 0);
});

test('second apply refuses: a season already exists', async () => {
  const { code, out } = await script(['scripts/setup-production.ts', configPath, '--apply']);
  assert.equal(code, 1);
  assert.match(out, /a season already exists/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM seasons')).rows[0].count), 1);
});

test('seed-demo refuses a non-local DATABASE_URL (it drops schemas)', async () => {
  const { code, out } = await script(['scripts/seed-demo.ts'], {
    DATABASE_URL: 'postgres://postgres:x@db.example.supabase.co:5432/postgres',
  });
  assert.equal(code, 1);
  assert.match(out, /refuses non-local hosts/);
});
