-- smoke.sql — state-machine guard tests. Each illegal op is wrapped in a
-- savepoint and MUST raise; the DO block converts "no error" into a failure.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO managers (id, email, display_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'a@x.io', 'A'),
  ('00000000-0000-0000-0000-000000000002', 'b@x.io', 'B');

INSERT INTO seasons (id, number, matchweek_count, transfer_week) VALUES
  ('00000000-0000-0000-0000-00000000000a', 1, 14, 7);

INSERT INTO clubs (id, manager_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'Alpha'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000002', 'Beta');

INSERT INTO matchweeks (id, season_id, number, opens_at, deadline_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a',
   1, now(), now() + interval '7 days');

INSERT INTO fixtures (id, matchweek_id, home_club_id, away_club_id, seed) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 'seed-1');

-- 1. Illegal season jump setup -> regular must raise
DO $$
BEGIN
  BEGIN
    UPDATE seasons SET phase = 'regular' WHERE number = 1;
    RAISE EXCEPTION 'GUARD FAILED: setup->regular was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'GUARD FAILED%' THEN RAISE; END IF;  -- re-raise real failure
  END;
END $$;

-- 2. Legal path setup -> auction -> regular
UPDATE seasons SET phase = 'auction' WHERE number = 1;
UPDATE seasons SET phase = 'regular' WHERE number = 1;

-- 3. Fixture: scheduled -> awaiting_ht without half-1 result must raise
DO $$
BEGIN
  BEGIN
    UPDATE fixtures SET state = 'awaiting_ht', ht_deadline = now() + interval '12 hours'
      WHERE seed = 'seed-1';
    RAISE EXCEPTION 'GUARD FAILED: awaiting_ht without half_results was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'GUARD FAILED%' THEN RAISE; END IF;
  END;
END $$;

-- 4. With half-1 result present, transition succeeds
INSERT INTO half_results (fixture_id, half, events, stats, end_state) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 1, '[]', '{}', '{}');
UPDATE fixtures SET state = 'awaiting_ht', ht_deadline = now() + interval '12 hours'
  WHERE seed = 'seed-1';

-- 5. awaiting_ht -> final without half-2 result must raise
DO $$
BEGIN
  BEGIN
    UPDATE fixtures SET state = 'final' WHERE seed = 'seed-1';
    RAISE EXCEPTION 'GUARD FAILED: final without half-2 result was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'GUARD FAILED%' THEN RAISE; END IF;
  END;
END $$;

-- 6. With half-2 result, finalize; then reveal; then reveal mutation must raise
INSERT INTO half_results (fixture_id, half, events, stats, end_state) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 2, '[]', '{}', '{}');
UPDATE fixtures SET state = 'final' WHERE seed = 'seed-1';
UPDATE matchweeks SET revealed_at = now() WHERE number = 1;

DO $$
BEGIN
  BEGIN
    UPDATE matchweeks SET revealed_at = now() + interval '1 hour' WHERE number = 1;
    RAISE EXCEPTION 'GUARD FAILED: reveal was mutated after set';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'GUARD FAILED%' THEN RAISE; END IF;
  END;
END $$;

-- 7. Familiarity ordering constraint must reject a >= b
DO $$
BEGIN
  BEGIN
    INSERT INTO familiarity (club_id, season_id, player_a, player_b, value) VALUES
      ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a',
       '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 0.5);
    RAISE EXCEPTION 'GUARD FAILED: familiarity a>=b accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
\echo ALL GUARD TESTS PASSED
