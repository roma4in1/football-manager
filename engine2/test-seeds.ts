/** The pinning discipline (memory rule + two hidden defects found Jul 24):
 * the WORKBENCH seeds LEAD every scenario pin — the builder watches wb-N,
 * so wb-N is what a pin must certify; test-only families are the spread.
 * Iterations 0-2 map to wb-0..2, the rest to the test's own family. */
export const seedFor = (prefix: string, s: number): string =>
  s < 3 ? `wb-${s}` : `${prefix}-${s - 3}`;
