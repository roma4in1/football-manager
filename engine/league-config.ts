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

  // ── sharpness (match fitness — the second axis of the condition/sharpness
  // split; condition = fatigue). Built by playing, decayed by the bench.
  // DELIBERATELY facility-independent: play-rhythm, not health/development —
  // and it avoids stacking another rich-club vector onto facilities.
  // Curves: a weekly starter sits at 1.0; ~4–6 benched weeks → 0.76–0.64
  // (noticeable, not crippling); a returnee is match-sharp in 2–3 games.
  sharpnessColdStart: 0.3, // new signings/draftees (and the transfer clamp) — "not integrated", like familiarity
  sharpnessGainPerMatch: 0.3, // full-match gain; cameos pro-rate by minutes/90
  sharpnessDecayPerWeek: 0.06, // benched but fit: light decline
  sharpnessInjuredDecayPerWeek: 0.12, // injured can't even train match-rhythm — the "returnees start LOW" rule
  sharpnessFloor: 0.25, // decay never drops below (re-building always starts within reach)

  // ── facilities (levels 0–5 on club_seasons; economy PR) ────────────────────
  // Costs are for the NEXT level (index = current level): rising so maxing
  // both facilities (2 × 130k) exceeds a default 100k budget — real tradeoffs.
  facilityCostByLevel: [5_000, 10_000, 20_000, 35_000, 60_000],
  facilityLevelMax: 5,
  // Medical curve — real values (was placeholder). Neutral at 0; at level 5:
  // 30% of match injuries shrugged off, duration ×0.70, fatigue recovery ×1.25.
  // Injuries still happen at max medical by design.
  medicalRecoveryBonusPerLevel: 0.05, // fatigue recovery ×(1 + bonus·level)
  medicalInjuryReductionPerLevel: 0.06, // injury duration ×(1 − reduction·level), floor 0.5
  medicalInjuryAvoidPerLevel: 0.06, // P(engine injury event not applied) = level × this
  // Training facility: growth ×(1 + this·level) — consumed by league-growth.ts.
  // 0.15 (the PR #14 placeholder) let facility+intensity stack to ×3.5 and
  // rich clubs ran away in the 5-season harness; ×1.5 at level 5 is the
  // tuned ceiling (DECISIONS.md).
  trainingGrowthPerLevel: 0.10,

  // ── training focus + season-end growth (league-growth.ts) ─────────────────
  // Magnitudes are tuned against the 5-season compounding harness
  // (growth-harness.ts): the league must stay competitive — see DECISIONS.md.
  trainingWeeklyBudget: 0.12, // total attribute points per week, split across the focus group
  trainingMinutesFloor: 0.3, // benchwarmers develop at this share of a 90-minute week
  trainingIntensityRecoveryPenalty: 0.5, // recovery ×(1 + this·(0.5 − intensity)): rest heals, grinding costs
  trainingIntensityMaxGain: 1.3, // accrual multiplier at intensity 1.0 — diminishing returns past the default
  ageYouthMul: 1.6, // development speed at 17–20
  ageVeteranMul: 0.25, // development floor from 33
  ageDeclineStartAge: 30, // first season that declines
  ageDeclinePerYear: 0.2, // raw points per season per year past the start, before per-attribute weights
  ageDeclineMaxPerSeason: 1.0, // decline cap per season (raw, pre-weight)

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

  // mid-season transfer window (league-transfers.ts) — inter-club offers +
  // fixed-price pool signings; open only while phase='transfer_window'
  transferContractDuration: 2, // pool signings mid-season; no duration picker in the window

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

export const medicalInjuryAvoidProb = (medicalLevel: number): number =>
  Math.min(0.5, LEAGUE_CFG.medicalInjuryAvoidPerLevel * medicalLevel);

/** Season-end growth multiplier — the training-hook contract (next PR consumes). */
export const trainingGrowthMul = (trainingLevel: number): number =>
  1 + LEAGUE_CFG.trainingGrowthPerLevel * trainingLevel;

/** Cost to buy the NEXT facility level; null when already at the cap. */
export const facilityUpgradeCost = (currentLevel: number): number | null =>
  currentLevel >= LEAGUE_CFG.facilityLevelMax ? null : LEAGUE_CFG.facilityCostByLevel[currentLevel];
