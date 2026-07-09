/**
 * penalty-shootout.test.ts — shootout structure + determinism, and the
 * neutral-venue gate (home boost verifiably off in the aggregate engine).
 *
 *   node --test penalty-shootout.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AggregateEngine } from './engine-aggregate.ts';
import {
  kickOrder,
  kickScoreProb,
  resolveShootout,
  SHOOTOUT,
  type ShootoutResult,
  type ShootoutSide,
} from './penalty-shootout.ts';
import type { Attributes, Phase, SquadPlayer, Tactics, Vec2 } from './engine-types.ts';

// ── shootout units ───────────────────────────────────────────────────────────

function side(clubId: string, finishings: number[], gk = 12): ShootoutSide {
  return {
    clubId,
    takers: finishings.map((f, i) => ({ playerId: `${clubId}${i}`, finishing: f })),
    keeper: { playerId: `${clubId}gk`, gkReflexes: gk, gkPositioning: gk },
  };
}

test('kick probability: base = the in-match penalty conversion; taker raises, keeper lowers; clamped', () => {
  const avg = kickScoreProb({ playerId: 'x', finishing: 12 }, { playerId: 'k', gkReflexes: 12, gkPositioning: 12 });
  assert.equal(avg, SHOOTOUT.baseGoalProb);
  const elite = kickScoreProb({ playerId: 'x', finishing: 20 }, { playerId: 'k', gkReflexes: 12, gkPositioning: 12 });
  const vsWall = kickScoreProb({ playerId: 'x', finishing: 12 }, { playerId: 'k', gkReflexes: 20, gkPositioning: 20 });
  assert.ok(elite > avg && vsWall < avg);
  assert.ok(kickScoreProb({ playerId: 'x', finishing: 1 }, { playerId: 'k', gkReflexes: 20, gkPositioning: 20 }) >= SHOOTOUT.minProb);
  assert.ok(kickScoreProb({ playerId: 'x', finishing: 20 }, { playerId: 'k', gkReflexes: 1, gkPositioning: 1 }) <= SHOOTOUT.maxProb);
});

test('taker order: best finishers first, playerId breaks ties deterministically', () => {
  const order = kickOrder([
    { playerId: 'b', finishing: 15 },
    { playerId: 'a', finishing: 15 },
    { playerId: 'c', finishing: 18 },
  ]);
  assert.deepEqual(order.map((t) => t.playerId), ['c', 'a', 'b']);
});

test('determinism: identical seed → byte-identical shootout; different seed diverges', () => {
  const h = side('H', [18, 16, 15, 14, 13, 12, 12, 11, 10, 9, 3]);
  const a = side('A', [17, 16, 14, 14, 12, 12, 11, 11, 10, 8, 3]);
  const r1 = resolveShootout('seed-x', h, a);
  const r2 = resolveShootout('seed-x', h, a);
  assert.deepEqual(r1, r2);
  const diverged = [...Array(50)].some((_, i) => JSON.stringify(resolveShootout(`s${i}`, h, a)) !== JSON.stringify(r1));
  assert.ok(diverged, 'seeds matter');
});

test('structure: alternating kicks, best-of-5 early termination, sudden death cycles the order', () => {
  const h = side('H', [18, 16, 15, 14, 13, 12, 12, 11, 10, 9, 3]);
  const a = side('A', [17, 16, 14, 14, 12, 12, 11, 11, 10, 8, 3]);
  let sawEarly = false;
  let sawSudden: ShootoutResult | null = null;
  for (let i = 0; i < 300 && (!sawEarly || !sawSudden); i++) {
    const r = resolveShootout(`hunt-${i}`, h, a);
    // invariant: kicks alternate H, A, H, A …
    for (const [j, k] of r.kicks.entries()) assert.equal(k.side, j % 2 === 0 ? 'home' : 'away');
    // invariant: score matches the kick record and the winner leads
    const tally: Record<'home' | 'away', number> = { home: 0, away: 0 };
    for (const k of r.kicks) if (k.scored) tally[k.side] += 1;
    assert.deepEqual(r.score, [tally.home, tally.away]);
    assert.ok(r.score[r.winner === 'home' ? 0 : 1] > r.score[r.winner === 'home' ? 1 : 0]);
    if (!r.suddenDeath && r.kicks.length < 10) sawEarly = true; // decided before all 10 regulation kicks
    if (r.suddenDeath) {
      assert.ok(r.kicks.length > 10 && r.kicks.length % 2 === 0, 'sudden death = full extra pairs');
      sawSudden = r;
    }
  }
  assert.ok(sawEarly, 'early termination occurs (unwinnable → stop)');
  assert.ok(sawSudden, 'sudden death occurs when level after 5');
  // sudden death cycles takers: kick 11+ uses the 6th, 7th… best, wrapping past the XI
  const sixthKickerHome = sawSudden!.kicks.filter((k) => k.side === 'home')[5];
  assert.equal(sixthKickerHome.playerId, kickOrder(h.takers)[5].playerId);
});

// ── neutral venue: home boost verifiably OFF ────────────────────────────────

const ATTR_KEYS = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
  'tackling', 'marking', 'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping',
  'agility', 'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
  'aggression', 'gkReflexes', 'gkPositioning', 'gkDistribution',
] as const;
const flat = (isGk: boolean): Attributes => {
  const attrs = {} as Attributes;
  for (const k of ATTR_KEYS) attrs[k] = k.startsWith('gk') ? (isGk ? 14 : 3) : isGk ? 10 : 12;
  return attrs;
};
const FORMATION: Array<{ def: Vec2; att: Vec2 }> = [
  { def: { x: 6, y: 34 }, att: { x: 13, y: 34 } }, { def: { x: 16, y: 25 }, att: { x: 40, y: 25 } },
  { def: { x: 16, y: 43 }, att: { x: 40, y: 43 } }, { def: { x: 19, y: 9 }, att: { x: 58, y: 8 } },
  { def: { x: 19, y: 59 }, att: { x: 58, y: 60 } }, { def: { x: 30, y: 34 }, att: { x: 55, y: 34 } },
  { def: { x: 34, y: 20 }, att: { x: 66, y: 20 } }, { def: { x: 34, y: 48 }, att: { x: 66, y: 48 } },
  { def: { x: 44, y: 10 }, att: { x: 86, y: 11 } }, { def: { x: 44, y: 58 }, att: { x: 86, y: 57 } },
  { def: { x: 46, y: 34 }, att: { x: 93, y: 34 } },
];
const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05, buildUp: 0.3, counterPress: 0.55, progression: 0.6, counterAttack: 0.85, finalThird: 1.0,
};

function xi(prefix: string): { squad: SquadPlayer[]; tactics: Tactics } {
  const squad: SquadPlayer[] = [];
  const players: Tactics['players'] = [];
  for (let i = 0; i < 11; i++) {
    squad.push({
      playerId: `${prefix}${i}`,
      attributes: flat(i === 0),
      physical: { heightCm: i === 0 ? 190 : 180, weightKg: 78, preferredFoot: 'R', injuryProneness: 10 },
      fatigue: 0.1,
      familiarity: {},
    });
    const slot = FORMATION[i];
    const anchors = {} as Record<Phase, Vec2>;
    for (const [phase, t] of Object.entries(PHASE_BLEND) as Array<[Phase, number]>) {
      anchors[phase] = { x: slot.def.x + (slot.att.x - slot.def.x) * t, y: slot.def.y + (slot.att.y - slot.def.y) * t };
    }
    players.push({
      playerId: `${prefix}${i}`, anchors,
      instructions: { riskAppetite: 0.5, shootingBias: 0.4, dribbleBias: 0.4, pressingIntensity: 0.5, holdPosition: i === 0 ? 0.95 : 0.5, crossBias: 0.4 },
      zones: {},
    });
  }
  return {
    squad,
    tactics: {
      players,
      team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
      bench: [],
      setPieceTakers: { corners: `${prefix}8`, freeKicks: `${prefix}5`, penalties: `${prefix}10` },
    },
  };
}

test('neutral venue: identical clubs show a home edge normally, none at the neutral final', () => {
  const engine = new AggregateEngine();
  const play = (neutral: boolean, seed: string): [number, number] => {
    const home = xi('H');
    const away = xi('A');
    const h1 = engine.simulateHalf(
      { fixtureId: seed, homeClubId: 'H', awayClubId: 'A', half: 1, ...(neutral ? { neutralVenue: true } : {}) },
      { home: home.squad, away: away.squad }, { home: home.tactics, away: away.tactics }, seed,
    );
    const h2 = engine.simulateHalf(
      { fixtureId: seed, homeClubId: 'H', awayClubId: 'A', half: 2, resumeState: h1.endState, ...(neutral ? { neutralVenue: true } : {}) },
      { home: home.squad, away: away.squad }, { home: home.tactics, away: away.tactics }, seed,
    );
    return h2.endState.score as [number, number];
  };
  const share = (neutral: boolean): { home: number; away: number; goalsH: number; goalsA: number } => {
    let hw = 0, aw = 0, gh = 0, ga = 0;
    for (let i = 0; i < 250; i++) {
      const [h, a] = play(neutral, `nv-${neutral}-${i}`);
      gh += h; ga += a;
      if (h > a) hw++; else if (a > h) aw++;
    }
    return { home: hw / 250, away: aw / 250, goalsH: gh, goalsA: ga };
  };
  const normal = share(false);
  const neutral = share(true);
  assert.ok(normal.home - normal.away > 0.05, `normal venue keeps the home edge (${normal.home} vs ${normal.away})`);
  assert.ok(Math.abs(neutral.home - neutral.away) < 0.07, `neutral venue is symmetric (${neutral.home} vs ${neutral.away})`);
  assert.ok(
    normal.goalsH / normal.goalsA > neutral.goalsH / neutral.goalsA,
    'the home goal tilt shrinks at a neutral venue',
  );
});
