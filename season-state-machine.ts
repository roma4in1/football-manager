/**
 * season-state-machine.ts — TS mirror of the SQL transition guards.
 * SQL triggers are the enforcement source of truth; this module exists so the
 * server can validate/route without a DB round-trip and so illegal transitions
 * fail in tests before they fail in triggers.
 */

export type SeasonPhase =
  | 'setup' | 'auction' | 'regular' | 'transfer_window' | 'season_end' | 'complete';

export type FixtureState = 'scheduled' | 'awaiting_ht' | 'final' | 'void';

const SEASON_TRANSITIONS: Record<SeasonPhase, readonly SeasonPhase[]> = {
  setup:           ['auction'],
  auction:         ['regular'],
  regular:         ['transfer_window', 'season_end'],
  transfer_window: ['regular'],
  season_end:      ['complete'],
  complete:        [],
};

const FIXTURE_TRANSITIONS: Record<FixtureState, readonly FixtureState[]> = {
  scheduled:   ['awaiting_ht', 'void'],
  awaiting_ht: ['final', 'void'],
  final:       [],
  void:        [],
};

export const canTransitionSeason = (from: SeasonPhase, to: SeasonPhase): boolean =>
  SEASON_TRANSITIONS[from].includes(to);

export const canTransitionFixture = (from: FixtureState, to: FixtureState): boolean =>
  FIXTURE_TRANSITIONS[from].includes(to);

/** Guard: 'regular' → 'transfer_window' is only legal at the fixed halfway week. */
export const canOpenTransferWindow = (
  completedMatchweeks: number,
  transferWeekAfter: number,
): boolean => completedMatchweeks === transferWeekAfter;

/**
 * Matchweek lifecycle is not an enum column — it derives from timestamps:
 *   pending   : now < opens_at
 *   open      : opens_at <= now < deadline_at
 *   closing   : now >= deadline_at, revealed_at IS NULL  (jobs force-completing)
 *   revealed  : revealed_at IS NOT NULL
 * Reveal is one-way (SQL trigger). Force-complete job must finish all fixtures
 * (state 'final' or 'void') before setting revealed_at.
 */
export type MatchweekLifecycle = 'pending' | 'open' | 'closing' | 'revealed';

export const matchweekLifecycle = (
  now: Date, opensAt: Date, deadlineAt: Date, revealedAt: Date | null,
): MatchweekLifecycle => {
  if (revealedAt) return 'revealed';
  if (now < opensAt) return 'pending';
  if (now < deadlineAt) return 'open';
  return 'closing';
};
