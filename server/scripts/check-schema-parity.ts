/**
 * scripts/check-schema-parity.ts — the invariant that makes the dual-write safe.
 *
 * server/schema.sql stays the canonical, readable, comment-rich description of
 * the CURRENT schema (tests, CI smoke and seed-demo all bootstrap from it), and
 * server/migrations/ is the path an EXISTING database walks to reach that same
 * state. Every schema change is therefore written twice. This check is what
 * stops the two from drifting:
 *
 *   database A ← psql -f schema.sql
 *   database B ← the full migration chain (0001_baseline + everything after)
 *   pg_dump --schema-only both, normalize, diff. They must be identical.
 *
 * Today, with only the frozen baseline, this passes trivially — the baseline IS
 * schema.sql. It becomes load-bearing with the first real migration, and from
 * then on it exercises every ALTER on every CI run (the fresh-install path
 * otherwise never runs them).
 *
 * Requires `psql` and `pg_dump` on PATH and a superuser-ish DATABASE_URL it can
 * CREATE DATABASE from — a local docker Postgres or the CI service container.
 * NEVER point this at production: it creates and drops scratch databases.
 *
 * Usage (from server/):
 *   DATABASE_URL='postgres://postgres:fm@localhost:54329/fm_test' node scripts/check-schema-parity.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isLocalHost } from './reset-league-guard.ts';

const run = promisify(execFile);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is required (a LOCAL/CI Postgres — this script creates and drops databases)');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const url = new URL(DATABASE_URL);
if (!isLocalHost(url.hostname) && process.env.ALLOW_REMOTE_PARITY !== '1') {
  fail(`refusing to run against a non-local host (${url.hostname}) — this script CREATEs and DROPs databases`);
}

const A = 'schema_parity_from_schema_sql';
const B = 'schema_parity_from_migrations';

const urlFor = (db: string): string => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

const psql = (db: string, args: string[]) => run('psql', [urlFor(db), '-v', 'ON_ERROR_STOP=1', '-q', ...args]);
const admin = (sql: string) => run('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql]);

/**
 * Normalize a schema dump so the comparison is about STRUCTURE:
 *  - drop psql/pg_dump header lines and blank lines
 *  - drop `\restrict`/`\unrestrict` — pg_dump 18+ wraps its output in these and
 *    the token is random PER INVOCATION, so they differ on every single run
 *  - drop the runner's own bookkeeping table (present in B, absent in A by design)
 */
function normalize(dump: string): string[] {
  const lines = dump.split('\n');
  const out: string[] = [];
  let skippingBookkeeping = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '' || line.startsWith('--') || line.startsWith('SET ') || line.startsWith('SELECT pg_catalog.set_config')) continue;
    if (line.startsWith('\\restrict') || line.startsWith('\\unrestrict')) continue;
    if (/^CREATE TABLE public\.schema_migrations/.test(line)) { skippingBookkeeping = true; continue; }
    if (skippingBookkeeping) { if (line === ');') skippingBookkeeping = false; continue; }
    if (/schema_migrations/.test(line)) continue; // its ALTER/constraint lines
    out.push(line);
  }
  return out;
}

const cwd = new URL('..', import.meta.url).pathname;

try {
  for (const db of [A, B]) {
    await admin(`DROP DATABASE IF EXISTS ${db}`);
    await admin(`CREATE DATABASE ${db}`);
  }

  // A — the canonical file, exactly as DEPLOY.md §1.3 and the tests apply it
  await psql(A, ['-f', 'schema.sql']);

  // B — an empty database walked through the whole migration chain
  const { stdout } = await run('node', ['scripts/migrate.ts', '--confirm'], {
    cwd,
    env: { ...process.env, DATABASE_URL: urlFor(B) },
  });
  const ranBaseline = /\+ 0001_baseline applied/.test(stdout);
  if (!ranBaseline) fail(`the runner did not RUN the baseline against an empty database — it should never adopt there:\n${stdout}`);

  const dumpOf = async (db: string): Promise<string[]> => {
    const { stdout } = await run('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', '--schema=public', urlFor(db)]);
    return normalize(stdout);
  };

  const [dumpA, dumpB] = await Promise.all([dumpOf(A), dumpOf(B)]);

  // Set difference, not a positional diff: inserting one table shifts every
  // later line and a line-by-line report would bury the real change in noise.
  const multisetDiff = (from: string[], minus: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const l of minus) counts.set(l, (counts.get(l) ?? 0) + 1);
    const out: string[] = [];
    for (const l of from) {
      const n = counts.get(l) ?? 0;
      if (n > 0) counts.set(l, n - 1);
      else out.push(l);
    }
    return out;
  };

  const onlyCanonical = multisetDiff(dumpA, dumpB);
  const onlyMigrated = multisetDiff(dumpB, dumpA);

  if (onlyCanonical.length > 0 || onlyMigrated.length > 0) {
    console.error('✗ schema.sql and the migration chain DISAGREE:');
    for (const l of onlyCanonical.slice(0, 25)) console.error(`  in schema.sql only : ${l}`);
    for (const l of onlyMigrated.slice(0, 25)) console.error(`  in migrations only : ${l}`);
    fail(
      'a schema change reached one path but not the other. Every change goes in BOTH schema.sql and a new ' +
      'migration (server/migrations/README.md).',
    );
  }

  console.log(`✓ schema parity — schema.sql and the migration chain produce an identical schema (${dumpA.length} normalized lines)`);
} finally {
  for (const db of [A, B]) await admin(`DROP DATABASE IF EXISTS ${db}`).catch(() => {});
}
