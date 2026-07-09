/**
 * agent-sharpness.test.ts — sharpness effects in the agent engine:
 * decision-temperature penalty (the instructions channel, never execution
 * noise), faster condition drain, and the full-sharp no-op invariant
 * (absent/1 must leave results byte-identical — the realism harness proves
 * the same at league scale).
 *
 *   node --test agent-sharpness.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentEngine } from './agent-engine.ts';
import { AGENT_CAL } from './agent-model.ts';
import { temperatureFor, type DecisionContext } from './agent-decision.ts';
import type { Attributes, Phase, SquadPlayer, Tactics, Vec2 } from './engine-types.ts';

const ATTR_KEYS = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
  'tackling', 'marking', 'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping',
  'agility', 'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
  'aggression', 'gkReflexes', 'gkPositioning', 'gkDistribution',
] as const;

function flat(isGk: boolean): Attributes {
  const a = {} as Attributes;
  for (const k of ATTR_KEYS) a[k] = k.startsWith('gk') ? (isGk ? 14 : 3) : isGk ? 10 : 12;
  return a;
}

const FORMATION: Array<{ def: Vec2; att: Vec2 }> = [
  { def: { x: 6, y: 34 }, att: { x: 13, y: 34 } },
  { def: { x: 16, y: 25 }, att: { x: 40, y: 25 } },
  { def: { x: 16, y: 43 }, att: { x: 40, y: 43 } },
  { def: { x: 19, y: 9 }, att: { x: 58, y: 8 } },
  { def: { x: 19, y: 59 }, att: { x: 58, y: 60 } },
  { def: { x: 30, y: 34 }, att: { x: 55, y: 34 } },
  { def: { x: 34, y: 20 }, att: { x: 66, y: 20 } },
  { def: { x: 34, y: 48 }, att: { x: 66, y: 48 } },
  { def: { x: 44, y: 10 }, att: { x: 86, y: 11 } },
  { def: { x: 44, y: 58 }, att: { x: 86, y: 57 } },
  { def: { x: 46, y: 34 }, att: { x: 93, y: 34 } },
];
const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05, buildUp: 0.3, counterPress: 0.55, progression: 0.6, counterAttack: 0.85, finalThird: 1.0,
};

function side(prefix: string, sharpness?: number): { squad: SquadPlayer[]; tactics: Tactics } {
  const squad: SquadPlayer[] = [];
  const players: Tactics['players'] = [];
  for (let i = 0; i < 11; i++) {
    const id = `${prefix}${i}`;
    squad.push({
      playerId: id,
      attributes: flat(i === 0),
      physical: { heightCm: i === 0 ? 190 : 180, weightKg: 78, preferredFoot: 'R', injuryProneness: 10 },
      fatigue: 0.1,
      ...(sharpness !== undefined ? { sharpness } : {}),
      familiarity: {},
    });
    const slot = FORMATION[i];
    const anchors = {} as Record<Phase, Vec2>;
    for (const [phase, t] of Object.entries(PHASE_BLEND) as Array<[Phase, number]>) {
      anchors[phase] = { x: slot.def.x + (slot.att.x - slot.def.x) * t, y: slot.def.y + (slot.att.y - slot.def.y) * t };
    }
    players.push({
      playerId: id,
      anchors,
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

function playHalf(homeSharp: number | undefined, awaySharp: number | undefined, seed: string) {
  const home = side('H', homeSharp);
  const away = side('A', awaySharp);
  return new AgentEngine().simulateHalf(
    { fixtureId: seed, homeClubId: 'H', awayClubId: 'A', half: 1 },
    { home: home.squad, away: away.squad },
    { home: home.tactics, away: away.tactics },
    seed,
  );
}

test('temperature: full-unsharp costs the sharpnessTemperaturePenalty — ≈3 decisions points, never execution noise', () => {
  const carrier = (s: number) =>
    ({ carrier: { attributes: flat(false), sharpness: s }, pressure: 0 }) as unknown as DecisionContext;
  const sharp = temperatureFor(carrier(1));
  const rusty = temperatureFor(carrier(0));
  assert.ok(Math.abs(rusty - sharp - AGENT_CAL.sharpnessTemperaturePenalty) < 1e-12);
  // the same channel decisions relieve: penalty ≈ 2 points of decisions —
  // "a few attribute points, not half the player" (medium spec)
  assert.ok(Math.abs(AGENT_CAL.sharpnessTemperaturePenalty / AGENT_CAL.temperaturePerDecisionsPoint - 2) < 0.01);
  const half = temperatureFor(carrier(0.5));
  assert.ok(sharp < half && half < rusty, 'monotone in rust');
});

test('full-sharp is a NO-OP: absent sharpness and explicit 1 produce byte-identical halves', () => {
  const a = playHalf(undefined, undefined, 'sharp-noop');
  const b = playHalf(1, 1, 'sharp-noop');
  assert.equal(JSON.stringify(a.endState), JSON.stringify(b.endState));
  assert.equal(JSON.stringify(a.stats), JSON.stringify(b.stats));
});

test('unsharp XI drains condition faster over a half (the visible cost)', () => {
  const meanFatigue = (r: ReturnType<typeof playHalf>, prefix: string): number => {
    const rows = Object.entries(r.endState.playerState).filter(([id]) => id.startsWith(prefix));
    return rows.reduce((s, [, st]) => s + st.fatigue, 0) / rows.length;
  };
  // identical squads, same seed: away drops to 0.3 sharpness in the second run
  let sharpSum = 0;
  let rustySum = 0;
  for (const seed of ['sharp-drain-1', 'sharp-drain-2', 'sharp-drain-3']) {
    sharpSum += meanFatigue(playHalf(1, 1, seed), 'A');
    rustySum += meanFatigue(playHalf(1, 0.3, seed), 'A');
  }
  // ×1.35 accrual (gain 0.5 × rust 0.7) minus behavior drift: demand a clear gap
  assert.ok(rustySum > sharpSum * 1.15, `rusty XI ends more fatigued (${(rustySum / 3).toFixed(3)} vs ${(sharpSum / 3).toFixed(3)})`);
});
