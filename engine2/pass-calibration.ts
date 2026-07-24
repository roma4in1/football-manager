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
  // IDENTITY, deliberately — the fitted table is real but ONE-SIDED.
  // Fitted from learning/run-89068-300x3000.jsonl (300 matches, ~4900
  // events) against possession retention:
  //   ground/short 0.74  ground/mid 0.72  ground/long 0.87
  //   driven-loft  0.52 / 0.55 / 0.64   float 0.52 / 0.77
  //   curl 0.59 / 0.65 / 0.71
  // APPLYING it alone broke the pass-carry equilibrium (measured: the
  // wall-pass playmaker carried 120 straight ticks — every pass utility
  // shrank while the CARRY model kept its own unmeasured optimism).
  // The carry side must be fitted from the same ledger first; then both
  // tables land together and the equilibrium moves honestly.
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
