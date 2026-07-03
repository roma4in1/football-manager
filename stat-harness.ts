/**
 * stat-harness.ts — batch calibration harness for SimEngine implementations.
 *
 * Contract (calibration-reference.md): per batch, a JSON report of
 * {metric, seed, kind, sim_value, target_band, status} rows; every engine PR
 * runs this. Distribution bands run across 3 fixed master seeds — ALL must
 * pass. kind tags: "plumbing" (structural/determinism invariants) vs
 * "emergent" (distributions that should fall out of the model).
 *
 * Sections:
 *  1. determinism  — same (fixture, squads, tactics, seed) → byte-identical result
 *  2. HT resume    — H1 endState feeds H2; minutes/fatigue/score continuity;
 *                    v2 version gate rejects unversioned blobs
 *  3. batch ×3     — n synthetic matches per master seed vs calibration bands
 *  4. sweeps       — instruction sliders min→max, directional effects
 *  5. sent-off     — H2 resume with 10 men: degraded stats, frozen carry state
 *  6. strength     — strong-vs-weak sanity (info only)
 *
 * Usage: node stat-harness.ts [--n 600] [--json]
 * Deterministic: squad generation and fixture seeds derive from the master seeds.
 */

import { AggregateEngine, HALF_SECONDS } from './engine-aggregate.ts';
import { Rng } from './engine-rng.ts';
import type {
  Attributes,
  HalfResult,
  HalfTimeState,
  Phase,
  PlayerInstructions,
  PlayerTactic,
  SquadPlayer,
  Tactics,
  TeamInstructions,
  Vec2,
} from './engine-types.ts';

const MASTER_SEEDS = ['harness-v1', 'harness-v2', 'harness-v3'] as const;
const SEED0 = MASTER_SEEDS[0];
const argv = process.argv.slice(2);
const N_MATCHES = argv.includes('--n') ? parseInt(argv[argv.indexOf('--n') + 1], 10) : 600;
const N_SWEEP = 150;
const JSON_ONLY = argv.includes('--json');

// ── synthetic squad generation (4-3-3) ───────────────────────────────────────

type Role = 'GK' | 'CB' | 'FB' | 'CM' | 'W' | 'ST';

const FORMATION: Array<{ role: Role; def: Vec2; att: Vec2 }> = [
  { role: 'GK', def: { x: 6, y: 34 }, att: { x: 13, y: 34 } },
  { role: 'CB', def: { x: 16, y: 25 }, att: { x: 40, y: 25 } },
  { role: 'CB', def: { x: 16, y: 43 }, att: { x: 40, y: 43 } },
  { role: 'FB', def: { x: 19, y: 9 }, att: { x: 58, y: 8 } },
  { role: 'FB', def: { x: 19, y: 59 }, att: { x: 58, y: 60 } },
  { role: 'CM', def: { x: 30, y: 34 }, att: { x: 55, y: 34 } },
  { role: 'CM', def: { x: 34, y: 20 }, att: { x: 66, y: 20 } },
  { role: 'CM', def: { x: 34, y: 48 }, att: { x: 66, y: 48 } },
  { role: 'W', def: { x: 44, y: 10 }, att: { x: 86, y: 11 } },
  { role: 'W', def: { x: 44, y: 58 }, att: { x: 86, y: 57 } },
  { role: 'ST', def: { x: 46, y: 34 }, att: { x: 93, y: 34 } },
];

const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05,
  buildUp: 0.3,
  counterPress: 0.55,
  progression: 0.6,
  counterAttack: 0.85,
  finalThird: 1.0,
};

// attribute offsets per role, on top of player quality
const ROLE_BIAS: Record<Role, Partial<Attributes>> = {
  GK: { tackling: -4, finishing: -5, dribbling: -4, crossing: -4, offTheBall: -4 },
  CB: { tackling: 3, marking: 3, heading: 2.5, positioning: 2, strength: 2, jumping: 2, longPassing: 1.5, finishing: -3, dribbling: -2, crossing: -2 },
  FB: { pace: 1.5, crossing: 1.5, tackling: 1.5, stamina: 1.5, workRate: 1, finishing: -2 },
  CM: { passing: 2, vision: 2, decisions: 1.5, stamina: 1.5, longPassing: 1, firstTouch: 1, finishing: -1 },
  W: { pace: 2.5, dribbling: 2.5, crossing: 2, acceleration: 2, offTheBall: 1.5, tackling: -2, marking: -2 },
  ST: { finishing: 3, offTheBall: 2.5, composure: 1.5, heading: 1, tackling: -3, marking: -3 },
};

const ATTR_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing', 'tackling', 'marking',
  'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility', 'decisions',
  'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'aggression',
  'gkReflexes', 'gkPositioning', 'gkDistribution',
];

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const clampAttr = (x: number): number => clamp(Math.round(x), 1, 20);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function makePlayer(rng: Rng, clubId: string, idx: number, teamQuality: number): { sp: SquadPlayer; pt: PlayerTactic; role: Role } {
  const slot = FORMATION[idx];
  const role = slot.role;
  const q = clamp(rng.gauss(teamQuality, 1.2), 5, 19);

  const attributes = {} as Attributes;
  for (const k of ATTR_KEYS) {
    const gkAttr = k.startsWith('gk');
    const base = gkAttr ? (role === 'GK' ? q + 2.5 : rng.gauss(4, 1.5)) : role === 'GK' ? q - 2 : q;
    attributes[k] = clampAttr(rng.gauss(base + (ROLE_BIAS[role][k] ?? 0), 1.5));
  }

  const tallRole = role === 'GK' || role === 'CB' || role === 'ST';
  const heightCm = Math.round(clamp(rng.gauss(tallRole ? 187 : 178, 4), 165, 202));
  const sp: SquadPlayer = {
    playerId: `${clubId}:${idx}`,
    attributes,
    physical: {
      heightCm,
      weightKg: Math.round(heightCm - 105 + rng.gauss(0, 4)),
      preferredFoot: rng.float() < 0.25 ? 'L' : rng.float() < 0.93 ? 'R' : 'B',
      injuryProneness: clampAttr(rng.gauss(10, 3)),
    },
    fatigue: clamp(rng.gauss(0.12, 0.05), 0, 0.4),
    familiarity: {},
  };

  const anchors = {} as Record<Phase, Vec2>;
  for (const phase of Object.keys(PHASE_BLEND) as Phase[]) {
    anchors[phase] = lerp(slot.def, slot.att, PHASE_BLEND[phase]);
  }

  const inst = (base: number, sd = 0.1): number => clamp(rng.gauss(base, sd), 0.05, 0.95);
  const instructions: PlayerInstructions = {
    riskAppetite: inst(role === 'CB' ? 0.35 : 0.5),
    shootingBias: inst(role === 'ST' ? 0.7 : role === 'W' ? 0.6 : role === 'CM' ? 0.4 : 0.2),
    dribbleBias: inst(role === 'W' ? 0.65 : role === 'ST' ? 0.5 : 0.35),
    pressingIntensity: inst(role === 'ST' || role === 'W' ? 0.55 : 0.5),
    holdPosition: inst(role === 'GK' ? 0.95 : role === 'CB' ? 0.8 : role === 'CM' ? 0.5 : 0.4),
    crossBias: inst(role === 'FB' ? 0.65 : role === 'W' ? 0.6 : 0.3),
  };

  const pt: PlayerTactic = {
    playerId: sp.playerId,
    anchors,
    instructions,
    // wingers get a finalThird run-target zone — exercises the per-phase zones shape
    zones: role === 'W'
      ? { finalThird: [{ zoneType: 'runTarget', weight: 0.7, polygon: [
          { x: 78, y: anchors.finalThird.y - 8 }, { x: 100, y: anchors.finalThird.y - 8 },
          { x: 100, y: anchors.finalThird.y + 8 }, { x: 78, y: anchors.finalThird.y + 8 } ] }] }
      : {},
  };
  return { sp, pt, role };
}

interface Club { squad: SquadPlayer[]; tactics: Tactics }

function makeClub(rng: Rng, clubId: string, quality: number): Club {
  const made = FORMATION.map((_, i) => makePlayer(rng, clubId, i, quality));
  const ids = made.map((m) => m.sp.playerId);
  const team: TeamInstructions = {
    lineHeight: clamp(rng.gauss(0.5, 0.12), 0.1, 0.9),
    width: clamp(rng.gauss(0.5, 0.12), 0.1, 0.9),
    compactness: clamp(rng.gauss(0.5, 0.12), 0.1, 0.9),
    pressTrigger: clamp(rng.gauss(0.5, 0.12), 0.1, 0.9),
    counterPressDuration: 6,
    tempo: clamp(rng.gauss(0.5, 0.12), 0.1, 0.9),
  };
  return {
    squad: made.map((m) => m.sp),
    tactics: {
      players: made.map((m) => m.pt),
      team,
      bench: [],
      setPieceTakers: { corners: ids[8], freeKicks: ids[5], penalties: ids[10] },
    },
  };
}

// ── match runner + metric extraction ─────────────────────────────────────────

const engine = new AggregateEngine();

function runMatch(fixtureId: string, homeClub: Club, awayClub: Club, seed: string): { h1: HalfResult; h2: HalfResult } {
  const squads = { home: homeClub.squad, away: awayClub.squad };
  const tactics = { home: homeClub.tactics, away: awayClub.tactics };
  const h1 = engine.simulateHalf({ fixtureId, homeClubId: 'H', awayClubId: 'A', half: 1 }, squads, tactics, seed);
  const h2 = engine.simulateHalf(
    { fixtureId, homeClubId: 'H', awayClubId: 'A', half: 2, resumeState: h1.endState },
    squads, tactics, seed,
  );
  return { h1, h2 };
}

interface MatchMetrics {
  goalsH: number; goalsA: number;
  shots: [number, number]; sot: [number, number]; xg: [number, number];
  possH: number; passAcc: [number, number]; ppda: [number, number];
  aerialTotal: number;
  fouls: [number, number]; yellows: [number, number]; reds: [number, number];
  offsides: [number, number]; injuries: number;
  longBalls: [number, number]; longBallsCompleted: [number, number];
  goalsSecondHalf: number; goalsSetPieceOrPen: number; goalsHeaded: number;
  fatigueEndMeanH: number;
}

function extract(h1: HalfResult, h2: HalfResult, homePrefix: string): MatchMetrics {
  const [goalsH, goalsA] = h2.endState.score;
  const both = [...h1.events, ...h2.events];
  const isHome = (id?: string): boolean => !!id && id.startsWith(homePrefix);
  const count = (pred: (e: (typeof both)[number]) => boolean): [number, number] => {
    let h = 0, a = 0;
    for (const e of both) if (pred(e)) isHome(e.playerId) ? h++ : a++;
    return [h, a];
  };
  const goals = both.filter((e) => e.type === 'goal');
  const homeIds = Object.keys(h2.endState.playerState).filter((id) => id.startsWith(homePrefix));
  const sum2 = (a: [number, number], b: [number, number]): [number, number] => [a[0] + b[0], a[1] + b[1]];
  return {
    goalsH, goalsA,
    shots: sum2(h1.stats.shots, h2.stats.shots),
    sot: sum2(h1.stats.shotsOnTarget, h2.stats.shotsOnTarget),
    xg: sum2(h1.stats.xg, h2.stats.xg),
    possH: (h1.stats.possession[0] + h2.stats.possession[0]) / 2,
    passAcc: [(h1.stats.passAccuracy[0] + h2.stats.passAccuracy[0]) / 2, (h1.stats.passAccuracy[1] + h2.stats.passAccuracy[1]) / 2],
    ppda: [(h1.stats.ppda[0] + h2.stats.ppda[0]) / 2, (h1.stats.ppda[1] + h2.stats.ppda[1]) / 2],
    aerialTotal: h1.stats.aerialsWon[0] + h1.stats.aerialsWon[1] + h2.stats.aerialsWon[0] + h2.stats.aerialsWon[1],
    fouls: count((e) => e.type === 'foul'),
    yellows: count((e) => e.type === 'card' && e.meta?.card === 'yellow'),
    reds: count((e) => e.type === 'card' && e.meta?.card === 'red'),
    offsides: count((e) => e.type === 'offside'),
    injuries: both.filter((e) => e.type === 'injury').length,
    longBalls: count((e) => e.type === 'pass' && (e.flight === 'lofted' || e.flight === 'high')),
    longBallsCompleted: count((e) => e.type === 'pass' && (e.flight === 'lofted' || e.flight === 'high') && e.outcome === 'success'),
    goalsSecondHalf: goals.filter((e) => e.t >= HALF_SECONDS).length,
    goalsSetPieceOrPen: goals.filter((e) => e.meta?.source === 'setPiece' || e.meta?.source === 'penalty').length,
    goalsHeaded: goals.filter((e) => e.meta?.header === 1).length,
    fatigueEndMeanH: mean(homeIds.map((id) => h2.endState.playerState[id].fatigue)),
  };
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const stddev = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

// ── report plumbing ──────────────────────────────────────────────────────────

type Kind = 'plumbing' | 'emergent';

interface Row {
  metric: string;
  seed: string;
  kind: Kind;
  sim_value: number | string;
  target_band: string;
  status: 'pass' | 'fail' | 'info';
}
const report: Row[] = [];

function check(seed: string, kind: Kind, metric: string, value: number, band: [number, number] | null, digits = 3): void {
  report.push({
    metric,
    seed,
    kind,
    sim_value: Number(value.toFixed(digits)),
    target_band: band ? `${band[0]}–${band[1]}` : '—',
    status: band ? (value >= band[0] && value <= band[1] ? 'pass' : 'fail') : 'info',
  });
}

function checkBool(seed: string, kind: Kind, metric: string, ok: boolean, detail?: string): void {
  report.push({ metric, seed, kind, sim_value: detail ?? String(ok), target_band: 'true', status: ok ? 'pass' : 'fail' });
}

// ── 1. determinism + 2. HT resume (plumbing) ─────────────────────────────────

{
  const rng = Rng.fromSeed(`${SEED0}|det`);
  const clubH = makeClub(rng, 'H0', 12);
  const clubA = makeClub(rng, 'A0', 12);
  const a = runMatch('det', clubH, clubA, 'seed-1');
  const b = runMatch('det', clubH, clubA, 'seed-1');
  const c = runMatch('det', clubH, clubA, 'seed-2');
  checkBool(SEED0, 'plumbing', 'determinism: same seed byte-identical', JSON.stringify(a) === JSON.stringify(b));
  checkBool(SEED0, 'plumbing', 'determinism: different seed diverges', JSON.stringify(a) !== JSON.stringify(c));

  const { h1, h2 } = a;
  const squads = { home: clubH.squad, away: clubA.squad };
  const tactics = { home: clubH.tactics, away: clubA.tactics };
  let throwsNoResume = false;
  try {
    engine.simulateHalf({ fixtureId: 'det', homeClubId: 'H', awayClubId: 'A', half: 2 }, squads, tactics, 'seed-1');
  } catch { throwsNoResume = true; }
  checkBool(SEED0, 'plumbing', 'resume: half 2 without resumeState throws', throwsNoResume);

  // v2 gate: unversioned/other-version blobs are rejected, not coerced
  let throwsBadVersion = false;
  const unversioned = structuredClone(h1.endState) as unknown as Record<string, unknown>;
  delete unversioned.v;
  try {
    engine.simulateHalf(
      { fixtureId: 'det', homeClubId: 'H', awayClubId: 'A', half: 2, resumeState: unversioned as unknown as HalfTimeState },
      squads, tactics, 'seed-1',
    );
  } catch { throwsBadVersion = true; }
  checkBool(SEED0, 'plumbing', 'resume: non-v2 HalfTimeState rejected', throwsBadVersion);
  checkBool(SEED0, 'plumbing', 'resume: end_state carries v=2', h1.endState.v === 2 && h2.endState.v === 2);

  checkBool(SEED0, 'plumbing', 'resume: rng stream continues (state changes)', h1.endState.rngState !== h2.endState.rngState);
  const ps = Object.values(h2.endState.playerState);
  checkBool(
    SEED0, 'plumbing', 'resume: minutesPlayed 90 after H2 (45 if sent off in H1)',
    ps.every((p) => p.minutesPlayed === 90 || (p.cards.sentOff && p.minutesPlayed === 45)),
  );
  const fatigueUp = Object.keys(h2.endState.playerState).every(
    (id) => h2.endState.playerState[id].fatigue >= h1.endState.playerState[id].fatigue - 1e-9,
  );
  checkBool(SEED0, 'plumbing', 'resume: fatigue monotonic across halves', fatigueUp);
  checkBool(SEED0, 'plumbing', 'resume: score accumulates', h2.endState.score[0] >= h1.endState.score[0] && h2.endState.score[1] >= h1.endState.score[1]);
}

// ── 3. main batch × 3 master seeds (emergent, all must pass) ─────────────────

for (const seed of MASTER_SEEDS) {
  const batch: MatchMetrics[] = [];
  const rng = Rng.fromSeed(`${seed}|batch`);
  for (let i = 0; i < N_MATCHES; i++) {
    const qH = clamp(rng.gauss(12, 1.8), 8, 16);
    const qA = clamp(rng.gauss(12, 1.8), 8, 16);
    const homeClub = makeClub(rng, `H${i}`, qH);
    const awayClub = makeClub(rng, `A${i}`, qA);
    const { h1, h2 } = runMatch(`m${i}`, homeClub, awayClub, `${seed}|batch-${i}`);
    batch.push(extract(h1, h2, `H${i}:`));
  }

  const m = batch;
  const totalGoals = m.map((x) => x.goalsH + x.goalsA);
  const perTeam = <T>(f: (x: MatchMetrics) => [T, T]): T[] => m.flatMap((x) => f(x));
  const allGoals = totalGoals.reduce((s, x) => s + x, 0);
  const chk = (metric: string, value: number, band: [number, number] | null, digits = 3): void =>
    check(seed, 'emergent', metric, value, band, digits);

  chk('goals_per_match', mean(totalGoals), [2.6, 2.9]);
  chk('zero_zero_share', m.filter((x) => x.goalsH === 0 && x.goalsA === 0).length / m.length, [0.06, 0.09]);
  chk('draw_share', m.filter((x) => x.goalsH === x.goalsA).length / m.length, [0.23, 0.27]);
  chk('home_win_share', m.filter((x) => x.goalsH > x.goalsA).length / m.length, [0.43, 0.46]);
  chk('away_win_share', m.filter((x) => x.goalsA > x.goalsH).length / m.length, [0.28, 0.31]);
  chk('shots_per_team_match', mean(perTeam((x) => x.shots)), [11, 14], 2);
  chk('sot_per_team_match', mean(perTeam((x) => x.sot)), [3.5, 5], 2);
  chk('xg_per_shot', m.reduce((s, x) => s + x.xg[0] + x.xg[1], 0) / m.reduce((s, x) => s + x.shots[0] + x.shots[1], 0), [0.09, 0.12]);
  chk('possession_stddev_pts', stddev(m.map((x) => x.possH)), [6, 9], 2);
  chk('pass_completion_mean', mean(perTeam((x) => x.passAcc)), [80, 84], 2);
  chk('ppda_mean', mean(perTeam((x) => x.ppda)), [10, 13], 2);
  chk('fouls_per_team_match', mean(perTeam((x) => x.fouls)), [10, 13], 2);
  chk('yellows_per_team_match', mean(perTeam((x) => x.yellows)), [1.8, 2.2], 2);
  chk('reds_per_team_match', mean(perTeam((x) => x.reds)), [0.08, 0.12]);
  chk('setpiece_goal_share_incl_pens', m.reduce((s, x) => s + x.goalsSetPieceOrPen, 0) / allGoals, [0.25, 0.33]);
  chk('headed_goal_share', m.reduce((s, x) => s + x.goalsHeaded, 0) / allGoals, [0.15, 0.2]);
  chk('second_half_goal_share', m.reduce((s, x) => s + x.goalsSecondHalf, 0) / allGoals, [0.52, 0.56]);
  chk('injuries_per_player_match', m.reduce((s, x) => s + x.injuries, 0) / (m.length * 22), [0.025, 0.04]);
  chk('aerial_duels_per_match', mean(m.map((x) => x.aerialTotal)), [30, 50], 1);
  chk('offsides_per_team_match (info)', mean(perTeam((x) => x.offsides)), null, 2);
  chk('long_balls_per_team_match (info)', mean(perTeam((x) => x.longBalls)), null, 1);
  chk(
    'long_ball_completion (info)',
    m.reduce((s, x) => s + x.longBallsCompleted[0] + x.longBallsCompleted[1], 0) /
      m.reduce((s, x) => s + x.longBalls[0] + x.longBalls[1], 0),
    null,
  );
}

// ── 4. instruction sweeps (directional, emergent) ────────────────────────────

type Mutate = (club: Club) => void;

function sweep(name: string, mutateLo: Mutate, mutateHi: Mutate): { lo: MatchMetrics[]; hi: MatchMetrics[] } {
  const out: { lo: MatchMetrics[]; hi: MatchMetrics[] } = { lo: [], hi: [] };
  for (const end of ['lo', 'hi'] as const) {
    const rng = Rng.fromSeed(`${SEED0}|sweep|${name}`); // same rng both ends → same squads
    for (let i = 0; i < N_SWEEP; i++) {
      const homeClub = makeClub(rng, `H${i}`, 12);
      const awayClub = makeClub(rng, `A${i}`, 12);
      (end === 'lo' ? mutateLo : mutateHi)(homeClub);
      const { h1, h2 } = runMatch(`sw-${name}-${i}`, homeClub, awayClub, `sweep-${name}-${i}`);
      out[end].push(extract(h1, h2, `H${i}:`));
    }
  }
  return out;
}

const setAll = (club: Club, f: (i: PlayerInstructions) => void): void =>
  club.tactics.players.forEach((p) => f(p.instructions));

{
  const s = sweep('press',
    (c) => { c.tactics.team.pressTrigger = 0.15; setAll(c, (i) => (i.pressingIntensity = 0.15)); },
    (c) => { c.tactics.team.pressTrigger = 0.85; setAll(c, (i) => (i.pressingIntensity = 0.85)); });
  const ppdaLo = mean(s.lo.map((x) => x.ppda[0]));
  const ppdaHi = mean(s.hi.map((x) => x.ppda[0]));
  const fatLo = mean(s.lo.map((x) => x.fatigueEndMeanH));
  const fatHi = mean(s.hi.map((x) => x.fatigueEndMeanH));
  checkBool(SEED0, 'emergent', 'sweep press↑ → ppda↓', ppdaHi < ppdaLo - 2, `${ppdaHi.toFixed(1)} < ${ppdaLo.toFixed(1)} − 2`);
  checkBool(SEED0, 'emergent', 'sweep press↑ → fatigue↑', fatHi > fatLo + 0.02, `${fatHi.toFixed(3)} > ${fatLo.toFixed(3)} + .02`);
}
{
  const s = sweep('risk',
    (c) => setAll(c, (i) => (i.riskAppetite = 0.15)),
    (c) => setAll(c, (i) => (i.riskAppetite = 0.85)));
  const accLo = mean(s.lo.map((x) => x.passAcc[0]));
  const accHi = mean(s.hi.map((x) => x.passAcc[0]));
  const xgpsLo = s.lo.reduce((a, x) => a + x.xg[0], 0) / s.lo.reduce((a, x) => a + x.shots[0], 0);
  const xgpsHi = s.hi.reduce((a, x) => a + x.xg[0], 0) / s.hi.reduce((a, x) => a + x.shots[0], 0);
  checkBool(SEED0, 'emergent', 'sweep risk↑ → passAcc↓', accHi < accLo - 1, `${accHi.toFixed(1)} < ${accLo.toFixed(1)} − 1`);
  checkBool(SEED0, 'emergent', 'sweep risk↑ → xg/shot↑', xgpsHi > xgpsLo + 0.005, `${xgpsHi.toFixed(3)} > ${xgpsLo.toFixed(3)} + .005`);
}
{
  const s = sweep('lineHeight',
    (c) => { c.tactics.team.lineHeight = 0.15; },
    (c) => { c.tactics.team.lineHeight = 0.85; });
  const offLo = mean(s.lo.map((x) => x.offsides[1])); // AWAY runners caught by home's line
  const offHi = mean(s.hi.map((x) => x.offsides[1]));
  checkBool(SEED0, 'emergent', 'sweep lineHeight↑ → opponent offsides↑', offHi > offLo + 0.5, `${offHi.toFixed(2)} > ${offLo.toFixed(2)} + .5`);
}
{
  const s = sweep('cross',
    (c) => setAll(c, (i) => (i.crossBias = 0.15)),
    (c) => setAll(c, (i) => (i.crossBias = 0.85)));
  const airLo = mean(s.lo.map((x) => x.aerialTotal));
  const airHi = mean(s.hi.map((x) => x.aerialTotal));
  const hdLo = s.lo.reduce((a, x) => a + x.goalsHeaded, 0) / Math.max(1, s.lo.reduce((a, x) => a + x.goalsH + x.goalsA, 0));
  const hdHi = s.hi.reduce((a, x) => a + x.goalsHeaded, 0) / Math.max(1, s.hi.reduce((a, x) => a + x.goalsH + x.goalsA, 0));
  checkBool(SEED0, 'emergent', 'sweep crossBias↑ → aerial duels↑', airHi > airLo + 2, `${airHi.toFixed(1)} > ${airLo.toFixed(1)} + 2`);
  check(SEED0, 'emergent', 'sweep crossBias↑ headed share lo→hi (info)', hdHi - hdLo, null);
}
{
  // plumbing: the passing/longPassing split — long balls read longPassing ONLY
  const setLongPassing = (value: number) => (c: Club): void => {
    for (const p of c.squad) p.attributes.longPassing = value;
  };
  const s = sweep('longPass', setLongPassing(4), setLongPassing(18));
  const comp = (rows: MatchMetrics[]): number =>
    rows.reduce((a, x) => a + x.longBallsCompleted[0], 0) / Math.max(1, rows.reduce((a, x) => a + x.longBalls[0], 0));
  const compLo = comp(s.lo);
  const compHi = comp(s.hi);
  const accLo = mean(s.lo.map((x) => x.passAcc[0]));
  const accHi = mean(s.hi.map((x) => x.passAcc[0]));
  checkBool(
    SEED0, 'plumbing', 'sweep longPassing↑ → long-ball completion↑',
    compHi > compLo + 0.1, `${compHi.toFixed(3)} > ${compLo.toFixed(3)} + 0.1`,
  );
  checkBool(
    SEED0, 'plumbing', 'sweep longPassing↑ → ground pass accuracy unmoved',
    Math.abs(accHi - accLo) < 1, `|${accHi.toFixed(2)} − ${accLo.toFixed(2)}| < 1`,
  );
}

// ── 5. sent-off resume: 10 men degrade; carried player frozen ────────────────

{
  const N = 250;
  const rng = Rng.fromSeed(`${SEED0}|sentoff`);
  const ctrl = { forShots: 0, forXg: 0, againstShots: 0, againstXg: 0 };
  const short = { forShots: 0, forXg: 0, againstShots: 0, againstXg: 0 };
  let frozenOk = true;
  let teammatesOk = true;
  for (let i = 0; i < N; i++) {
    const homeClub = makeClub(rng, `H${i}`, 12);
    const awayClub = makeClub(rng, `A${i}`, 12);
    const squads = { home: homeClub.squad, away: awayClub.squad };
    const tactics = { home: homeClub.tactics, away: awayClub.tactics };
    const fixture = { fixtureId: `so-${i}`, homeClubId: 'H', awayClubId: 'A' } as const;
    const h1 = engine.simulateHalf({ ...fixture, half: 1 }, squads, tactics, `so-${i}`);

    const victim = homeClub.tactics.players[5].playerId; // a CM
    const mutated = structuredClone(h1.endState);
    mutated.playerState[victim].cards = { yellows: 1, sentOff: true };

    const c2 = engine.simulateHalf({ ...fixture, half: 2, resumeState: h1.endState }, squads, tactics, `so-${i}`);
    const s2 = engine.simulateHalf({ ...fixture, half: 2, resumeState: mutated }, squads, tactics, `so-${i}`);

    ctrl.forShots += c2.stats.shots[0]; ctrl.forXg += c2.stats.xg[0];
    ctrl.againstShots += c2.stats.shots[1]; ctrl.againstXg += c2.stats.xg[1];
    short.forShots += s2.stats.shots[0]; short.forXg += s2.stats.xg[0];
    short.againstShots += s2.stats.shots[1]; short.againstXg += s2.stats.xg[1];

    const at45 = s2.endState.playerState[victim];
    const wasAt = h1.endState.playerState[victim];
    if (at45.minutesPlayed !== wasAt.minutesPlayed || at45.fatigue !== wasAt.fatigue || !at45.cards.sentOff) frozenOk = false;
    const teammate = homeClub.tactics.players[6].playerId;
    // the teammate can legitimately stop at 45 if the H1 sim sent HIM off too
    if (!h1.endState.playerState[teammate].cards.sentOff && s2.endState.playerState[teammate].minutesPlayed !== 90) {
      teammatesOk = false;
    }
  }
  checkBool(SEED0, 'plumbing', 'sent-off: zero half-2 minutes, frozen fatigue, flag carried', frozenOk);
  checkBool(SEED0, 'plumbing', 'sent-off: teammates still accrue to 90', teammatesOk);
  checkBool(
    SEED0, 'emergent', 'sent-off: 10 men attack less',
    short.forShots < ctrl.forShots - 0.3 * N,
    `${(short.forShots / N).toFixed(2)} < ${(ctrl.forShots / N).toFixed(2)} − 0.3 shots/H2`,
  );
  checkBool(
    SEED0, 'emergent', 'sent-off: 10 men concede more',
    short.againstShots > ctrl.againstShots + 0.3 * N,
    `${(short.againstShots / N).toFixed(2)} > ${(ctrl.againstShots / N).toFixed(2)} + 0.3 shots/H2`,
  );
}

// ── 6. strength sanity (info) ────────────────────────────────────────────────

{
  const rng = Rng.fromSeed(`${SEED0}|strength`);
  let wins = 0, draws = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const strong = makeClub(rng, `S${i}`, 15);
    const weak = makeClub(rng, `W${i}`, 9);
    const { h2 } = runMatch(`str-${i}`, strong, weak, `str-${i}`);
    if (h2.endState.score[0] > h2.endState.score[1]) wins++;
    else if (h2.endState.score[0] === h2.endState.score[1]) draws++;
  }
  check(SEED0, 'emergent', 'strength: q15-home beats q9 win share (info)', wins / n, null);
  check(SEED0, 'emergent', 'strength: q15 vs q9 draw share (info)', draws / n, null);
}

// ── output ───────────────────────────────────────────────────────────────────

if (!JSON_ONLY) {
  const w = [50, 12, 9, 12, 12];
  console.log(`\nstat-harness — AggregateEngine, n=${N_MATCHES} matches × ${MASTER_SEEDS.length} seeds (+sweeps ${N_SWEEP}×2×4, sent-off 250, strength 200)\n`);
  console.log(['metric'.padEnd(w[0]), 'seed'.padEnd(w[1]), 'kind'.padEnd(w[2]), 'sim'.padEnd(w[3]), 'target'.padEnd(w[4]), 'status'].join(' '));
  console.log('-'.repeat(w[0] + w[1] + w[2] + w[3] + w[4] + 11));
  for (const r of report) {
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'info';
    console.log([
      r.metric.padEnd(w[0]), r.seed.padEnd(w[1]), r.kind.padEnd(w[2]),
      String(r.sim_value).padEnd(w[3]), r.target_band.padEnd(w[4]), mark,
    ].join(' '));
  }
  const fails = report.filter((r) => r.status === 'fail').length;
  const passes = report.filter((r) => r.status === 'pass').length;
  console.log(`\n${passes} pass, ${fails} fail, ${report.length - passes - fails} info\n`);
}

console.log(JSON.stringify(report));
process.exitCode = report.some((r) => r.status === 'fail') ? 1 : 0;
