/**
 * duel-1v1-* — one defender vs one attacker (the L2 judgment ask). No
 * tackles yet (L3): the defender wins by PINCHING a running touch — the
 * arrival race for the ball itself. Two variants decide the duel by touch
 * quality: close control keeps the ball nearest the carrier through the
 * defender's zone; heavy feet serve the touch to the defender's line.
 * Also the weave drill: small alternating direction changes with the ball.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const duel = (name: string, dribbling: number): ScenarioDef => ({
  version: 1,
  name,
  description: `Attacker (dribbling ${dribbling}) sprint-carries the line; a defender recovers from the flank hunting the ball. At L3 a chase-only defender cannot jockey — watch the shield, the touch races, and the lunges; the outcome-split by touch quality arrives with L5e marking/duels.`,
  durationTicks: 240, // 24 s
  bodies: [
    { id: 'attacker', team: 'home', pos: { x: 25, y: 34 }, attributes: { pace: 14, acceleration: 14, agility: 14, balance: 14, dribbling, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'defender', team: 'away', pos: { x: 27, y: 38 }, attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
  ],
  ball: { carrier: 'attacker' },
  script: [
    { atTick: 10, bodyId: 'attacker', command: { type: 'moveTo', target: { x: 95, y: 34 }, regime: 'sprint' } },
    { atTick: 16, bodyId: 'defender', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
});

export const duelScenarios: ScenarioDef[] = [duel('duel-1v1-close', 17), duel('duel-1v1-heavy', 5)];

export const weave: ScenarioDef = {
  version: 1,
  name: 'dribble-weave',
  description: 'Small direction changes with the ball: a close-control carrier weaves a five-gate slalom at run pace — left, right, left, right, home. Judge the touch-follow through each gate.',
  durationTicks: 260, // 26 s
  bodies: [
    { id: 'carrier', team: 'home', pos: { x: 20, y: 34 }, attributes: { pace: 14, acceleration: 14, agility: 15, balance: 15, dribbling: 17, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
  ],
  ball: { carrier: 'carrier' },
  script: [
    {
      atTick: 10,
      bodyId: 'carrier',
      command: {
        type: 'followPath',
        points: [
          { x: 33, y: 29 }, { x: 45, y: 39 }, { x: 57, y: 29 }, { x: 69, y: 39 }, { x: 80, y: 34 },
        ],
        regime: 'run',
      },
    },
  ],
};
