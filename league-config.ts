/**
 * league-config.ts — league-layer tunables.
 *
 * Deliberately a separate namespace from the engine's CAL (engine-aggregate.ts):
 * engine knobs shape the simulation of a match and are gated by the stat
 * harness; league knobs shape everything between matches (scheduling windows,
 * recovery, facilities) and are gated by the integration suite. They must not
 * share a namespace — see DECISIONS.md.
 */

export const LEAGUE_CFG = {
  // half-time window (hours from half-1 sim)
  htHoursFresh: 12, // either manager submitted a real half-1 lineup
  htHoursDefaulted: 2, // both defaulted — nobody is waiting on the HT screen

  // post-match bookkeeping
  familiarityPerMatch: 0.05, // dyadic increment for 90 co-played minutes
  injuryWeeksMin: 1,
  injuryWeeksMax: 8,

  // between-week tick
  fatigueWeeklyRecovery: 0.4, // fraction of fatigue shed per tick (before medical scaling)

  // medical facility hooks — placeholder linear multipliers, level 0 = 1.0.
  // Facility economy isn't built yet; these only need to be monotonic and neutral at 0.
  medicalRecoveryBonusPerLevel: 0.05, // recovery ×(1 + bonus·level)
  medicalInjuryReductionPerLevel: 0.06, // injury duration ×(1 − reduction·level), floored

  // squad rules
  startersRequired: 11,
  benchMax: 9,
  htSubsMax: 5, // half-time XI swaps vs the half-1 XI; server-enforced (no re-entry either)
  squadMin: 13, // auction cannot complete until every club has at least this many
  squadMax: 18, // hard bidding ceiling — a full club cannot win another lot

  // season-start auction (league-auction.ts)
  auctionLotSeconds: 120, // initial bidding window per lot
  auctionSoftCloseSeconds: 20, // a bid with less than this left extends the close to now+this
  bidIncrementMin: 1,
  wagePerMarketValue: 0.0001, // g(mv): wage per matchweek = round(mv × this), linear v1
  auctionDefaultContractDuration: 2, // signing default; winner may adjust 1–4 while phase='auction'
  matchweekCadenceDays: 7, // schedule generation: one deadline per week

  // HTTP API (league-api.ts / league-server.ts)
  apiHost: '127.0.0.1',
  apiPort: 8080,
  authTokenTtlMinutes: 15, // magic-link validity
  sessionTtlDays: 30,
  requestLinkMax: 3, // per email, per window
  requestLinkWindowMinutes: 15,
} as const;

/** Auction signing wage — linear in market value (g in the auction spec). */
export const wageFromMarketValue = (marketValue: number): number =>
  Math.max(1, Math.round(marketValue * LEAGUE_CFG.wagePerMarketValue));

export const medicalRecoveryMul = (medicalLevel: number): number =>
  1 + LEAGUE_CFG.medicalRecoveryBonusPerLevel * medicalLevel;

export const medicalInjuryDurationMul = (medicalLevel: number): number =>
  Math.max(0.5, 1 - LEAGUE_CFG.medicalInjuryReductionPerLevel * medicalLevel);
