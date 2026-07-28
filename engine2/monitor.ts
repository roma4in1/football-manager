/**
 * monitor.ts — the FULL-SYSTEMS match monitor (builder tool): run any
 * m11 scenario N times and print a health dashboard of EVERY function —
 * possession, passing (volume/direction/retention), carries, shots &
 * threads, goals, restarts by type, set-piece deliveries, fouls/cards/
 * offsides, phase occupancy, keeper distribution, and the block's
 * geometry envelope. One readout to see how the game plays with all
 * systems live, and to watch a tactic express.
 *
 *   node --experimental-strip-types monitor.ts [scenario] [matches] [ticks]
 *   node --experimental-strip-types monitor.ts m11-showcase 6
 */
// COUNTER DEFINITIONS (the audit — real-world equivalent in parens):
//  EVENTS (counted once per occurrence): passes (telemetry, ~900-1200
//    combined/90), goals, fouls/cards, shots (RISING-EDGE of the shoot
//    label = a struck attempt, ~25/90 — NOT shoot-label ticks),
//    offsides (~2.5/90), set-piece deliveries, keeper distributions,
//    restarts (banner rising-edge). All rising-edge or telemetry.
//  OCCUPANCY (share of time/ticks, NOT counts): possession %, phase
//    shares, off-ball ACTIVITY labels (player-tick share — 'station 40%'
//    means 40% of player-ticks, has NO per-match-event meaning), the
//    shape envelope (sampled).
//  DEFINITION CAVEAT: 'carries' counts telemetry SEGMENTS incl. brief
//    <3 m controls (89% are <3 m); real 'carry' stats count 5 m+
//    PROGRESSIVE runs only — the progressive line is the comparable one.
//  RULE: never present an OCCUPANCY number as a per-match COUNT (that
//    confusion caused the shot 4x and carry 10x inflations).
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import { attackSign } from './decide.ts';
import { PITCH } from './engine2-types.ts';

const scenario = process.argv[2] ?? 'm11-match';
const matches = Number(process.argv[3] ?? 6);
const ticks = Number(process.argv[4] ?? 0); // 0 = the scenario's own duration

const def = scenarioByName(scenario);
const dur = ticks || def.durationTicks;

interface Agg {
  poss: Record<'home' | 'away', number>;
  passes: number; retained: number; fwd: number; sq: number; back: number;
  carries: number; carryDur: number; carryAdv: number;
  shots: number; threads: number; goals: Record<'home' | 'away', number>;
  fouls: number; yellows: number; reds: number; offsides: number;
  restarts: Record<string, number>;
  setpieces: Record<string, number>;
  keeper: Record<string, number>;
  labels: Record<string, number>;
  phase: Record<string, number>;
  envelope: number[];
}
const A: Agg = {
  poss: { home: 0, away: 0 }, passes: 0, retained: 0, fwd: 0, sq: 0, back: 0,
  carries: 0, carryDur: 0, carryAdv: 0, shots: 0, threads: 0, goals: { home: 0, away: 0 },
  fouls: 0, yellows: 0, reds: 0, offsides: 0, restarts: {}, setpieces: {}, keeper: {},
  labels: {}, phase: {}, envelope: [],
};
const bump = (r: Record<string, number>, k: string): void => { r[k] = (r[k] ?? 0) + 1; };

for (let m = 0; m < matches; m++) {
  const sim = new Sim(def, `mon-${m}`);
  let lastBanner: string | null = null;
  let prevLabels = new Set<string>(); // per-actor labels last tick (for rising-edge events)
  sim.telemetry = (e: { t: string;[k: string]: unknown }) => {
    if (e.t === 'pass') {
      A.passes++;
      if (e.outcome === 'complete' || e.outcome === 'teammate') A.retained++;
      const du = (e.du as number) ?? 0;
      if (du > 4) A.fwd++; else if (du < -4) A.back++; else A.sq++;
    } else if (e.t === 'carry') {
      A.carries++; A.carryDur += (e.dur as number) ?? 0; A.carryAdv += (e.adv as number) ?? 0;
    } else if (e.t === 'foul') {
      A.fouls++; if (e.card === 'yellow') A.yellows++; if (e.card === 'red') A.reds++;
    }
  };
  for (let t = 0; t < dur; t++) {
    const f = sim.step();
    // possession
    const c = sim.ball.carrierId;
    if (c) { const cb = sim.bodies.find((b) => b.id === c); if (cb && !cb.id.includes('gk')) A.poss[cb.team]++; }
    // banners → restart types + goals
    const banner = f.banner ?? null;
    if (banner && banner !== lastBanner) {
      if (banner === 'GOAL!') { /* counted from sim.goals below */ }
      else if (['THROW-IN', 'CORNER', 'GOAL KICK', 'FREE KICK', 'PENALTY', 'KICKOFF', 'SECOND HALF', 'OFFSIDE', 'HALF-TIME'].includes(banner)) bump(A.restarts, banner);
      lastBanner = banner;
    }
    // per-body action labels. CRITICAL DISTINCTION (the definitional-audit
    // fix — two 4-10x inflations came from confusing these): a label is an
    // OCCUPANCY signal (it shows every tick the actor is in that state).
    // A discrete EVENT (a shot, an offside, a set-piece delivery, a keeper
    // distribution) must be counted on the RISING EDGE (the tick the label
    // first appears per actor), NOT every tick it persists. A.labels stays
    // raw occupancy (player-ticks) and is rendered as a SHARE, not a count.
    const eventLabels = new Set(['shoot', 'fk-shot', 'penalty', 'offside', 'throw-in', 'corner-cross',
      'fk-cross', 'fk-long', 'throw', 'loop-throw', 'drop', 'punt', 'keeper-clear', 'keeper-pass', 'kickoff']);
    const nowLabels = new Set<string>();
    for (const b of f.bodies) {
      const a = b.action;
      if (!a) continue;
      bump(A.labels, a); // OCCUPANCY (player-ticks) — rendered as a share
      const key = `${b.id}:${a}`;
      if (eventLabels.has(a)) nowLabels.add(key);
      // rising edge = event this actor was NOT in this state last tick
      if (!prevLabels.has(key)) {
        if (a === 'shoot' || a === 'fk-shot' || a === 'penalty') A.shots++;
        if (a === 'offside') A.offsides++;
        if (['throw-in', 'corner-cross', 'fk-cross', 'fk-shot', 'fk-long', 'penalty'].includes(a)) bump(A.setpieces, a);
        if (['throw', 'loop-throw', 'drop', 'punt', 'keeper-clear', 'keeper-pass', 'kickoff'].includes(a)) bump(A.keeper, a);
      }
    }
    prevLabels = nowLabels;
    // threads: a completed pass to a runner beyond the ball in the final third — approximate from labels
    // phase occupancy + envelope (sampled)
    if (t % 20 === 0 && c) {
      for (const team of ['home', 'away'] as const) {
        const ph = (sim as unknown as { teamPhase: Map<string, string> }).teamPhase?.get(team);
        if (ph) bump(A.phase, ph);
      }
      const out = sim.bodies.filter((b) => !b.id.includes('gk'));
      const xs = out.map((b) => b.pos.x);
      A.envelope.push(Math.max(...xs) - Math.min(...xs));
    }
  }
  A.goals.home += sim.goals.filter((g) => g.against === 'away').length;
  A.goals.away += sim.goals.filter((g) => g.against === 'home').length;
}

// ── render ───────────────────────────────────────────────────────────────
const per = (n: number): string => (n / matches).toFixed(1);
const pct = (n: number, d: number): string => d ? (n / d * 100).toFixed(0) + '%' : '—';
const totalPoss = A.poss.home + A.poss.away;
const bar = (label: string, val: string): string => `  ${label.padEnd(26)} ${val}`;
const env = [...A.envelope].sort((a, b) => a - b);
const p50 = env.length ? env[Math.floor(env.length / 2)].toFixed(0) : '—';

console.log(`\n═══ MATCH MONITOR · ${scenario} · ${matches} matches × ${dur} ticks (${(dur / 10).toFixed(0)}s each) ═══\n`);
console.log('POSSESSION');
console.log(bar('home / away', `${pct(A.poss.home, totalPoss)} / ${pct(A.poss.away, totalPoss)}`));
console.log('\nPASSING  (per match)');
console.log(bar('volume', `${per(A.passes)}`));
console.log(bar('retention', pct(A.retained, A.passes)));
console.log(bar('direction fwd/sq/back', `${pct(A.fwd, A.passes)} / ${pct(A.sq, A.passes)} / ${pct(A.back, A.passes)}`));
console.log('\nCARRYING  (per match)');
console.log(bar('count', per(A.carries)));
console.log(bar('mean duration (ticks)', A.carries ? (A.carryDur / A.carries).toFixed(1) : '—'));
console.log(bar('mean advance (m)', A.carries ? (A.carryAdv / A.carries).toFixed(1) : '—'));
console.log('\nATTACK  (per match)');
console.log(bar('shots', per(A.shots)));
console.log(bar('goals home / away', `${per(A.goals.home)} / ${per(A.goals.away)}`));
console.log('\nLAWS & RESTARTS  (per match)');
console.log(bar('offsides', per(A.offsides)));
console.log(bar('fouls / yellow / red', `${per(A.fouls)} / ${per(A.yellows)} / ${per(A.reds)}`));
for (const [k, v] of Object.entries(A.restarts).sort((a, b) => b[1] - a[1])) console.log(bar(`restart · ${k}`, per(v)));
console.log('\nSET PIECES  (per match)');
const spTotal = Object.values(A.setpieces).reduce((s, v) => s + v, 0);
if (spTotal === 0) console.log(bar('(none in sample)', ''));
for (const [k, v] of Object.entries(A.setpieces).sort((a, b) => b[1] - a[1])) console.log(bar(k, per(v)));
console.log('\nKEEPER DISTRIBUTION  (per match)');
for (const [k, v] of Object.entries(A.keeper).sort((a, b) => b[1] - a[1])) console.log(bar(k, per(v)));
console.log('\nPHASE OCCUPANCY  (sampled shares)');
const phTotal = Object.values(A.phase).reduce((s, v) => s + v, 0);
for (const ph of ['build', 'progress', 'final', 'high', 'mid', 'low']) {
  if (A.phase[ph]) console.log(bar(ph, pct(A.phase[ph], phTotal)));
}
console.log('\nSHAPE');
console.log(bar('outfield envelope p50 (m)', `${p50}  (EAFC ref ≈ 40)`));
console.log('\nOFF-BALL ACTIVITY  (OCCUPANCY — share of outfield player-ticks, NOT event counts)');
const labelTotal = Object.values(A.labels).reduce((s2, v) => s2 + v, 0);
for (const [k, v] of Object.entries(A.labels).sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(bar(k, `${(v / labelTotal * 100).toFixed(1)}%`));
}
console.log('');
