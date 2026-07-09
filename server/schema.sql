-- schema.sql — league wrapper, v1
-- Conventions: snake_case, TIMESTAMPTZ everywhere, JSONB for engine payloads
-- (attributes, tactics, events, stats) so engine types evolve without migrations.
-- State machines are enforced in-database via transition triggers; the TS mirror
-- in season-state-machine.ts is ergonomic only, SQL is the source of truth.

BEGIN;

-- ── Enums ─────────────────────────────────────────────────────────────────

CREATE TYPE season_phase AS ENUM (
  'setup',            -- pool imported, clubs created, budgets set
  'auction',          -- season-start draft
  'regular',          -- matchweeks running (incl. pre-transfer and post-transfer halves)
  'transfer_window',  -- fixed mid-season week; doubles as bye
  'playoffs',         -- top-4 knockout after the regular season (leagues of 4+)
  'season_end',       -- aging/growth applied, renegotiations, releases
  'complete'
);

CREATE TYPE matchweek_kind AS ENUM ('regular', 'transfer', 'playoff');

CREATE TYPE fixture_state AS ENUM (
  'scheduled',      -- created; lineups may or may not be in (see tactics_submissions)
  'awaiting_ht',    -- half 1 simmed; HT window open
  'final',          -- half 2 simmed
  'void'            -- admin escape hatch
);

CREATE TYPE txn_kind AS ENUM (
  'auction_win', 'pool_signing', 'transfer_fee',
  'wage_payment', 'facility_investment', 'adjustment'
);

-- ── Identity ──────────────────────────────────────────────────────────────

CREATE TABLE managers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auth sessions. id is NOT client-random: the API derives it as
-- HMAC(secret, magic-link jti), so redeeming the same link twice conflicts on
-- the PK — single-use enforcement without a token table. Cookie carries id.
CREATE TABLE sessions (
  id          UUID PRIMARY KEY,
  manager_id  UUID NOT NULL REFERENCES managers(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seasons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number          INT NOT NULL UNIQUE,               -- 1, 2, ...
  phase           season_phase NOT NULL DEFAULT 'setup',
  matchweek_count INT NOT NULL,                      -- regular weeks, excl. transfer week
  transfer_week   INT NOT NULL,                      -- fixed: after this matchweek number
  champion_club_id UUID,                             -- set when the playoff final resolves (FK added below clubs)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (transfer_week > 0 AND transfer_week < matchweek_count)
);

CREATE TABLE clubs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id  UUID NOT NULL REFERENCES managers(id),
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE seasons ADD CONSTRAINT seasons_champion_fk FOREIGN KEY (champion_club_id) REFERENCES clubs(id);

-- Per-season club economy + facilities. Facilities are season-scoped levels;
-- investment mid-season raises level via txn + UPDATE in one transaction.
CREATE TABLE club_seasons (
  club_id          UUID NOT NULL REFERENCES clubs(id),
  season_id        UUID NOT NULL REFERENCES seasons(id),
  transfer_budget  BIGINT NOT NULL,                  -- the season's configured allotment
  wage_cap         BIGINT NOT NULL,                  -- per-matchweek total wage ceiling
  -- pre-auction budget split (6b): auction_budget = what the club BRINGS to
  -- the draft (NULL = no split set = bring everything); the rest joins
  -- reserve_balance — the LIVE balance facilities and the mid-season window
  -- spend from (mutated under this row's lock; txns stay the audit trail).
  -- Reserve NEVER re-enters auction bidding, carries across seasons at the
  -- rollover growth tick, and receives half of any unspent bring at auction
  -- completion (DECISIONS.md).
  auction_budget   BIGINT CHECK (auction_budget IS NULL OR (auction_budget >= 0 AND auction_budget <= transfer_budget)),
  reserve_balance  BIGINT NOT NULL DEFAULT 0 CHECK (reserve_balance >= 0),
  training_level   INT NOT NULL DEFAULT 0 CHECK (training_level BETWEEN 0 AND 5),
  medical_level    INT NOT NULL DEFAULT 0 CHECK (medical_level BETWEEN 0 AND 5),
  -- weekly training dial (league-growth.ts): what the squad works on and how
  -- hard; intensity trades development against fatigue recovery in the tick
  training_focus   TEXT NOT NULL DEFAULT 'balanced'
    CHECK (training_focus IN ('balanced', 'possession', 'attacking', 'defending', 'physical')),
  training_intensity REAL NOT NULL DEFAULT 0.5 CHECK (training_intensity BETWEEN 0 AND 1),
  PRIMARY KEY (club_id, season_id)
);

-- ── Players ───────────────────────────────────────────────────────────────
-- players.attributes is the CURRENT state: frozen for pool players, updated at
-- season_end for contracted players. Release re-freezes at current state by
-- doing nothing. attribute_audit exists so season-end growth is inspectable.

CREATE TABLE players (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    TEXT NOT NULL,
  birth_date   DATE NOT NULL,
  position     TEXT NOT NULL,                        -- coarse: GK/DF/MF/FW + subtype
  height_cm    INT NOT NULL,
  weight_kg    INT,
  foot         TEXT NOT NULL DEFAULT 'R' CHECK (foot IN ('L','R','B')),
  market_value BIGINT NOT NULL,                      -- from TM dump; wage derivation input
  attributes   JSONB NOT NULL,                       -- engine Attributes shape
  physical     JSONB NOT NULL,                       -- engine PlayerPhysical extras (injuryProneness…)
  source_meta  JSONB NOT NULL DEFAULT '{}',          -- fbref/tm ids for pipeline re-joins
  UNIQUE (full_name, birth_date)
);

CREATE TABLE attribute_audit (
  player_id  UUID NOT NULL REFERENCES players(id),
  season_id  UUID NOT NULL REFERENCES seasons(id),
  before     JSONB NOT NULL,
  after      JSONB NOT NULL,
  reason     TEXT NOT NULL,                          -- 'season_growth' | 'aging' | 'admin'
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season_id, reason)
);

-- Contract = drafted/owned. Absence of an active contract = in the frozen pool.
CREATE TABLE contracts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID NOT NULL REFERENCES players(id),
  club_id       UUID NOT NULL REFERENCES clubs(id),
  season_signed UUID NOT NULL REFERENCES seasons(id),
  wage          BIGINT NOT NULL,                     -- per matchweek
  duration      INT NOT NULL CHECK (duration BETWEEN 1 AND 4),  -- seasons
  released_at   TIMESTAMPTZ,                         -- NULL = active
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one active contract per player
CREATE UNIQUE INDEX contracts_one_active ON contracts(player_id) WHERE released_at IS NULL;

-- Per-season mutable player state, matchweek units. Row exists only while contracted.
CREATE TABLE squad_players (
  club_id            UUID NOT NULL REFERENCES clubs(id),
  season_id          UUID NOT NULL REFERENCES seasons(id),
  player_id          UUID NOT NULL REFERENCES players(id),
  fatigue            REAL NOT NULL DEFAULT 0 CHECK (fatigue BETWEEN 0 AND 1),
  -- match sharpness (condition/sharpness split): built by minutes, decayed by
  -- the bench, tick-maintained. DEFAULT = cold start: every NEW row (auction
  -- win, pool signing) arrives match-rusty; transfers clamp down explicitly.
  sharpness          REAL NOT NULL DEFAULT 0.3 CHECK (sharpness BETWEEN 0 AND 1),
  injury_weeks_left  INT NOT NULL DEFAULT 0 CHECK (injury_weeks_left >= 0),
  just_returned      BOOLEAN NOT NULL DEFAULT FALSE, -- 1.9x re-injury modifier flag
  suspended_next     BOOLEAN NOT NULL DEFAULT FALSE, -- red card → one-match ban
  season_minutes     INT NOT NULL DEFAULT 0,
  -- fractional training accrual (attr → points), applied at season_end; the
  -- live players.attributes NEVER mutates mid-season (league-growth.ts)
  training_progress  JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (season_id, player_id)
);

-- Dyadic familiarity, per club-season. Canonical ordering player_a < player_b.
CREATE TABLE familiarity (
  club_id    UUID NOT NULL REFERENCES clubs(id),
  season_id  UUID NOT NULL REFERENCES seasons(id),
  player_a   UUID NOT NULL REFERENCES players(id),
  player_b   UUID NOT NULL REFERENCES players(id),
  value      REAL NOT NULL DEFAULT 0 CHECK (value BETWEEN 0 AND 1),
  PRIMARY KEY (club_id, season_id, player_a, player_b),
  CHECK (player_a < player_b)
);

-- ── Competition structure ─────────────────────────────────────────────────

CREATE TABLE matchweeks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   UUID NOT NULL REFERENCES seasons(id),
  number      INT NOT NULL,                          -- 1..n; transfer week has its own number
  kind        matchweek_kind NOT NULL DEFAULT 'regular',
  opens_at    TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,                  -- force-complete + embargo release
  revealed_at TIMESTAMPTZ,                           -- NULL = results embargoed
  UNIQUE (season_id, number),
  CHECK (deadline_at > opens_at)
);

CREATE TABLE fixtures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  matchweek_id  UUID NOT NULL REFERENCES matchweeks(id),
  home_club_id  UUID NOT NULL REFERENCES clubs(id),
  away_club_id  UUID NOT NULL REFERENCES clubs(id),
  state         fixture_state NOT NULL DEFAULT 'scheduled',
  ht_deadline   TIMESTAMPTZ,                         -- set when entering awaiting_ht
  bookkept_at   TIMESTAMPTZ,                         -- post-match bookkeeping applied-marker; set first in its txn
  seed          TEXT NOT NULL,                       -- engine seed, fixed at creation
  neutral_venue BOOLEAN NOT NULL DEFAULT FALSE,      -- playoff final: home boost zeroed in the sim
  CHECK (home_club_id <> away_club_id)
);
CREATE INDEX fixtures_by_week ON fixtures(matchweek_id);

-- Tactics snapshot per club per half. half=1 row doubles as the lineup submission.
-- HT re-entry inserts half=2; absent half=2 row at sim time = carry half 1 forward.
CREATE TABLE tactics_submissions (
  fixture_id   UUID NOT NULL REFERENCES fixtures(id),
  club_id      UUID NOT NULL REFERENCES clubs(id),
  half         INT NOT NULL CHECK (half IN (1, 2)),
  payload      JSONB NOT NULL,                       -- engine Tactics shape
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,       -- true when auto-filled at deadline
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, club_id, half)
);

-- Standing default tactics per club (auto-complete source).
CREATE TABLE default_tactics (
  club_id    UUID PRIMARY KEY REFERENCES clubs(id),
  payload    JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Results ───────────────────────────────────────────────────────────────
-- Events + stats are permanent (small); frames are prunable (bulky), hence split.
-- Decision recorded: replays pruned after 4 matchweeks, events/stats forever.

CREATE TABLE half_results (
  fixture_id  UUID NOT NULL REFERENCES fixtures(id),
  half        INT NOT NULL CHECK (half IN (1, 2)),
  events      JSONB NOT NULL,                        -- MatchEvent[]
  stats       JSONB NOT NULL,                        -- HalfStats
  end_state   JSONB NOT NULL,                        -- HalfTimeState
  simmed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, half)
);

CREATE TABLE replay_frames (
  fixture_id  UUID NOT NULL REFERENCES fixtures(id),
  half        INT NOT NULL CHECK (half IN (1, 2)),
  frames      JSONB NOT NULL,                        -- ReplayFrame[]
  PRIMARY KEY (fixture_id, half)
);

-- ── Economy ───────────────────────────────────────────────────────────────

CREATE TABLE transactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  UUID NOT NULL REFERENCES seasons(id),
  kind       txn_kind NOT NULL,
  club_id    UUID NOT NULL REFERENCES clubs(id),     -- debited club
  to_club_id UUID REFERENCES clubs(id),              -- credited club (transfers), NULL otherwise
  player_id  UUID REFERENCES players(id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  memo       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX txn_by_club_season ON transactions(club_id, season_id);

-- Auction: lots opened per player, sealed or open bids; resolution writes
-- contract + auction_win txn atomically in app code.
CREATE TABLE auction_lots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  UUID NOT NULL REFERENCES seasons(id),
  player_id  UUID NOT NULL REFERENCES players(id),
  opens_at   TIMESTAMPTZ NOT NULL,
  closes_at  TIMESTAMPTZ NOT NULL,
  won_by     UUID REFERENCES clubs(id),
  UNIQUE (season_id, player_id)
);

CREATE TABLE auction_bids (
  lot_id     UUID NOT NULL REFERENCES auction_lots(id),
  club_id    UUID NOT NULL REFERENCES clubs(id),
  amount     BIGINT NOT NULL CHECK (amount > 0),
  placed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lot_id, club_id, placed_at)
);

-- ── End-of-season playoffs ────────────────────────────────────────────────
-- Top 4 by the final table: two-leg semis (1v4, 2v3 — the HIGHER seed hosts
-- the decisive second leg) then a single neutral-venue final. A tie level on
-- aggregate (or a drawn final) goes straight to a penalty shootout — the
-- shootout result lives HERE (it decides the tie, never the 90-minute
-- scoreline). The final tie row is created once both semis resolve.

CREATE TABLE playoff_ties (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id         UUID NOT NULL REFERENCES seasons(id),
  round             TEXT NOT NULL CHECK (round IN ('semi1', 'semi2', 'final')),
  high_seed         INT NOT NULL,
  low_seed          INT NOT NULL,
  high_seed_club_id UUID NOT NULL REFERENCES clubs(id),
  low_seed_club_id  UUID NOT NULL REFERENCES clubs(id),
  leg1_fixture_id   UUID REFERENCES fixtures(id),    -- the final's single match lives here
  leg2_fixture_id   UUID REFERENCES fixtures(id),    -- NULL for the final
  winner_club_id    UUID REFERENCES clubs(id),
  shootout          JSONB,                           -- {kicks:[{playerId,side,scored}],score:[h,a]} when one decided it
  UNIQUE (season_id, round),
  CHECK (high_seed_club_id <> low_seed_club_id)
);

-- ── Mid-season transfer window ────────────────────────────────────────────
-- Inter-club offers only. On accept the fee moves buyer→seller (transfer_fee
-- txn, club_id debited / to_club_id credited) and the CONTRACT rides along
-- unchanged — wage and duration transfer with the player (DECISIONS.md).
-- Pool signings need no table: fixed price, first-come, resolved instantly
-- under the player row lock; the pool_signing txn is the record.

CREATE TYPE transfer_offer_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');

CREATE TABLE transfer_offers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id       UUID NOT NULL REFERENCES seasons(id),
  player_id       UUID NOT NULL REFERENCES players(id),
  buyer_club_id   UUID NOT NULL REFERENCES clubs(id),
  seller_club_id  UUID NOT NULL REFERENCES clubs(id),
  fee             BIGINT NOT NULL CHECK (fee > 0),
  status          transfer_offer_status NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  CHECK (buyer_club_id <> seller_club_id)
);
-- one live offer per buyer per player; re-offering replaces the fee
CREATE UNIQUE INDEX transfer_offers_one_pending
  ON transfer_offers(season_id, player_id, buyer_club_id) WHERE status = 'pending';
CREATE INDEX transfer_offers_by_seller ON transfer_offers(seller_club_id) WHERE status = 'pending';

-- ── State-machine enforcement ─────────────────────────────────────────────

CREATE FUNCTION enforce_season_transition() RETURNS trigger AS $$
DECLARE
  legal BOOLEAN;
BEGIN
  IF OLD.phase = NEW.phase THEN RETURN NEW; END IF;
  legal := (OLD.phase, NEW.phase) IN (
    ('setup',           'auction'),
    ('auction',         'regular'),
    ('regular',         'transfer_window'),
    ('transfer_window', 'regular'),
    ('regular',         'playoffs'),       -- leagues of 4+: top-4 knockout
    ('playoffs',        'season_end'),     -- the final resolved
    ('regular',         'season_end'),     -- degenerate N<4 leagues skip playoffs
    ('season_end',      'complete')
  );
  IF NOT legal THEN
    RAISE EXCEPTION 'illegal season transition % -> %', OLD.phase, NEW.phase;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER season_phase_guard BEFORE UPDATE OF phase ON seasons
  FOR EACH ROW EXECUTE FUNCTION enforce_season_transition();

CREATE FUNCTION enforce_fixture_transition() RETURNS trigger AS $$
DECLARE
  legal BOOLEAN;
BEGIN
  IF OLD.state = NEW.state THEN RETURN NEW; END IF;
  legal := (OLD.state, NEW.state) IN (
    ('scheduled',   'awaiting_ht'),
    ('awaiting_ht', 'final'),
    ('scheduled',   'void'),
    ('awaiting_ht', 'void')
  );
  IF NOT legal THEN
    RAISE EXCEPTION 'illegal fixture transition % -> %', OLD.state, NEW.state;
  END IF;
  -- entering awaiting_ht requires half-1 result + an HT deadline
  IF NEW.state = 'awaiting_ht' THEN
    IF NEW.ht_deadline IS NULL THEN
      RAISE EXCEPTION 'awaiting_ht requires ht_deadline';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM half_results h WHERE h.fixture_id = NEW.id AND h.half = 1) THEN
      RAISE EXCEPTION 'awaiting_ht requires half 1 result';
    END IF;
  END IF;
  IF NEW.state = 'final'
     AND NOT EXISTS (SELECT 1 FROM half_results h WHERE h.fixture_id = NEW.id AND h.half = 2) THEN
    RAISE EXCEPTION 'final requires half 2 result';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER fixture_state_guard BEFORE UPDATE OF state ON fixtures
  FOR EACH ROW EXECUTE FUNCTION enforce_fixture_transition();

-- Resolved offers are immutable: pending is the only state that may change.
CREATE FUNCTION enforce_offer_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'transfer offer % already resolved (%)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER transfer_offer_guard BEFORE UPDATE OF status ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION enforce_offer_transition();

-- Embargo: reveal is one-way.
CREATE FUNCTION enforce_reveal_oneway() RETURNS trigger AS $$
BEGIN
  IF OLD.revealed_at IS NOT NULL AND NEW.revealed_at IS DISTINCT FROM OLD.revealed_at THEN
    RAISE EXCEPTION 'matchweek reveal cannot be modified once set';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER matchweek_reveal_guard BEFORE UPDATE OF revealed_at ON matchweeks
  FOR EACH ROW EXECUTE FUNCTION enforce_reveal_oneway();

COMMIT;
