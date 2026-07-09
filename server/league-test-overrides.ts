/**
 * league-test-overrides.ts — TEST-ONLY env knobs, in one place so they are
 * findable, loudly logged at boot (league-server.ts), and impossible to ship
 * silently (an env var shows up in `fly config show`; an edited working tree
 * deployed via --local-only does not — see DECISIONS.md, the 5s timer).
 *
 * docs/DEPLOY.md's go-live checklist requires ALL of these unset:
 *   AUCTION_LOT_SECONDS_TEST        fast auction lots (league-server.ts)
 *   MATCHWEEK_CADENCE_MINUTES_TEST  short matchweeks (here)
 *   TEST_FORCE_WEEK_CLOSE           the force-close admin endpoint (here)
 */

import { LEAGUE_CFG } from '@fm/engine/config';

/** Matchweek deadline spacing — the REAL cadence unless the test var is set. */
export function matchweekCadenceMs(): number {
  const raw = process.env.MATCHWEEK_CADENCE_MINUTES_TEST;
  if (!raw) return LEAGUE_CFG.matchweekCadenceDays * 86_400_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('MATCHWEEK_CADENCE_MINUTES_TEST must be a positive number of minutes');
  }
  return minutes * 60_000;
}

export const cadenceOverrideActive = (): boolean => Boolean(process.env.MATCHWEEK_CADENCE_MINUTES_TEST);

/** The force-week-close admin endpoint only exists when this is set. */
export const forceWeekCloseEnabled = (): boolean => process.env.TEST_FORCE_WEEK_CLOSE === '1';
