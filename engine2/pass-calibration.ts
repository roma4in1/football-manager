/**
 * pass-calibration.ts — the LEARNED MEMORY (tier 2): per-bucket
 * corrections mapping each pass family's PRICED completion to its
 * REALIZED rate, fitted from self-play ledgers (selfplay.ts →
 * calibrate.ts). The models were each fitted in isolation drills and
 * never paid for full-match chaos — the first 300-match batch measured
 * every family optimistic. Applied at the UTILITY site only (the raw
 * models keep serving geometry heuristics); telemetry logs the
 * calibrated price, so successive batches measure the RESIDUAL gap and
 * the table converges.
 *
 * Regenerate: node --experimental-strip-types calibrate.ts <ledger> --emit
 */

/** multiplicative shrink per bucket (type/dist band), identity = 1 */
export const PASS_CALIBRATION: Readonly<Record<string, number>> = {
  // THE TABLES LAND (run-57199, 30 matches, Jul 24) — the convergence
  // plan's own criterion arrived: the first application was REJECTED
  // when it collapsed passes/match 47.7 -> 20.8 (circularity: the old
  // defense converted so poorly that carrying measured better than it
  // was). The plan said the tables land when the equilibrium passes
  // MORE — after the step-in, the conservation EV, the laws and the
  // ceremonies, the measured equilibrium passes 122/match and the
  // defense genuinely cuts (34% of open-play passes). The gaps are now
  // HONEST hazard, not an artifact of a defense that couldn't convert.
  'ground/mid': 0.68,
  'ground/short': 0.74,
  'ground/long': 0.69,
  'driven-loft/long': 0.61,
  'float/long': 0.51,
  'curl/mid': 0.70,
  'float/mid': 0.63,
  'driven-loft/mid': 0.52,
  'curl/short': 0.76,
};

export const calibratePass = (
  loftDeg: number,
  spin: number,
  distM: number,
  pC: number,
  /** local opponent density 0..1 — the fitted shrink encodes MATCH
   * hazards, and those hazards are other bodies: full correction in
   * traffic, identity in open space (the raw table taxed open-cast
   * drills where the lanes genuinely complete — six pins measured it) */
  density = 1,
  /** density-INDEPENDENT floor on the correction blend, non-ground
   * families only: an open 30-40m float is hard to execute and control
   * regardless of opponents. Measured (fc-honesty, 12 seeds, n=62/23
   * per cell): open-space back/sq aerials priced 0.92/0.86, realized
   * 63/57% — a 29-30pp optimism the identity-at-density-0 blend
   * created, while ground families were honest everywhere (±8pp).
   * That optimism was the safe option's ESCAPE HATCH: 58% of the
   * board's backward maxes were aerial/bent balls over covered ground
   * lanes. Callers pass the floor at match scale only — the identity
   * protects open-cast DRILLS, whose ground lanes genuinely complete. */
  execFloor = 0,
): number => {
  const type = spin ? 'curl' : loftDeg >= 30 ? 'float' : loftDeg > 0 ? 'driven-loft' : 'ground';
  const d = distM < 12 ? 'short' : distM < 24 ? 'mid' : 'long';
  const k = PASS_CALIBRATION[`${type}/${d}`] ?? 1;
  const blend = Math.max(type === 'ground' ? 0 : execFloor, Math.max(0, Math.min(1, density)));
  const kEff = 1 - (1 - k) * blend;
  return Math.max(0.02, Math.min(0.98, pC * kEff));
};

/** the fitted execution floor (see execFloor above) */
export const AERIAL_EXEC_FLOOR = 0.75;

/** carry RETENTION by local pressure (density 0..1 → bucket 0..3),
 * fitted from the same ledger as the pass table — the BOTH-SIDED rule:
 * the two tables land together or not at all. Null = legacy algebra. */
export const CARRY_RETENTION: ReadonlyArray<number> | null =
  // the BOTH-SIDED rule honored: same ledger as the pass table.
  // Bucket 0 corrected for START-DENSITY CONTAMINATION: density is
  // logged at the carry's first touch, so open-starting carries that
  // run INTO traffic drag the "open" bucket to 0.62-0.72 when a carry
  // that STAYS open survives ~0.9 — the mispricing made open carrying
  // 22% too cheap and SHIELD outbid moving (the builder's stopped-flow
  // frames). 0.85 splits the honest difference; the traffic buckets
  // are start≈journey and stand as fitted.
  [0.85, 0.70, 0.63, 0.62];

export const carryRetention = (pressure: number): number | null => {
  if (!CARRY_RETENTION) return null;
  const b = Math.max(0, Math.min(3, Math.round(pressure * 3)));
  return CARRY_RETENTION[b] ?? null;
};
