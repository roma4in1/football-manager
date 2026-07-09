/**
 * make-harness-fixture.ts — (re)generate engine/harness-fixture.json, the
 * committed pool the CI-mode harnesses run against (harness-pool.ts).
 *
 * Needs the real pool (players.sql + the human-populated cache CSV), so it
 * runs LOCALLY. Selection: clubs sorted by XI-mean quality, stride-sampled
 * down to ~24 spanning the full range (a quality-ordering inversion or a
 * growth runaway must remain visible), keeping per club the most-played
 * 2 GK / 6 DF / 6 MF / 4 FW so the realism harness's XI builder always has
 * a complete 4-3-3. Clubs that cannot field one are skipped for the next in
 * quality order.
 *
 * Run: node make-harness-fixture.ts   (then commit the JSON)
 */

import { writeFileSync } from 'node:fs';
import type { Attributes } from './engine-types.ts';
import { FIXTURE_PATH, loadClubPools, type HarnessPlayer } from './harness-pool.ts';

const CLUB_TARGET = 24;

const OUTFIELD_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
  'tackling', 'marking', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility',
  'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
];
const composite = (p: HarnessPlayer): number =>
  OUTFIELD_KEYS.reduce((a, k) => a + p.attributes[k], 0) / OUTFIELD_KEYS.length;

const xiMean = (players: HarnessPlayer[]): number => {
  const outfield = players.filter((p) => p.position !== 'GK').sort((a, b) => composite(b) - composite(a));
  return outfield.slice(0, 10).reduce((s, p) => s + composite(p), 0) / Math.min(10, outfield.length);
};

/** most-played 2 GK / 6 DF / 6 MF / 4 FW; null if no complete 4-3-3 lives in it */
function trimSquad(players: HarnessPlayer[]): HarnessPlayer[] | null {
  const byMinutes = (a: HarnessPlayer, b: HarnessPlayer) => b.minutes - a.minutes;
  const pick = (pos: string, n: number) => players.filter((p) => p.position === pos).sort(byMinutes).slice(0, n);
  const [gks, dfs, mfs, fws] = [pick('GK', 2), pick('DF', 6), pick('MF', 6), pick('FW', 4)];
  // realism buildClub needs ≥1 GK, ≥4 DF, ≥3 MF and 3 forwards after borrowing spare mids
  if (gks.length < 1 || dfs.length < 4 || mfs.length < 3 || fws.length + Math.max(0, mfs.length - 3) < 3) return null;
  return [...gks, ...dfs, ...mfs, ...fws];
}

const real = loadClubPools(false);
const ranked = [...real.entries()]
  .map(([name, players]) => ({ name, players, quality: xiMean(players) }))
  .filter((c) => c.players.filter((p) => p.position !== 'GK').length >= 10)
  .sort((a, b) => b.quality - a.quality);

// the realism GK check swaps the pool's best/worst high-minute keeper into a
// fixed club — the fixture must carry a REAL gk-attribute spread, so the two
// clubs owning the global elite and weakest eligible GK are always included
const gkScore = (p: HarnessPlayer): number => p.attributes.gkReflexes + p.attributes.gkPositioning;
const eligibleGks = ranked
  .flatMap((c, rank) => c.players.filter((p) => p.position === 'GK' && p.minutes > 1500).map((p) => ({ rank, gk: gkScore(p) })))
  .sort((a, b) => b.gk - a.gk);
const mustInclude = new Set([eligibleGks[0].rank, eligibleGks[eligibleGks.length - 1].rank]);

// band sampling, ends dense: the realism harness's top-8-vs-bottom-8 check
// must exercise the SAME extremes as the real-pool acceptance run, so the
// fixture carries the real top 8 and bottom 8 plus a spread middle for the
// correlation sample
const clubs: Array<{ name: string; players: HarnessPlayer[] }> = [];
const taken = new Set<number>();
const takeClub = (at: number): boolean => {
  // walk forward to the next XI-viable club not already taken
  while (at < ranked.length && (taken.has(at) || trimSquad(ranked[at].players) === null)) at++;
  if (at >= ranked.length) return false;
  taken.add(at);
  clubs.push({ name: ranked[at].name, players: trimSquad(ranked[at].players)! });
  return true;
};
for (const at of mustInclude) takeClub(at);
for (let i = 0; i < 8; i++) takeClub(i); // the real top-8
for (let i = 8; i > 0 && clubs.length < CLUB_TARGET; i--) takeClub(ranked.length - i); // the real bottom-8
const midStart = 8;
const midEnd = ranked.length - 9;
for (let i = 0; clubs.length < CLUB_TARGET; i++) {
  if (!takeClub(midStart + Math.round((i * (midEnd - midStart)) / 7))) break;
}
clubs.sort((a, b) => xiMean(b.players) - xiMean(a.players));

const fixture = {
  source: 'pipeline/seeds/players.sql + cache CSV squad join (make-harness-fixture.ts)',
  note: 'Committed CI tripwire pool: stable stride-sample of the real league. NOT the acceptance pool — run the harnesses without --fixture against the real pool before merging engine/growth changes.',
  clubs,
};
writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 1) + '\n');
const n = clubs.reduce((s, c) => s + c.players.length, 0);
console.log(`wrote ${FIXTURE_PATH}: ${clubs.length} clubs, ${n} players, quality ${xiMean(clubs[0].players).toFixed(2)} … ${xiMean(clubs[clubs.length - 1].players).toFixed(2)}`);
