/**
 * scripts/migrate.ts — the schema migration runner.
 *
 * Ordered, versioned, FORWARD-ONLY migrations from server/migrations/, applied
 * in sequence, each in its own transaction, recorded in `schema_migrations` so
 * a re-run is a no-op. There are deliberately no down-migrations: at this size
 * the rollback path is the nightly encrypted pg_dump (docs/DEPLOY.md §8), which
 * is a real rollback — an untested DOWN script cannot un-drop a column's data.
 *
 * ── How it meets a database that already exists ────────────────────────────
 * The production schema was created by `psql -f schema.sql` plus a hand-run
 * `accounts` DDL, with nothing recording either. So the FIRST migration,
 * 0001_baseline.sql, is a frozen copy of schema.sql, and against a database
 * that already has that schema the runner ADOPTS it: records it as applied and
 * EXECUTES NOTHING. Before adopting it verifies every table and enum the
 * baseline declares actually exists, and refuses if any is missing — so a
 * partial hand-run session is caught rather than papered over.
 *
 * Against an empty database it runs the baseline for real. Both paths converge
 * on the same schema; that equivalence is pinned by check-schema-parity.ts.
 *
 * ── Safety (the reset-league.ts / setup-production.ts precedent) ────────────
 *   • DRY-RUN BY DEFAULT. Without --confirm it connects, prints exactly what it
 *     would do, and writes nothing — not even the bookkeeping table.
 *   • --confirm executes. A non-local target prints a production banner and a
 *     pointer to the backup step first.
 *   • An already-applied migration whose file has since been EDITED is refused
 *     outright: that is silent drift, which is the whole reason this exists.
 *
 * Usage (from server/, docs/DEPLOY.md §1.6):
 *   DATABASE_URL='<url>' node scripts/migrate.ts             # dry-run: show the plan
 *   DATABASE_URL='<url>' node scripts/migrate.ts --confirm   # apply pending migrations
 */

import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import {
  BASELINE_ID, baselineObjects, checksumOf, classifyTarget, orderMigrations,
  parseMigrationFilename, planMigrations, type AppliedRow, type MigrationFile,
} from './migrate-plan.ts';
import { isLocalHost } from './reset-league-guard.ts';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is required (the same connection string setup-production.ts uses — docs/DEPLOY.md §1.2)');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/** `schema_migrations` is the runner's own bookkeeping — deliberately NOT in
 *  schema.sql, so the schema-parity check compares game schema, not plumbing. */
const BOOKKEEPING_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT NOT NULL DEFAULT 0,
    adopted     BOOLEAN NOT NULL DEFAULT FALSE
  )`;

function loadMigrations(): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const filename of readdirSync(MIGRATIONS_DIR).sort()) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) continue; // README.md and friends
    const sql = readFileSync(new URL(filename, MIGRATIONS_DIR), 'utf8');
    files.push({ ...parsed, sql, checksum: checksumOf(sql) });
  }
  if (files.length === 0) fail(`no migrations found in ${MIGRATIONS_DIR.pathname}`);
  const ordered = orderMigrations(files);
  if (ordered[0].id !== BASELINE_ID) {
    fail(`the first migration must be ${BASELINE_ID}.sql, found ${ordered[0].id}.sql`);
  }
  return ordered;
}

const host = new URL(DATABASE_URL).hostname;
const local = isLocalHost(host);
const ordered = loadMigrations();

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  console.log(`migrate — target ${host} ${confirm ? '(CONFIRM: will apply)' : '(dry-run: pass --confirm to apply)'}`);
  if (!local) {
    console.log('  ⚠️  this is NOT a local database — it may be the live league.');
    console.log('     Take a backup first (docs/DEPLOY.md §8) and read the plan below.');
  }

  // ── read the target's state (read-only; a dry run must not even create the
  //    bookkeeping table) ──────────────────────────────────────────────────────
  const regclass = async (name: string): Promise<boolean> => {
    const { rows: [r] } = await pool.query<{ oid: string | null }>(`SELECT to_regclass($1) AS oid`, [`public.${name}`]);
    return r.oid !== null;
  };

  const hasBookkeeping = await regclass('schema_migrations');
  const hasSchema = await regclass('seasons'); // the sentinel: no seasons table ⇒ no league schema
  const state = classifyTarget({ hasBookkeeping, hasSchema });

  let applied: AppliedRow[] = [];
  if (hasBookkeeping) {
    const { rows } = await pool.query<AppliedRow>(`SELECT id, checksum FROM schema_migrations ORDER BY id`);
    applied = rows;
  }

  const plan = planMigrations(ordered, applied, state);

  // ── print the plan ─────────────────────────────────────────────────────────
  console.log(`  state    ${state}${state === 'unmanaged' ? ' — schema present, unmanaged (the baseline will be ADOPTED, not run)' : ''}`);
  console.log(`  known    ${ordered.length} migration(s) on disk, ${applied.length} recorded as applied`);

  if (plan.changed.length > 0) {
    console.log('  ✗ EDITED AFTER APPLYING:');
    for (const c of plan.changed) console.log(`    ! ${c.id}  recorded ${c.wasChecksum.slice(0, 12)}… now ${c.nowChecksum.slice(0, 12)}…`);
  }
  if (plan.missing.length > 0) {
    console.log(`  ! recorded but no longer on disk: ${plan.missing.join(', ')}`);
  }
  for (const f of plan.adopt) console.log(`    ≡ ${f.id.padEnd(34)} ADOPT (record only — nothing executed)`);
  for (const f of plan.run) console.log(`    + ${f.id.padEnd(34)} run (${f.sql.split('\n').length} lines)`);
  if (plan.adopt.length === 0 && plan.run.length === 0) console.log('    · nothing pending — the database is up to date');

  // ── refuse on drift ────────────────────────────────────────────────────────
  if (plan.changed.length > 0) {
    fail(
      `${plan.changed.length} already-applied migration(s) have been edited since. A migration is immutable once ` +
      `applied — the database cannot be re-run to match it. Restore the file(s) and put the change in a NEW migration.`,
    );
  }

  // ── verify before adopting: does the schema really match the baseline? ─────
  if (plan.adopt.length > 0) {
    const baseline = plan.adopt[0];
    const { tables, enums } = baselineObjects(baseline.sql);
    const { rows: [found] } = await pool.query<{ tables: string[]; enums: string[] }>(
      `SELECT
         (SELECT coalesce(array_agg(tablename), '{}') FROM pg_tables WHERE schemaname = 'public')     AS tables,
         (SELECT coalesce(array_agg(typname),  '{}') FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typtype = 'e')                                            AS enums`,
    );
    const missingTables = tables.filter((t) => !found.tables.includes(t));
    const missingEnums = enums.filter((e) => !found.enums.includes(e));
    if (missingTables.length > 0 || missingEnums.length > 0) {
      console.log('  ✗ baseline verification FAILED — this database does not have the baseline schema:');
      for (const t of missingTables) console.log(`    − missing table ${t}`);
      for (const e of missingEnums) console.log(`    − missing enum  ${e}`);
      fail(
        'refusing to adopt the baseline. Adopting would record a schema this database does not have, and every later ' +
        'migration would then be applied against the wrong shape. Inspect the database before going further.',
      );
    }
    console.log(`  ✓ baseline verified — all ${tables.length} tables and ${enums.length} enums present`);
  }

  // ── act ────────────────────────────────────────────────────────────────────
  if (!confirm) {
    console.log('dry-run complete — nothing written. Re-run with --confirm to apply.');
    process.exit(0);
  }

  if (plan.adopt.length === 0 && plan.run.length === 0) {
    console.log('nothing to do');
    process.exit(0);
  }

  await pool.query(BOOKKEEPING_DDL);

  for (const f of plan.adopt) {
    await pool.query(
      `INSERT INTO schema_migrations (id, checksum, duration_ms, adopted) VALUES ($1, $2, 0, TRUE)`,
      [f.id, f.checksum],
    );
    console.log(`  ≡ ${f.id} adopted (0 statements executed)`);
  }

  // Each migration is its own transaction: a failure mid-migration rolls THAT
  // migration back completely (Postgres has transactional DDL) and leaves every
  // earlier one applied and recorded. Re-running resumes at the one that failed.
  for (const f of plan.run) {
    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(f.sql);
      await client.query(
        `INSERT INTO schema_migrations (id, checksum, duration_ms) VALUES ($1, $2, $3)`,
        [f.id, f.checksum, Date.now() - started],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      console.error(`  ✗ ${f.id} FAILED — rolled back; the database is exactly as it was before this migration`);
      console.error(`    ${(err as Error).message}`);
      fail(`migration ${f.id} failed. Earlier migrations remain applied and recorded; fix the SQL and re-run.`);
    }
    client.release();
    console.log(`  + ${f.id} applied in ${Date.now() - started} ms`);
  }

  const { rows: [after] } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migrations`);
  console.log(`done — ${after.n} migration(s) recorded as applied`);
} finally {
  await pool.end();
}
