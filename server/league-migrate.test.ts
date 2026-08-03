/**
 * league-migrate.test.ts — the migration runner, run for real (child process,
 * like an operator would) against prepared local databases, plus unit tests of
 * the pure planning layer.
 *
 * The properties under test are the ones the runner exists to guarantee:
 *   • an EMPTY database gets the whole chain and ends up matching schema.sql;
 *   • against the CURRENT PRODUCTION SHAPE (the baseline, unmanaged) the
 *     BASELINE ITSELF executes nothing — it is recorded, not run — and the
 *     database converges on schema.sql via the later migrations;
 *   • running twice does nothing the second time;
 *   • a dry-run writes nothing at all, not even the bookkeeping table;
 *   • adoption REFUSES when the schema is incomplete (a partial hand-run DDL
 *     session — the exact failure the accounts table was created by hand into);
 *   • an already-applied migration that has been edited is refused;
 *   • a failing migration rolls back completely and leaves earlier ones applied.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  BASELINE_ID, baselineObjects, checksumOf, classifyTarget, orderMigrations,
  parseMigrationFilename, planMigrations, type MigrationFile,
} from './scripts/migrate-plan.ts';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const TEST_DB = 'fm_migrate_test';
const run = promisify(execFile);
const serverDir = new URL('.', import.meta.url).pathname;

const urlFor = (db: string): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const TARGET_URL = urlFor(TEST_DB);

let admin: pg.Pool;
let target: pg.Pool | null = null;

/** run scripts/migrate.ts as a child process, exactly as an operator does */
const migrate = async (args: string[] = [], url = TARGET_URL) => {
  try {
    const { stdout, stderr } = await run('node', ['scripts/migrate.ts', ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: url },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

/** drop + recreate the target database, and point a fresh pool at it */
async function resetTarget(): Promise<pg.Pool> {
  if (target) { await target.end(); target = null; }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  target = new pg.Pool({ connectionString: TARGET_URL });
  return target;
}

/**
 * THE CURRENT PRODUCTION SHAPE: the BASELINE applied once, nothing tracking it.
 *
 * Deliberately NOT schema.sql. Production was created from schema.sql at the
 * moment schema.sql and the baseline were identical, and has not moved since —
 * so what production actually has is the baseline, and every later migration is
 * still owed to it. Once schema.sql gains a table that a later migration also
 * creates (0002 did), building a "production-shaped" database from schema.sql
 * would already contain that table and the migration would collide. The two are
 * only interchangeable before the first real migration exists.
 */
async function applyBaselineSchema(pool: pg.Pool): Promise<void> {
  await pool.query(readFileSync(new URL('./migrations/0001_baseline.sql', import.meta.url), 'utf8'));
}

/** what a FRESH install gets: the canonical file (tests, CI smoke, seed-demo). */
async function applyCanonicalSchema(pool: pg.Pool): Promise<void> {
  await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

/** a stable fingerprint of every table, column and enum — proves "no-op" */
async function schemaFingerprint(pool: pg.Pool): Promise<string> {
  const { rows: [r] } = await pool.query<{ f: string }>(`
    SELECT
      (SELECT coalesce(string_agg(t || ':' || c, '|' ORDER BY t, c), '')
         FROM (SELECT table_name AS t, column_name || ' ' || data_type AS c
                 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name <> 'schema_migrations') x)
      || '//' ||
      (SELECT coalesce(string_agg(typname || '=' || lbl, '|' ORDER BY typname, lbl), '')
         FROM (SELECT t.typname, e.enumlabel AS lbl
                 FROM pg_type t
                 JOIN pg_enum e ON e.enumtypid = t.oid
                 JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'public') y) AS f`);
  return r.f;
}

/** how many migrations exist on disk — the tests must not re-hardcode this
 *  every time a phase adds one (0002 broke exactly those assertions once) */
const migrationCount = (): number =>
  readdirSync(new URL('./migrations/', import.meta.url)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;

const tableExists = async (pool: pg.Pool, name: string): Promise<boolean> => {
  const { rows: [r] } = await pool.query<{ oid: string | null }>(`SELECT to_regclass($1) AS oid`, [`public.${name}`]);
  return r.oid !== null;
};

before(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
});

after(async () => {
  if (target) await target.end();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
  await admin.end();
});

/* ── the pure planning layer (no database) ────────────────────────────────── */

test('filenames: NNNN_lower-kebab.sql only', () => {
  assert.deepEqual(parseMigrationFilename('0001_baseline.sql'), { version: 1, id: '0001_baseline' });
  assert.deepEqual(parseMigrationFilename('0042_club-identities.sql'), { version: 42, id: '0042_club-identities' });
  for (const bad of ['README.md', '1_x.sql', '0001 baseline.sql', '0001_Baseline.sql', '0001_baseline.SQL', 'baseline.sql']) {
    assert.equal(parseMigrationFilename(bad), null, bad);
  }
});

test('ordering is NUMERIC and duplicate versions are a hard error', () => {
  const f = (version: number, id: string): MigrationFile => ({ version, id, sql: id, checksum: checksumOf(id) });
  const ordered = orderMigrations([f(10, '0010_j'), f(2, '0002_b'), f(1, '0001_baseline')]);
  assert.deepEqual(ordered.map((m) => m.id), ['0001_baseline', '0002_b', '0010_j']);
  assert.throws(() => orderMigrations([f(7, '0007_a'), f(7, '0007_b')]), /duplicate migration version 0007/);
});

test('classifyTarget: empty / unmanaged / managed', () => {
  assert.equal(classifyTarget({ hasBookkeeping: false, hasSchema: false }), 'empty');
  assert.equal(classifyTarget({ hasBookkeeping: false, hasSchema: true }), 'unmanaged');
  assert.equal(classifyTarget({ hasBookkeeping: true, hasSchema: true }), 'managed');
});

test('plan: unmanaged ADOPTS the baseline and RUNS the rest', () => {
  const base: MigrationFile = { version: 1, id: BASELINE_ID, sql: 'a', checksum: checksumOf('a') };
  const next: MigrationFile = { version: 2, id: '0002_x', sql: 'b', checksum: checksumOf('b') };
  const plan = planMigrations([base, next], [], 'unmanaged');
  assert.deepEqual(plan.adopt.map((m) => m.id), [BASELINE_ID]);
  assert.deepEqual(plan.run.map((m) => m.id), ['0002_x']);

  // ...but an EMPTY database runs the baseline for real
  const fresh = planMigrations([base, next], [], 'empty');
  assert.deepEqual(fresh.adopt, []);
  assert.deepEqual(fresh.run.map((m) => m.id), [BASELINE_ID, '0002_x']);
});

test('plan: an edited already-applied migration is reported as changed', () => {
  const f: MigrationFile = { version: 1, id: BASELINE_ID, sql: 'edited', checksum: checksumOf('edited') };
  const plan = planMigrations([f], [{ id: BASELINE_ID, checksum: checksumOf('original') }], 'managed');
  assert.equal(plan.changed.length, 1);
  assert.equal(plan.changed[0].id, BASELINE_ID);
  assert.deepEqual(plan.run, []);
});

test('baselineObjects parses every table and enum out of the frozen baseline', () => {
  const sql = readFileSync(new URL('./migrations/0001_baseline.sql', import.meta.url), 'utf8');
  const { tables, enums } = baselineObjects(sql);
  for (const t of ['managers', 'sessions', 'accounts', 'seasons', 'clubs', 'players', 'fixtures', 'playoff_ties']) {
    assert.ok(tables.includes(t), `expected table ${t}`);
  }
  for (const e of ['season_phase', 'matchweek_kind', 'fixture_state', 'txn_kind', 'transfer_offer_status']) {
    assert.ok(enums.includes(e), `expected enum ${e}`);
  }
});

test('the frozen baseline still contains the accounts table (phase 1, hand-run in prod)', () => {
  const sql = readFileSync(new URL('./migrations/0001_baseline.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE accounts/);
  assert.match(sql, /CREATE INDEX accounts_reset_token/);
});

/* ── the runner, against real databases ───────────────────────────────────── */

test('EMPTY database: runs the whole chain and lands on the schema.sql shape', async () => {
  const pool = await resetTarget();

  const dry = await migrate();
  assert.equal(dry.code, 0);
  assert.match(dry.out, /state {4}empty/);
  assert.match(dry.out, /\+ 0001_baseline/);
  assert.equal(await tableExists(pool, 'schema_migrations'), false, 'a dry run must not create the bookkeeping table');
  assert.equal(await tableExists(pool, 'seasons'), false, 'a dry run must not create anything');

  const applied = await migrate(['--confirm']);
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /\+ 0001_baseline applied/);

  // the resulting schema must equal what schema.sql produces
  const canonical = await resetCanonicalReference();
  assert.equal(await schemaFingerprint(pool), canonical);

  const { rows } = await pool.query<{ id: string; adopted: boolean }>(`SELECT id, adopted FROM schema_migrations ORDER BY id`);
  assert.equal(rows[0].id, BASELINE_ID);
  assert.equal(rows[0].adopted, false, 'the baseline was RUN here, not adopted');
  assert.ok(rows.every((r) => !r.adopted), 'nothing is adopted on an empty database');
  assert.equal(rows.length, migrationCount(), 'every migration on disk is recorded');
});

/** build the schema.sql fingerprint in a scratch database, then drop it */
async function resetCanonicalReference(): Promise<string> {
  const ref = 'fm_migrate_reference';
  await admin.query(`DROP DATABASE IF EXISTS ${ref} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${ref}`);
  const pool = new pg.Pool({ connectionString: urlFor(ref) });
  try {
    await applyCanonicalSchema(pool);
    return await schemaFingerprint(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${ref} WITH (FORCE)`).catch(() => {});
  }
}

test('CURRENT PRODUCTION SHAPE: adopting the baseline is a NO-OP', async () => {
  const pool = await resetTarget();
  await applyBaselineSchema(pool);             // exactly what prod has today
  const before = await schemaFingerprint(pool);

  const dry = await migrate();
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /state {4}unmanaged/);
  assert.match(dry.out, /ADOPT \(record only — nothing executed\)/);
  assert.match(dry.out, /baseline verified/);
  assert.equal(await tableExists(pool, 'schema_migrations'), false);

  const applied = await migrate(['--confirm']);
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /adopted \(0 statements executed\)/);

  const { rows } = await pool.query<{ id: string; adopted: boolean; ms: number }>(
    `SELECT id, adopted, duration_ms AS ms FROM schema_migrations ORDER BY id`);
  assert.equal(rows[0].id, BASELINE_ID);
  assert.equal(rows[0].adopted, true, 'the baseline must be ADOPTED against an existing schema');
  assert.equal(rows[0].ms, 0, 'an adopted migration runs for zero milliseconds because it runs nothing');
  assert.ok(rows.slice(1).every((r) => !r.adopted), 'only the baseline is ever adopted');
  assert.equal(rows.length, migrationCount());

  // The BASELINE changed nothing: everything the schema gained is exactly what
  // the later migrations add, and the end state is schema.sql. That is the real
  // production guarantee — prod converges on canonical without being rebuilt.
  const canonical = await resetCanonicalReference();
  assert.equal(await schemaFingerprint(pool), canonical, 'production must converge on schema.sql');
  if (migrationCount() === 1) {
    assert.equal(await schemaFingerprint(pool), before, 'with only the baseline, adoption is a total no-op');
  }
});

test('re-running is a no-op the second time', async () => {
  const pool = await resetTarget();
  await applyBaselineSchema(pool);
  await migrate(['--confirm']);
  const before = await schemaFingerprint(pool);
  const { rows: [first] } = await pool.query<{ at: string }>(`SELECT applied_at::text AS at FROM schema_migrations WHERE id = $1`, [BASELINE_ID]);

  const second = await migrate(['--confirm']);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /nothing pending — the database is up to date/);
  assert.match(second.out, /nothing to do/);

  assert.equal(await schemaFingerprint(pool), before);
  const { rows: [again] } = await pool.query<{ at: string; n: number }>(
    `SELECT applied_at::text AS at, (SELECT count(*)::int FROM schema_migrations) AS n FROM schema_migrations WHERE id = $1`, [BASELINE_ID]);
  assert.equal(again.n, migrationCount(), 'the second run inserted a duplicate bookkeeping row');
  assert.equal(again.at, first.at, 'the second run rewrote the applied_at timestamp');
});

test('adoption REFUSES when the schema is incomplete (a partial hand-run DDL session)', async () => {
  const pool = await resetTarget();
  await applyBaselineSchema(pool);
  // simulate exactly the accounts-arc risk: the table was hand-run, and wasn't
  await pool.query(`DROP INDEX accounts_reset_token`);
  await pool.query(`DROP TABLE accounts`);

  const res = await migrate(['--confirm']);
  assert.equal(res.code, 1);
  assert.match(res.out, /baseline verification FAILED/);
  assert.match(res.out, /missing table accounts/);
  assert.match(res.out, /refusing to adopt the baseline/);
  assert.equal(await tableExists(pool, 'schema_migrations'), false, 'a refused run must write nothing');
});

test('an already-applied migration that has been EDITED is refused', async () => {
  const pool = await resetTarget();
  await applyBaselineSchema(pool);
  await migrate(['--confirm']);
  // rewrite the recorded checksum to simulate the file having changed
  await pool.query(`UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = $1`, [BASELINE_ID]);

  const res = await migrate(['--confirm']);
  assert.equal(res.code, 1);
  assert.match(res.out, /EDITED AFTER APPLYING/);
  assert.match(res.out, /immutable once applied/);
});

/* ── 0003's backfill: the riskiest step in the league refactor ────────────── */

/** the live league's data, inserted at BASELINE shape (no league columns yet) */
async function seedLiveLeagueData(pool: pg.Pool): Promise<void> {
  await pool.query(`
    INSERT INTO managers (id,email,display_name) VALUES
      ('00000000-0000-0000-0000-000000000001','a@x.io','A'),
      ('00000000-0000-0000-0000-000000000002','b@x.io','B');
    INSERT INTO seasons (id,number,matchweek_count,transfer_week) VALUES
      ('00000000-0000-0000-0000-00000000000a',1,14,7);
    INSERT INTO clubs (id,manager_id,name) VALUES
      ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000001','Alpha'),
      ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000002','Beta');
    INSERT INTO players (id,full_name,birth_date,position,height_cm,market_value,attributes,physical) VALUES
      ('00000000-0000-0000-0000-0000000000f1','Contracted Player','1998-01-01','FW',180,1000,'{}','{}'),
      ('00000000-0000-0000-0000-0000000000f2','Pool Player','1999-01-01','MF',178,900,'{}','{}');
    INSERT INTO contracts (player_id,club_id,season_signed,wage,duration) VALUES
      ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000c1',
       '00000000-0000-0000-0000-00000000000a',100,2);
  `);
}

const one = async (pool: pg.Pool, sql: string): Promise<number> =>
  Number((await pool.query<{ n: string }>(sql)).rows[0].n);

test('0003 backfill: a LIVE league gets a league row and everything attaches to it', async () => {
  const pool = await resetTarget();
  await applyBaselineSchema(pool);   // production: baseline, unmanaged, with data
  await seedLiveLeagueData(pool);

  const res = await migrate(['--confirm']);
  assert.equal(res.code, 0, res.out);

  assert.equal(await one(pool, `SELECT count(*) n FROM leagues`), 1, 'exactly one league is created');
  assert.equal(await one(pool, `SELECT count(*) n FROM seasons WHERE league_id IS NULL`), 0);
  assert.equal(await one(pool, `SELECT count(*) n FROM clubs WHERE league_id IS NULL`), 0);
  // every existing player is the live league's pool — its contracts point at
  // these rows, so they are NOT unclaimed templates
  assert.equal(await one(pool, `SELECT count(*) n FROM players WHERE league_id IS NULL`), 0);
  assert.equal(await one(pool, `SELECT count(*) n FROM players WHERE league_id IS NOT NULL`), 2);
  assert.equal(
    await one(pool, `SELECT count(DISTINCT league_id) n FROM
      (SELECT league_id FROM seasons UNION SELECT league_id FROM clubs UNION SELECT league_id FROM players) x`),
    1, 'seasons, clubs and players all land on the SAME league');

  // the running league still resolves end to end
  assert.equal(await one(pool, `SELECT count(*) n FROM contracts c
     JOIN clubs cl ON cl.id = c.club_id JOIN players p ON p.id = c.player_id
     WHERE c.released_at IS NULL`), 1, 'the active contract still joins club and player');

  const { rows: [lg] } = await pool.query<{ status: string; cap: number }>(
    `SELECT status::text, club_capacity AS cap FROM leagues`);
  assert.equal(lg.status, 'active', 'a league with a running season is active, not lobby');
  assert.equal(lg.cap, 2, 'capacity comes from the real club count');
});

test('0003 backfill: a FRESH database gets NO league — leagues are created, not migrated into', async () => {
  const pool = await resetTarget();
  const res = await migrate(['--confirm']);
  assert.equal(res.code, 0, res.out);
  assert.equal(await one(pool, `SELECT count(*) n FROM leagues`), 0);
});

test('0003 backfill: pool imported but NO season leaves the players as TEMPLATES', async () => {
  // the "virgin league" state setup-production expects: the pipeline has run,
  // no league exists yet. Those players belong to nobody and must stay NULL.
  const pool = await resetTarget();
  await applyBaselineSchema(pool);
  await pool.query(
    `INSERT INTO players (full_name,birth_date,position,height_cm,market_value,attributes,physical)
     VALUES ('Pool A','1998-01-01','FW',180,1000,'{}','{}'), ('Pool B','1999-01-01','MF',178,900,'{}','{}')`);

  const res = await migrate(['--confirm']);
  assert.equal(res.code, 0, res.out);
  assert.equal(await one(pool, `SELECT count(*) n FROM leagues`), 0, 'no season ⇒ no league');
  assert.equal(await one(pool, `SELECT count(*) n FROM players WHERE league_id IS NULL`), 2,
    'unclaimed players stay templates for a future league to copy');
});

test('0003: templates cannot duplicate, and two leagues CAN hold the same player name', async () => {
  const pool = await resetTarget();
  const res = await migrate(['--confirm']);
  assert.equal(res.code, 0, res.out);

  const mk = (league: string | null, name: string) => pool.query(
    `INSERT INTO players (full_name,birth_date,position,height_cm,market_value,attributes,physical,league_id)
     VALUES ($1,'1998-01-01','FW',180,1000,'{}','{}',$2)`, [name, league]);

  await mk(null, 'Kylian Mbappé');
  // NULLs are distinct in a plain unique index — the partial index is what stops this
  await assert.rejects(() => mk(null, 'Kylian Mbappé'), /players_template_identity/,
    'two unclaimed templates of the same player are refused');

  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ('A','active') RETURNING id`);
  const { rows: [b] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ('B','active') RETURNING id`);
  // THE POINT OF THE PHASE: the same footballer exists in both leagues, as two
  // rows that develop independently
  await mk(a.id, 'Kylian Mbappé');
  await mk(b.id, 'Kylian Mbappé');
  assert.equal(await one(pool, `SELECT count(*) n FROM players WHERE full_name = 'Kylian Mbappé'`), 3);
  await assert.rejects(() => mk(a.id, 'Kylian Mbappé'), /players_league_id_full_name_birth_date_key/,
    'but not twice within one league');
});

test('0003: season numbers and club names are unique PER LEAGUE, not globally', async () => {
  const pool = await resetTarget();
  await migrate(['--confirm']);
  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ('A','active') RETURNING id`);
  const { rows: [b] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ('B','active') RETURNING id`);
  const { rows: [m] } = await pool.query<{ id: string }>(
    `INSERT INTO managers (email,display_name) VALUES ('m@x.io','M') RETURNING id`);

  const season = (lg: string) => pool.query(
    `INSERT INTO seasons (number,matchweek_count,transfer_week,league_id) VALUES (1,14,7,$1)`, [lg]);
  const club = (lg: string) => pool.query(
    `INSERT INTO clubs (manager_id,name,league_id) VALUES ($1,'Alpha',$2)`, [m.id, lg]);

  await season(a.id); await season(b.id);   // both leagues have a season 1
  await club(a.id);   await club(b.id);     // both have an "Alpha"
  await assert.rejects(() => season(a.id), /seasons_league_id_number_key/);
  await assert.rejects(() => club(a.id), /clubs_league_id_name_key/);
});

test('a failing migration rolls back completely; earlier ones stay applied', async () => {
  const pool = await resetTarget();
  await applyBaselineSchema(pool);
  await migrate(['--confirm']);                       // baseline adopted + 0002 applied

  const goodPath = new URL('./migrations/9998_parity-probe-ok.sql', import.meta.url);
  const badPath = new URL('./migrations/9999_parity-probe-bad.sql', import.meta.url);
  writeFileSync(goodPath, `CREATE TABLE migrate_probe_ok (id INT PRIMARY KEY);\n`);
  // valid first statement, then a guaranteed failure — proves the whole
  // migration rolls back, not just the failing statement
  writeFileSync(badPath, `CREATE TABLE migrate_probe_bad (id INT PRIMARY KEY);\nSELECT no_such_function_xyz();\n`);

  try {
    const res = await migrate(['--confirm']);
    assert.equal(res.code, 1);
    assert.match(res.out, /\+ 9998_parity-probe-ok applied/);
    assert.match(res.out, /9999_parity-probe-bad FAILED/);
    assert.match(res.out, /the database is exactly as it was before this migration/);

    assert.equal(await tableExists(pool, 'migrate_probe_ok'), true, 'the earlier migration must survive');
    assert.equal(await tableExists(pool, 'migrate_probe_bad'), false, 'the failed migration must leave nothing behind');
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
    // everything already on disk, plus the probe that SUCCEEDED — and nothing
    // for the one that failed
    assert.deepEqual(rows.map((r) => r.id).slice(-1), ['9998_parity-probe-ok']);
    assert.equal(rows.length, migrationCount() - 1, 'the failed probe left no bookkeeping row');
    assert.ok(!rows.some((r) => r.id === '9999_parity-probe-bad'));

    // and re-running resumes at the one that failed
    rmSync(badPath);
    const resume = await migrate(['--confirm']);
    assert.equal(resume.code, 0, resume.out);
    assert.match(resume.out, /nothing pending/);
  } finally {
    rmSync(goodPath, { force: true });
    rmSync(badPath, { force: true });
  }
});
