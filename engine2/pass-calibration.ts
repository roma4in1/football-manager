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
  // IDENTITY — the application is deliberately HELD. The full verdict
  // cycle ran (fit -> apply -> measure the football -> reject):
  // applying the fitted tables collapsed passes/match 47.7 -> 20.8 —
  // dribble-ball, the empirical proof of the CIRCULARITY: the carry
  // survival (0.87-0.93/step even in traffic) is inflated by a defense
  // that converts poorly, so calibrating to it rewards exactly the
  // football the reference work steers away from.
  // THE CONVERGENCE PLAN: improve defensive CONVERSION first (strips in
  // traffic raise true carry hazard), re-batch, re-fit — the tables
  // land when the measured equilibrium passes MORE, not less.
  // Fitted values (run-91744, 300 matches): ground .74/.73/.88,
  // driven-loft .41/.58/.64, float .30/.55/.82, curl .57/.65/.75;
  // carry step-survival by density [0.93, 0.88, 0.89, 0.87] with
  // advance/tick 0.28 -> 0.20 m (traffic slows ~28%, not the legacy
  // tax's ~55% — the open-field 0.930 independently re-derived the
  // hand-fitted 0.92).
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
export const CARRY_RETENTION: ReadonlyArray<number> | null = null;

export const carryRetention = (pressure: number): number | null => {
  if (!CARRY_RETENTION) return null;
  const b = Math.max(0, Math.min(3, Math.round(pressure * 3)));
  return CARRY_RETENTION[b] ?? null;
};
