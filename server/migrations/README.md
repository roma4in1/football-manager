# migrations/

Ordered, versioned, **forward-only** schema migrations. Run by
`server/scripts/migrate.ts`; recorded in the `schema_migrations` table so a
re-run is a no-op.

## The two files you touch for every schema change

A change is written **twice**, on purpose:

1. **`server/schema.sql`** — stays the canonical, readable description of the
   *current* schema. Tests (`bootstrapSchema`), the CI smoke job and
   `seed-demo.ts` all bootstrap from it, and its per-table comments are how the
   schema stays legible. Edit it as you always did.
2. **`migrations/NNNN_your-change.sql`** — the `ALTER`/`CREATE` an *existing*
   database (production) needs to reach that same state.

The duplication is safe because `scripts/check-schema-parity.ts` builds one
database from each path, `pg_dump`s both and diffs them. It runs in CI. If you
update one and not the other, CI goes red.

## Rules

- **Forward-only.** No down-migrations. The rollback path is the nightly
  encrypted `pg_dump` (docs/DEPLOY.md §8) plus `fly scale count 0` — a real
  rollback, unlike an untested `DOWN` that cannot un-drop a column's data.
- **`0001_baseline.sql` is FROZEN.** It is a byte-copy of `schema.sql` from the
  moment the runner was introduced, when the live database and `schema.sql`
  were identical. On a database that already has that schema the runner *adopts*
  it — records it, executes nothing. Editing it changes what "baseline" means
  and breaks its recorded checksum.
- **A migration is immutable once applied.** The runner checksums every file and
  refuses to run if an already-applied one has changed: the database cannot be
  re-run to match it. Fix-forward with a new migration.
- **Name them `NNNN_lower-kebab.sql`**, four digits, strictly increasing.
  Duplicate numbers are a hard error (two branches both adding `0007` must
  collide at merge, not in production). Gaps are fine.
- **Each migration runs in its own transaction.** Postgres has transactional
  DDL, so a failure mid-migration rolls that migration back *entirely* and
  leaves every earlier one applied and recorded. Do **not** write your own
  `BEGIN`/`COMMIT` — the runner owns them.

## The one trap: enum values

`ALTER TYPE season_phase ADD VALUE 'lobby'` is allowed inside a transaction on
Postgres 12+, but **the new value cannot be USED until that transaction
commits**. So this fails:

```sql
ALTER TYPE season_phase ADD VALUE 'lobby';
UPDATE seasons SET phase = 'lobby' WHERE …;   -- ✗ unsafe use of new value
```

Split it into two migrations — one that adds the value, one that uses it. Phase
4 of LOBBY-DESIGN-SPEC adds a `lobby` phase and will hit exactly this.

Also remember the state-machine triggers: `season_phase` transitions are
enforced by `enforce_season_transition()`. Adding a phase means updating that
function (a `CREATE OR REPLACE FUNCTION` in the same migration) and the TS
mirror in `season-state-machine.ts`, plus `smoke.sql`'s guards.

## Running it

```sh
# from server/ — dry-run first: prints the plan, writes nothing
DATABASE_URL='<url>' node scripts/migrate.ts
# apply
DATABASE_URL='<url>' node scripts/migrate.ts --confirm
```

See docs/DEPLOY.md §1.6 for the production procedure (back up first).
