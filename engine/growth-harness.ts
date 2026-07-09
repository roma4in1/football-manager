/**
 * growth-harness.ts — multi-season compounding model (tag: growth).
 *
 * Attribute growth is the only feature that affects every FUTURE season, so
 * its acceptance gate is not "does it work" but "does the league stay
 * competitive". This harness applies the REAL growth math (league-growth.ts —
 * the same functions the server tick runs) to the REAL seeded pool grouped
 * into their real club squads, season after season, and reports how
 * XI-mean quality spread evolves over 5 seasons.
 *
 * The failure mode proved against: a strong/rich club (max training facility,
 * flat-out intensity, good young players) compounding away from a poor club
 * (no facility, default intensity) until the league is uncompetitive.
 *
 * Modeled per season: 19 weekly ticks (18 regular rounds of a 10-club league
 * + the transfer bye), XI picked by current quality plays 90'/week, everyone
 * else sits at the minutes floor, then season-end growth+decline applies and
 * everyone ages one year. Rosters are FIXED across seasons (no churn) — that
 * overstates late-season decline for everyone equally and gives a clean read
 * on the growth/decline balance itself.
 *
 * Caveat: the stress case holds intensity at 1.0 for five straight seasons,
 * which in a real save costs fatigue recovery every single week — the
 * reported rich-club edge is an upper bound.
 *
 * TWO POOLS (harness-pool.ts): the default run is the real pool in its real
 * squads — the AUTHORITATIVE acceptance gate before a growth-knob change
 * merges. `--fixture` runs the same math and gates against the committed
 * stride-sample (harness-fixture.json) — the CI regression tripwire.
 *
 * Run: node growth-harness.ts [--json] [--fixture]
 */

import type { Attributes } from './engine-types.ts';
import { fixtureFlag, loadClubPools } from './harness-pool.ts';
import {
  accumulateProgress,
  ageDecline,
  ageTrainingMul,
  applySeasonGrowth,
  weeklyTrainingAccrual,
  type TrainingFocus,
} from './league-growth.ts';

const JSON_ONLY = process.argv.includes('--json');
const FIXTURE = fixtureFlag();

const WEEKS_PER_SEASON = 19; // 18 regular rounds (10 clubs) + the transfer bye
const SEASONS = Number(process.env.GROWTH_SEASONS ?? 5);
const REFERENCE_DATE = Date.UTC(2025, 6, 1); // season-0 birthday reference

interface Player {
  name: string;
  position: string;
  age: number; // season-0 age; +1 per simulated season
  attributes: Attributes;
  progress: Partial<Record<keyof Attributes, number>>;
  minutes: number;
}

// ── quality metric (the realism harness's composite) ─────────────────────────

const OUTFIELD_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
  'tackling', 'marking', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility',
  'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
];
const composite = (p: Player): number =>
  OUTFIELD_KEYS.reduce((a, k) => a + p.attributes[k], 0) / OUTFIELD_KEYS.length;

interface ClubSim {
  name: string;
  roster: Player[];
  facilityLevel: number;
  intensity: number;
  focus: TrainingFocus;
}

/** XI-mean quality: keeper + the ten best outfielders BY CURRENT ATTRIBUTES. */
function xiMean(club: ClubSim): number {
  const outfield = club.roster.filter((p) => p.position !== 'GK').sort((a, b) => composite(b) - composite(a));
  return outfield.slice(0, 10).reduce((s, p) => s + composite(p), 0) / Math.min(10, outfield.length);
}

/** Who plays this season: keeper + ten best outfielders get the minutes. */
function pickXI(club: ClubSim): Set<Player> {
  const gk = club.roster.filter((p) => p.position === 'GK').sort((a, b) => b.minutes - a.minutes)[0];
  const outfield = club.roster.filter((p) => p.position !== 'GK').sort((a, b) => composite(b) - composite(a));
  return new Set([gk, ...outfield.slice(0, 10)].filter(Boolean));
}

function simulateSeason(club: ClubSim): void {
  const xi = pickXI(club);
  for (const p of club.roster) {
    for (let w = 0; w < WEEKS_PER_SEASON; w++) {
      const week = weeklyTrainingAccrual({
        focus: club.focus,
        intensity: club.intensity,
        trainingLevel: club.facilityLevel,
        age: p.age,
        position: p.position,
        weekMinutes: xi.has(p) ? 90 : 0,
      });
      p.progress = accumulateProgress(p.progress, week);
    }
  }
  for (const p of club.roster) {
    p.attributes = applySeasonGrowth(p.attributes, p.progress, p.age).after;
    p.progress = {};
    p.age += 1;
  }
}

// ── report plumbing ──────────────────────────────────────────────────────────

interface Row { metric: string; kind: 'growth'; sim_value: string; target_band: string; status: 'pass' | 'fail' | 'info' }
const rows: Row[] = [];
function check(metric: string, value: string, band: string, ok: boolean | null): void {
  rows.push({ metric, kind: 'growth', sim_value: value, target_band: band, status: ok === null ? 'info' : ok ? 'pass' : 'fail' });
  if (!JSON_ONLY) console.log(`${ok === null ? 'info' : ok ? 'PASS' : 'FAIL'}  ${metric}: ${value} (${band})`);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(2)).join(' → ');

// ── build the league ─────────────────────────────────────────────────────────

function buildClubs(facilityFor: (rank: number, n: number) => number, intensityFor: (rank: number, n: number) => number): ClubSim[] {
  const byClub = new Map<string, Player[]>();
  for (const [name, players] of loadClubPools(FIXTURE)) {
    byClub.set(name, players.map((p) => ({
      name: p.name,
      position: p.position,
      age: Math.floor((REFERENCE_DATE - new Date(p.birthDate).getTime()) / (365.25 * 86_400_000)),
      attributes: { ...p.attributes },
      progress: {},
      minutes: p.minutes,
    })));
  }
  const clubs: ClubSim[] = [];
  for (const [name, roster] of byClub) {
    if (roster.filter((p) => p.position !== 'GK').length < 10 || !roster.some((p) => p.position === 'GK')) continue;
    clubs.push({ name, roster, facilityLevel: 0, intensity: 0.5, focus: 'balanced' });
  }
  clubs.sort((a, b) => xiMean(b) - xiMean(a));
  clubs.forEach((c, i) => {
    c.facilityLevel = facilityFor(i, clubs.length);
    c.intensity = intensityFor(i, clubs.length);
  });
  return clubs;
}

function trajectory(clubs: ClubSim[]): number[][] {
  const perSeason: number[][] = [clubs.map(xiMean)];
  for (let s = 0; s < SEASONS; s++) {
    for (const c of clubs) simulateSeason(c);
    perSeason.push(clubs.map(xiMean));
  }
  return perSeason;
}

// ── scenario 1: level playing field — does aging alone keep the league sane? ─

{
  const clubs = buildClubs(() => 0, () => 0.5);
  const t = trajectory(clubs);
  const sds = t.map(sd);
  const spreads = t.map((q) => Math.max(...q) - Math.min(...q));
  const means = t.map(mean);
  // 1.5× leaves tripwire margin over known-good (real pool 1.34×, fixture
  // 1.42× — fixed-roster age mix, not growth inflation); a genuine runaway
  // clears 2× on this gate and fails the stress gates besides
  check('growth: baseline league σ trajectory (5 seasons)', fmt(sds), 'bounded: final within 0.6–1.5× of start',
    sds[SEASONS] > 0.6 * sds[0] && sds[SEASONS] < 1.5 * sds[0]);
  check('growth: baseline league max−min spread', fmt(spreads), 'info', null);
  check('growth: baseline league mean drift', fmt(means), '|Δ| < 0.8 over 5 seasons (no inflation/collapse)',
    Math.abs(means[SEASONS] - means[0]) < 0.8);
}

// ── scenario 2: divergence stress — rich top clubs vs poor bottom clubs ──────

{
  const clubs = buildClubs(
    (rank, n) => (rank < n / 2 ? 5 : 0), // strong half maxes the facility
    (rank, n) => (rank < n / 2 ? 1.0 : 0.5), // and trains flat out (upper bound: real saves pay fatigue for this)
  );
  const t = trajectory(clubs);
  const top = t.map((q) => mean(q.slice(0, 8)));
  const bottom = t.map((q) => mean(q.slice(-8)));
  const gap = t.map((_, i) => top[i] - bottom[i]);
  check('growth: stress top-8 (rich) XI-mean', fmt(top), 'info', null);
  check('growth: stress bottom-8 (poor) XI-mean', fmt(bottom), 'info', null);
  check('growth: rich-vs-poor gap trajectory', fmt(gap), 'gap grows < 0.5 pts over 5 seasons (no runaway)',
    gap[SEASONS] - gap[0] < 0.5);
  // the runaway SIGNATURE is compounding — accelerating increments. Under
  // this deliberately bimodal setup, σ mechanically restates the gap, so the
  // acceleration check carries the verdict and σ is a loose backstop.
  // (At GROWTH_SEASONS=10 the increments fall 0.09 → 0.05 as headroom drag
  // catches the rich cohort: the gap asymptotes instead of diverging.)
  const inc = gap.slice(1).map((g, i) => g - gap[i]);
  const early = (inc[0] + inc[1]) / 2;
  const late = (inc[inc.length - 2] + inc[inc.length - 1]) / 2;
  check('growth: gap increments do not accelerate', `${inc.map((x) => x.toFixed(3)).join(', ')}`,
    'late ≤ 1.2× early (decelerating/linear, not compounding)', late <= early * 1.2 + 1e-9);
  const sds = t.map(sd);
  check('growth: stress league σ backstop', fmt(sds), 'final σ < 2× start under maximal bimodal stress',
    sds[SEASONS] < 2 * sds[0]);
}

// ── scenario 3: the age arc — young grow, peak plateau, old decline ──────────

{
  const clubs = buildClubs(() => 2, () => 0.5); // mid facility, default intensity
  const cohort = (lo: number, hi: number): Player[] =>
    clubs.flatMap((c) => {
      const xi = pickXI(c);
      return c.roster.filter((p) => xi.has(p) && p.position !== 'GK' && p.age >= lo && p.age <= hi);
    });
  const young = cohort(17, 20);
  const peak = cohort(24, 27);
  const old = cohort(31, 45);
  const before = { young: mean(young.map(composite)), peak: mean(peak.map(composite)), old: mean(old.map(composite)) };
  for (const c of clubs) simulateSeason(c); // ONE season — the cohorts' arc, not five years of re-picked XIs
  const delta = {
    young: mean(young.map(composite)) - before.young,
    peak: mean(peak.map(composite)) - before.peak,
    old: mean(old.map(composite)) - before.old,
  };
  check('growth: U21 starters net change / season', delta.young.toFixed(3), '> +0.05 (young grow)', delta.young > 0.05);
  check('growth: peak-age (24–27) starters net change', delta.peak.toFixed(3), '−0.05 … +0.25 (plateau)',
    delta.peak > -0.05 && delta.peak < 0.25);
  check('growth: 31+ starters net change / season', delta.old.toFixed(3), '< −0.05 (old decline)', delta.old < -0.05);
  check(
    'growth: curve shape at a glance',
    `mul(18)=${ageTrainingMul(18)} mul(25)=${ageTrainingMul(25)} mul(34)=${ageTrainingMul(34)}; decline(29)=${ageDecline(29)} decline(31)=${ageDecline(31)} decline(35)=${ageDecline(35)}`,
    'info', null,
  );
}

if (JSON_ONLY) console.log(JSON.stringify(rows, null, 1));
const fails = rows.filter((r) => r.status === 'fail').length;
if (!JSON_ONLY) console.log(`\ngrowth: ${rows.length - fails}/${rows.length} pass`);
process.exit(fails ? 1 : 0);
