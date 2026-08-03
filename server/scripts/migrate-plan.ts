/**
 * migrate-plan.ts — the pure decision layer of the migration runner, split out
 * so it is unit-testable with no database (the reset-league-guard.ts pattern).
 *
 * It answers three questions and touches nothing:
 *   1. which files in migrations/ ARE migrations, and in what order;
 *   2. given what a database says it has applied, what is pending — and has an
 *      already-applied migration been EDITED since (silent drift, refused);
 *   3. is this database empty (run the baseline), already-schema'd but
 *      unmanaged (ADOPT the baseline without running it), or already managed.
 *
 * Forward-only by decision: there are no down-migrations. See DECISIONS.md.
 */

import { createHash } from 'node:crypto';

/** The frozen first migration. Recorded, not run, on a pre-existing database. */
export const BASELINE_ID = '0001_baseline';

export interface MigrationFile {
  /** numeric prefix — the ordering key (NOT the filename, which sorts wrong past 9999) */
  version: number;
  /** filename without .sql — the primary key in schema_migrations */
  id: string;
  sql: string;
  checksum: string;
}

export interface AppliedRow {
  id: string;
  checksum: string;
}

/** sha256 of a migration's SQL — how an edit to an applied migration is caught. */
export const checksumOf = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');

/** `NNNN_lower-kebab.sql` → parts. Anything else is not a migration (README.md, .keep…). */
export function parseMigrationFilename(filename: string): { version: number; id: string } | null {
  const m = /^(\d{4})_([a-z0-9][a-z0-9-]*)\.sql$/.exec(filename);
  if (!m) return null;
  return { version: Number(m[1]), id: filename.slice(0, -4) };
}

/**
 * Order by numeric prefix. Duplicate versions are a hard error: two people
 * adding 0007 on separate branches must notice at merge, not in production
 * where apply order would be filesystem-dependent. Gaps are fine.
 */
export function orderMigrations(files: MigrationFile[]): MigrationFile[] {
  const byVersion = new Map<number, string>();
  for (const f of files) {
    const clash = byVersion.get(f.version);
    if (clash) {
      throw new Error(`duplicate migration version ${String(f.version).padStart(4, '0')}: ${clash} and ${f.id} — renumber one`);
    }
    byVersion.set(f.version, f.id);
  }
  return [...files].sort((a, b) => a.version - b.version);
}

export type TargetState =
  /** no schema at all — run every migration including the baseline */
  | 'empty'
  /** the schema exists but nothing tracks it (production, today) — adopt the baseline */
  | 'unmanaged'
  /** schema_migrations exists — apply whatever is pending */
  | 'managed';

export function classifyTarget(input: { hasBookkeeping: boolean; hasSchema: boolean }): TargetState {
  if (input.hasBookkeeping) return 'managed';
  return input.hasSchema ? 'unmanaged' : 'empty';
}

export interface MigrationPlan {
  /** migrations to RUN, in order */
  run: MigrationFile[];
  /** migrations to RECORD without running (the adopted baseline) */
  adopt: MigrationFile[];
  /** applied migrations whose file no longer matches what was applied */
  changed: { id: string; wasChecksum: string; nowChecksum: string }[];
  /** recorded in the database but absent from migrations/ */
  missing: string[];
}

/**
 * The plan. Pure: same inputs → same plan, no clock, no I/O.
 *
 * On an `unmanaged` database the baseline is ADOPTED — recorded, never run.
 * That is the whole reason this runner can meet a production database that was
 * built by hand without re-creating or altering a single object.
 */
export function planMigrations(
  ordered: MigrationFile[],
  applied: AppliedRow[],
  state: TargetState,
): MigrationPlan {
  const appliedById = new Map(applied.map((a) => [a.id, a.checksum]));

  const changed: MigrationPlan['changed'] = [];
  for (const f of ordered) {
    const was = appliedById.get(f.id);
    if (was !== undefined && was !== f.checksum) {
      changed.push({ id: f.id, wasChecksum: was, nowChecksum: f.checksum });
    }
  }

  const known = new Set(ordered.map((f) => f.id));
  const missing = applied.map((a) => a.id).filter((id) => !known.has(id));

  const pending = ordered.filter((f) => !appliedById.has(f.id));
  const adopt = state === 'unmanaged' ? pending.filter((f) => f.id === BASELINE_ID) : [];
  const adoptIds = new Set(adopt.map((f) => f.id));

  return { run: pending.filter((f) => !adoptIds.has(f.id)), adopt, changed, missing };
}

/**
 * Every table and enum type the baseline declares. Parsed from the file rather
 * than hardcoded, so it cannot fall out of step with it. Used to VERIFY that a
 * database claiming to already have the schema really does, before adopting —
 * the check that would have caught a partial hand-run DDL session.
 */
export function baselineObjects(sql: string): { tables: string[]; enums: string[] } {
  const tables = [...sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gim)].map((m) => m[1]);
  const enums = [...sql.matchAll(/^CREATE TYPE (\w+) AS ENUM/gim)].map((m) => m[1]);
  return { tables, enums };
}
