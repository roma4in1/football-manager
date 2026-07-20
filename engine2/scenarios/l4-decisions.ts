/**
 * L4 scenarios — on-ball decisions (spec §5-L4 acceptance: rondo and 3v2;
 * choices look like footballers' choices; no backward passes from clear
 * chances; risk visibly shifts the choice distribution).
 *
 * Discipline: opponents are SCRIPTED chasers (no defending AI before L5);
 * off-ball teammates are parked — support movement is L5a's. The only
 * off-ball intelligence here is the L4 receive reflex (go meet your pass).
 */
import type { BodyAttributes, ScenarioDef } from '../engine2-types.ts';

const passer: BodyAttributes = { pace: 12, acceleration: 12, agility: 13, balance: 13, dribbling: 13, firstTouch: 15, passing: 16, tackling: 10, strength: 11, stamina: 12 };
const chaser: BodyAttributes = { pace: 13, acceleration: 13, agility: 12, balance: 12, dribbling: 10, firstTouch: 11, passing: 11, tackling: 14, strength: 13, stamina: 14 };

/** rondo 4v2 — keep-away on a ~14m square. The judged questions: does the
 * carrier pick the pass AWAY from the chasers' pressure, and does the ball
 * keep moving? */
export const rondo4v2: ScenarioDef = {
  version: 1,
  name: 'rondo-4v2',
  description: 'Four brains keep the ball on a 14m square against two scripted chasers. Judge: passes chosen away from pressure, the ball moving, no suicidal lanes through the middle.',
  durationTicks: 400, // 40 s
  bodies: [
    { id: 'p1', team: 'home', pos: { x: 40, y: 27 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    { id: 'p2', team: 'home', pos: { x: 54, y: 27 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    { id: 'p3', team: 'home', pos: { x: 54, y: 41 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    { id: 'p4', team: 'home', pos: { x: 40, y: 41 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    { id: 'c1', team: 'away', pos: { x: 45, y: 33 }, attributes: chaser },
    { id: 'c2', team: 'away', pos: { x: 49, y: 35 }, attributes: chaser },
  ],
  ball: { carrier: 'p1' },
  script: [
    { atTick: 14, bodyId: 'c1', command: { type: 'chaseBall', regime: 'run' } },
    { atTick: 22, bodyId: 'c2', command: { type: 'chaseBall', regime: 'run' } },
  ],
};

/** counter 3v2 — the break: carrier + two lanes vs two retreating defenders.
 * The judged questions: carry into space, slip the pass when a defender
 * commits, and SHOOT when the chance is clear (never pass backward from it). */
const counter = (name: string, risk: number, description: string): ScenarioDef => ({
  version: 1,
  name,
  description,
  durationTicks: 220, // 22 s
  bodies: [
    { id: 'mid', team: 'home', pos: { x: 52, y: 34 }, attributes: { ...passer, pace: 14, acceleration: 14 }, brain: 'onBall', instructions: { risk } },
    { id: 'left', team: 'home', pos: { x: 58, y: 22 }, attributes: { ...passer, pace: 15, acceleration: 14 }, brain: 'onBall', instructions: { risk } },
    { id: 'right', team: 'home', pos: { x: 58, y: 46 }, attributes: { ...passer, pace: 15, acceleration: 14 }, brain: 'onBall', instructions: { risk } },
    // the dial needs an ASYMMETRIC choice: d1 shades the deep left lane
    // (risky ball, big payoff), the right man offers safe feet (low payoff).
    // Scripted chasers, no defending AI
    { id: 'd1', team: 'away', pos: { x: 61, y: 27 }, attributes: chaser },
    { id: 'd2', team: 'away', pos: { x: 62, y: 38 }, attributes: chaser },
  ],
  // the ball arrives LOOSE so the break develops before the first choice —
  // a t=0 pass to a static runner expressed nothing
  ball: { pos: { x: 46, y: 34 } },
  script: [
    { atTick: 0, bodyId: 'mid', command: { type: 'chaseBall', regime: 'run' } },
    // left runs IN BEHIND (the speculative ball); right offers SUPPORT
    // (the safe one) — scripted routes, L5b owns real runs
    { atTick: 4, bodyId: 'left', command: { type: 'moveTo', target: { x: 90, y: 22 }, regime: 'run' } },
    // right DROPS as the recycle outlet (behind the ball line — a forward
    // flank route was a free progressive ball that preempted the dial)
    { atTick: 4, bodyId: 'right', command: { type: 'moveTo', target: { x: 54, y: 44 }, regime: 'run' } },
    // the lane defender COMMITS to the carrier at 3s — the safe man slips
    // his pass now; the speculative man has already hit it
    { atTick: 30, bodyId: 'd1', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 8, bodyId: 'd2', command: { type: 'moveTo', target: { x: 84, y: 36 }, regime: 'sprint' } },
    { atTick: 70, bodyId: 'd2', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
});

export const counter3v2 = counter('counter-3v2', 0.5,
  'A 3v2 break: the mid carries at two recovering defenders with runners wide. Judge: carry into space, the slipped pass when a defender commits, the shot when the chance is clear.');

/** the risk dial (spec: instruction visibly shifts the choice distribution).
 * Same geometry, opposite instructions — judged and asserted as a pair. */
export const counterRiskLow = counter('counter-3v2-risk-low', 0.12,
  'The 3v2 break under a SAFETY-FIRST instruction — expect the conservative lane and more carrying.');
export const counterRiskHigh = counter('counter-3v2-risk-high', 0.88,
  'The 3v2 break under a SPECULATIVE instruction — expect the aggressive early ball into the runners.');

/** striker breakaway — the by-construction property: through on goal, the
 * striker SHOOTS. No role flag makes him; the EV does. */
export const strikerBreakaway: ScenarioDef = {
  version: 1,
  name: 'striker-breakaway',
  description: 'A striker runs onto a through ball inside the box with a defender chasing behind. The construction claim: he shoots — every seed, no instruction, no role flag.',
  durationTicks: 140, // 14 s
  bodies: [
    { id: 'feeder', team: 'home', pos: { x: 62, y: 30 }, attributes: passer },
    { id: 'striker', team: 'home', pos: { x: 78, y: 36 }, attributes: { ...passer, pace: 15, acceleration: 15 }, brain: 'onBall' },
    { id: 'chaser', team: 'away', pos: { x: 74, y: 39 }, attributes: chaser },
  ],
  ball: { carrier: 'feeder' },
  script: [
    { atTick: 16, bodyId: 'striker', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 18, bodyId: 'chaser', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
  kicks: [
    // 12 m/s dies ~42m out — collectable across the kick-noise spread (a
    // 13 m/s draw outran the striker and rolled itself over the line)
    { atTick: 14, bodyId: 'feeder', kick: { target: { x: 90, y: 34 }, speedMps: 12, loftDeg: 0 } },
  ],
};

export const l4Scenarios: ScenarioDef[] = [
  rondo4v2, counter3v2, counterRiskLow, counterRiskHigh, strikerBreakaway,
];
