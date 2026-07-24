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
): number => {
  const type = spin ? 'curl' : loftDeg >= 30 ? 'float' : loftDeg > 0 ? 'driven-loft' : 'ground';
  const d = distM < 12 ? 'short' : distM < 24 ? 'mid' : 'long';
  const k = PASS_CALIBRATION[`${type}/${d}`] ?? 1;
  const kEff = 1 - (1 - k) * Math.max(0, Math.min(1, density));
  return Math.max(0.02, Math.min(0.98, pC * kEff));
};

/** carry RETENTION by local pressure (density 0..1 → bucket 0..3),
 * fitted from the same ledger as the pass table — the BOTH-SIDED rule:
 * the two tables land together or not at all. Null = legacy algebra. */
export const CARRY_RETENTION: ReadonlyArray<number> | null =
  // the BOTH-SIDED rule honored: same ledger as the pass table.
  // Segment retention by density bucket; density-0 (n=50) smoothed
  // monotone against its own noise (raw 0.62 under bucket-1's 0.72).
  [0.72, 0.70, 0.63, 0.62];

export const carryRetention = (pressure: number): number | null => {
  if (!CARRY_RETENTION) return null;
  const b = Math.max(0, Math.min(3, Math.round(pressure * 3)));
  return CARRY_RETENTION[b] ?? null;
};
