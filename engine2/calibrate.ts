/**
 * calibrate.ts — the CALIBRATION REPORT: reads a self-play ledger and
 * compares each pass family's PRICED completion against its REALIZED
 * rate, bucketed by delivery type and distance — the automated version
 * of the probe that caught aerialCompletion pricing 0.98 on balls that
 * completed 1/8. The biggest |gap| x n rows are the models lying most.
 *
 *   node --experimental-strip-types calibrate.ts learning/<run>.jsonl
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('usage: calibrate.ts <ledger.jsonl>');
type Ev = { t: string; pC?: number; dist: number; loft: number; spin: number; outcome: string };
const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev)
  .filter((e) => e.t === 'pass');
const bucket = (e: Ev): string => {
  const type = e.spin ? 'curl' : e.loft >= 30 ? 'float' : e.loft > 0 ? 'driven-loft' : 'ground';
  const d = e.dist < 12 ? 'short' : e.dist < 24 ? 'mid' : 'long';
  return `${type}/${d}`;
};
const agg = new Map<string, { n: number; priced: number; pricedN: number; done: number }>();
for (const e of rows) {
  const b = bucket(e);
  const a = agg.get(b) ?? { n: 0, priced: 0, pricedN: 0, done: 0 };
  a.n++;
  if (e.pC !== undefined) { a.priced += e.pC; a.pricedN++; }
  if (e.outcome === 'complete') a.done++;
  agg.set(b, a);
}
const table = [...agg.entries()].map(([b, a]) => ({
  bucket: b, n: a.n,
  priced: a.pricedN ? a.priced / a.pricedN : NaN,
  realized: a.done / a.n,
})).map((r) => ({ ...r, gap: Number.isNaN(r.priced) ? 0 : r.realized - r.priced }))
  .sort((x, y) => Math.abs(y.gap) * y.n - Math.abs(x.gap) * x.n);
console.log(`passes: ${rows.length}`);
for (const r of table) {
  console.log(`${r.bucket.padEnd(18)} n=${String(r.n).padStart(5)}  priced ${Number.isNaN(r.priced) ? '  -  ' : r.priced.toFixed(2)}  realized ${r.realized.toFixed(2)}  gap ${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(2)}`);
}
