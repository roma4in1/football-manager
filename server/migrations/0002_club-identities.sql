-- 0002_club-identities.sql — accounts arc phase 2 (LOBBY-DESIGN-SPEC §2/§6).
--
-- The account's PERSISTENT club identity: name, crest, colours. Hangs off the
-- account and nothing else — no league, no season, no club — so it travels into
-- every league the account joins while competitive state resets. Phase 3's
-- league_entries will reference this row live.
--
-- Mirrored in schema.sql in the same change; the two are held together by
-- scripts/check-schema-parity.ts. Keep the DDL below character-identical to the
-- block in schema.sql or that check goes red.
--
-- Purely additive: one new table, no existing table touched, no data migrated.
-- Existing accounts simply have no identity row until they create one, which is
-- exactly the state the create-club screen keys off.

CREATE TABLE club_identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL UNIQUE REFERENCES accounts(id),
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 32),
  badge_shape     TEXT NOT NULL,
  badge_emblem    TEXT NOT NULL,
  primary_color   TEXT NOT NULL CHECK (primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color TEXT NOT NULL CHECK (secondary_color ~ '^#[0-9a-f]{6}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
