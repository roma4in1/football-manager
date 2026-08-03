-- 0003_leagues.sql — accounts arc phase 3, STEP 1: the league becomes a thing.
--
-- Everything competitive gains a league: seasons, clubs, and the league's OWN
-- COPY of the player pool. Two leagues running at once are then fully
-- independent, which is what phases 4 and 5 need.
--
-- WHY THE POOL IS COPIED AND NOT SHARED. A shared pool needs per-entry
-- attribute state, because `UPDATE players SET attributes` at season end
-- (league-store.ts) would otherwise let league A's rollover silently rewrite
-- the attributes league B is mid-season with — a corruption nothing reports.
-- Copying instead means `contracts_one_active` and the growth pass stay
-- EXACTLY as written: a league's player rows are its own, so both were already
-- correct per row. Growth, rollover, attribute_audit and the harnesses are
-- untouched by this migration.
--
-- REPORTING NOTE FOR STEP 2: this migration adds columns and does NOT change
-- behaviour. The code is still single-league — it never reads league_id — and
-- that is deliberate. Columns sitting unused is safe; a half-applied refactor
-- across schema, store, routes and web is not.
--
-- Mirrored in schema.sql in the same change. The constraint names below are the
-- ones Postgres auto-generates from schema.sql's inline declarations, and the
-- ADD COLUMNs land last in each table to match its column order — the
-- schema-parity check diffs pg_dump, so both would otherwise go red.

CREATE TYPE league_status AS ENUM (
  'lobby',      -- clubs joining by code; no season yet
  'active',     -- a season is running
  'complete'
);

CREATE TABLE leagues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  join_code        TEXT UNIQUE,
  host_account_id  UUID REFERENCES accounts(id),
  status           league_status NOT NULL DEFAULT 'lobby',
  club_capacity    INT NOT NULL DEFAULT 8 CHECK (club_capacity BETWEEN 2 AND 10),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE seasons ADD COLUMN league_id UUID REFERENCES leagues(id);
ALTER TABLE clubs   ADD COLUMN league_id UUID REFERENCES leagues(id);
ALTER TABLE players ADD COLUMN league_id UUID REFERENCES leagues(id);

-- ── THE BACKFILL — the riskiest part of this migration ──────────────────────
-- Production holds one live league's worth of data and no league row. Give it
-- one and attach everything, or the running season breaks the moment league_id
-- goes NOT NULL.
--
-- Guarded on a season EXISTING. Three states have to come out right:
--   • production      seasons present  → a league is created, everything attaches
--   • a fresh install nothing present  → no league, no rows, NOT NULL trivially holds
--   • pool imported,  players but no season (the "virgin league" setup-production
--     expects) → NO league is created and the players stay TEMPLATES (league_id
--     NULL), which is exactly right: they are not any league's pool yet.
INSERT INTO leagues (name, status, club_capacity)
SELECT 'Original league',    -- provisional; rename freely, nothing keys on it
       'active',             -- it has a season running
       GREATEST(2, LEAST(10, (SELECT count(*) FROM clubs)))
WHERE EXISTS (SELECT 1 FROM seasons);

UPDATE seasons SET league_id = (SELECT id FROM leagues ORDER BY created_at, id LIMIT 1)
 WHERE league_id IS NULL AND EXISTS (SELECT 1 FROM leagues);
UPDATE clubs   SET league_id = (SELECT id FROM leagues ORDER BY created_at, id LIMIT 1)
 WHERE league_id IS NULL AND EXISTS (SELECT 1 FROM leagues);
-- every existing player row belongs to the live league: its contracts point at
-- these rows, so they ARE that league's pool, not templates
UPDATE players SET league_id = (SELECT id FROM leagues ORDER BY created_at, id LIMIT 1)
 WHERE league_id IS NULL AND EXISTS (SELECT 1 FROM leagues);

-- ── constraints, after the backfill has given every row a league ────────────
ALTER TABLE seasons ALTER COLUMN league_id SET NOT NULL;
ALTER TABLE clubs   ALTER COLUMN league_id SET NOT NULL;
-- players.league_id stays NULLABLE on purpose: NULL is the unclaimed template.

-- global uniqueness → per-league uniqueness
ALTER TABLE seasons DROP CONSTRAINT seasons_number_key;
ALTER TABLE clubs   DROP CONSTRAINT clubs_name_key;
ALTER TABLE players DROP CONSTRAINT players_full_name_birth_date_key;

ALTER TABLE seasons ADD CONSTRAINT seasons_league_id_number_key UNIQUE (league_id, number);
ALTER TABLE clubs   ADD CONSTRAINT clubs_league_id_name_key UNIQUE (league_id, name);
ALTER TABLE players ADD CONSTRAINT players_league_id_full_name_birth_date_key UNIQUE (league_id, full_name, birth_date);

-- NULLs are DISTINCT in a unique index, so the constraint above does not stop
-- two identical unclaimed templates. This does.
CREATE UNIQUE INDEX players_template_identity ON players (full_name, birth_date) WHERE league_id IS NULL;
