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

/** L5E — the COVERED DUEL (the defensive-brain acceptance): a brained
 * attacker in the attacker's half vs a brained presser with a brained
 * second man BEHIND him (defensive_principles II.5/II.7: press → cover).
 * Real football forces duels with cover, not corridors. Watch: the
 * presser's give-ground ride (never the face-park), the cover man holding
 * the carrier→goal line — and the pair HERDING the attacker to the flank,
 * where the strip comes. The old leftover rule dragged the second man
 * ball-side and the attacker rounded the pair 16/16. */
const coveredDuel = (name: string, dribbling: number): ScenarioDef => ({
  version: 1,
  name,
  description: `Attacker (dribbling ${dribbling}) with a brain vs an elected presser + a cover man protecting BEHIND the press (principles II.7). Judge the ride, the goal-side cover, and the herd to the flank — danger through the middle should die.`,
  durationTicks: 300, // 30 s
  bodies: [
    { id: 'attacker', team: 'home', pos: { x: 62, y: 34 }, brain: 'onBall',
      attributes: { pace: 14, acceleration: 14, agility: 14, balance: 14, dribbling, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'def1', team: 'away', pos: { x: 74, y: 34 }, facing: Math.PI, brain: 'onBall',
      instructions: { pressing: 0.8 },
      attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'def2', team: 'away', pos: { x: 84, y: 30 }, facing: Math.PI, brain: 'onBall',
      instructions: { pressing: 0.8 },
      attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
  ],
  ball: { carrier: 'attacker' },
  script: [],
});

export const coveredDuelScenarios: ScenarioDef[] = [
  coveredDuel('duel-2v1-covered-close', 17), coveredDuel('duel-2v1-covered-heavy', 5),
];

/** L5E — MATCH-SHAPED duels (the builder's rule: decision scenes need a
 * real option set; the empty 2v1 flattered both sides at once). The 2v2:
 * the attacker has an outlet — def2 must MARK him (goal-side + ball-
 * shade, the L) or one pass undoes the press. The 3v2: a spare man
 * exists — press, mark, AND cover-behind all staffed. Judge: the mark's
 * L-shape on the outlet, the denied pass, and — honestly — the carry
 * still winning too often once the pass is dead: the retreating machine
 * never STOPS conceding (the kick-and-rush root, the next machine item). */
const matchDuel = (name: string, dribbling: number, spare: boolean): ScenarioDef => ({
  version: 1,
  name,
  description: `Attacker (dribbling ${dribbling}) + an outlet mate vs ${spare ? 'THREE defenders (press + mark + cover-behind — the spare-man chain)' : 'two defenders (press + mark — man-for-man, no spare)'}. Judge the mark's L on the outlet (goal-side, ball-shaded), the denied pass, and where the carry endgame leaks.`,
  durationTicks: 300,
  bodies: [
    { id: 'attacker', team: 'home', pos: { x: 62, y: 34 }, brain: 'onBall',
      attributes: { pace: 14, acceleration: 14, agility: 14, balance: 14, dribbling, firstTouch: 12, passing: 14, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'mate', team: 'home', pos: { x: 66, y: 22 }, brain: 'onBall',
      attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 13, firstTouch: 13, passing: 14, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'def1', team: 'away', pos: { x: 74, y: 34 }, facing: Math.PI, brain: 'onBall',
      instructions: { pressing: 0.8 },
      attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'def2', team: 'away', pos: { x: 84, y: 30 }, facing: Math.PI, brain: 'onBall',
      instructions: { pressing: 0.8 },
      attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    ...(spare ? [{ id: 'def3', team: 'away' as const, pos: { x: 88, y: 38 }, facing: Math.PI, brain: 'onBall' as const,
      instructions: { pressing: 0.8 },
      attributes: { pace: 14, acceleration: 14, agility: 13, balance: 13, dribbling: 10, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } }] : []),
  ],
  ball: { carrier: 'attacker' },
  script: [],
});

export const matchDuelScenarios: ScenarioDef[] = [
  matchDuel('duel-2v2-covered-close', 17, false),
  matchDuel('duel-2v2-covered-heavy', 5, false),
  matchDuel('duel-3v2-spare-close', 17, true),
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
  description: 'Two stacked teammates race one loose ball under press; ONE claims, the twin offsets as an outlet, and the collector\'s PASS to the third man survives — the twin no longer eats it. Judge the arbitration, the bracketing, and the released pass.',
  durationTicks: 120,
  bodies: [
    // the stacked pair — the ball is THEIRS to race (mid is far)
    { id: 't1', team: 'home', pos: { x: 40, y: 34 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 }, brain: 'onBall' },
    { id: 't2', team: 'home', pos: { x: 40.8, y: 34.5 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 }, brain: 'onBall' },
    // the third man — the upfield outlet the pass must reach
    { id: 'mid', team: 'home', pos: { x: 56, y: 34 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 }, brain: 'onBall' },
    // a presser converging on the collector — carrying is not free, the
    // RELEASE is the right play (the corner flap's original shape)
    { id: 'presser', team: 'away', pos: { x: 47, y: 28 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 12, firstTouch: 12, passing: 12, tackling: 13, strength: 13, stamina: 12 }, brain: 'onBall' },
  ],
  ball: { pos: { x: 44, y: 33 } },
  script: [
    { atTick: 2, bodyId: 't1', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 2, bodyId: 't2', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 4, bodyId: 'presser', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};
