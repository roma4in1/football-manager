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

/** the head-on duel (the L3 judgment ask): the chase duels only ever show
 * the defender ARRIVING FROM BEHIND, so he rarely gets a real tackle in.
 * Here the defender is parked IN the lane, facing the carrier, and steps to
 * meet him — contain sets the press, the tackle window is face-to-face, and
 * a heavy touch pushed into the defender's feet is his to pinch. */
const frontDuel = (name: string, dribbling: number): ScenarioDef => ({
  version: 1,
  name,
  description: `Attacker (dribbling ${dribbling}) carries straight AT a set defender who steps to meet him. Watch the front-on contain, the face-to-face tackle window, and the touch contest at the defender's feet. No feints yet — beating the set man with a move is L4's.`,
  durationTicks: 200, // 20 s
  bodies: [
    { id: 'attacker', team: 'home', pos: { x: 25, y: 34 }, attributes: { pace: 14, acceleration: 14, agility: 14, balance: 14, dribbling, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    // facing the carrier, set in his lane
    { id: 'defender', team: 'away', pos: { x: 48, y: 34 }, facing: Math.PI, attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
  ],
  ball: { carrier: 'attacker' },
  script: [
    { atTick: 10, bodyId: 'attacker', command: { type: 'moveTo', target: { x: 95, y: 34 }, regime: 'run' } },
    // the set defender steps IN as the carrier closes — the tackle gate
    // (and contain) both key off an active chase
    { atTick: 36, bodyId: 'defender', command: { type: 'chaseBall', regime: 'run' } },
    // second effort: a dispossessed attacker presses the winner instead of
    // jogging offscreen (if he still carries, this trades the carry for a
    // trap-and-stand — the duel is decided either way by now)
    { atTick: 110, bodyId: 'attacker', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
});

export const duelScenarios: ScenarioDef[] = [
  duel('duel-1v1-close', 17), duel('duel-1v1-heavy', 5),
  frontDuel('duel-1v1-front-close', 17), frontDuel('duel-1v1-front-heavy', 5),
];

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

/** L5E — loose-ball pursuit ARBITRATION: two stacked teammates race the same
 * loose ball. ONE claims (earliest arrival), the other takes a support offset
 * out of the lane — so the collector's pass to the THIRD man is not eaten by
 * his own twin (the corner flap's residual, measured and killed). */
export const looseArbitration: ScenarioDef = {
  version: 1,
  name: 'l5e-loose-arbitration',
  description: 'Two stacked teammates race one loose ball; one claims, the other offsets as an outlet, and the pass to the third man survives. Judge the arbitration and the separation.',
  durationTicks: 100,
  bodies: [
    { id: 't1', team: 'home', pos: { x: 40, y: 34 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 }, brain: 'onBall' },
    { id: 't2', team: 'home', pos: { x: 40.8, y: 34.5 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 }, brain: 'onBall' },
    { id: 'mid', team: 'home', pos: { x: 55, y: 34 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 }, brain: 'onBall' },
  ],
  ball: { pos: { x: 48, y: 33 } },
  script: [
    { atTick: 2, bodyId: 't1', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 2, bodyId: 't2', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};
