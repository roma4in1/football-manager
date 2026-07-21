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
    // d1 parks ON the carry line (a park inside the through lane meant the
    // honest EV could never rate the deep ball at the release moment)
    { id: 'd1', team: 'away', pos: { x: 60, y: 34 }, attributes: chaser },
    { id: 'd2', team: 'away', pos: { x: 62, y: 38 }, attributes: chaser },
  ],
  // the ball arrives LOOSE so the break develops before the first choice —
  // a t=0 pass to a static runner expressed nothing
  ball: { pos: { x: 46, y: 34 } },
  script: [
    { atTick: 0, bodyId: 'mid', command: { type: 'chaseBall', regime: 'run' } },
    // left runs IN BEHIND (the speculative ball); right offers SUPPORT
    // (the safe one) — scripted routes, L5b owns real runs
    // the deep run bends IN BEHIND toward goal — a corner-flag run valued
    // the same as the safe outlet, and the through ball never won its risk
    { atTick: 4, bodyId: 'left', command: { type: 'moveTo', target: { x: 88, y: 26 }, regime: 'run' } },
    // right runs FORWARD into open space — the judged dial semantics: the
    // SAFE choice is the ball to the open man, not keeping the dribble
    // right settles EARLY as the standing outlet — a second deep runner's
    // lead point valued like the through ball and the dial had no safe pole
    { atTick: 4, bodyId: 'right', command: { type: 'moveTo', target: { x: 64, y: 46 }, regime: 'run' } },
    // the lane defender COMMITS to the carrier at 3s — the safe man slips
    // his pass now; the speculative man has already hit it
    { atTick: 30, bodyId: 'd1', command: { type: 'chaseBall', regime: 'sprint' } },
    // d2 recovers INTO the left channel early — the run machinery matured
    // until the left thread was a SAFE killer ball and the dial's premise
    // (left = the risky one) eroded; his cover restores it
    { atTick: 8, bodyId: 'd2', command: { type: 'moveTo', target: { x: 77, y: 26 }, regime: 'sprint' } },
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

/** L5b — the in-behind run: NOTHING is scripted for the striker. The run
 * must come from the trigger (team has the ball, room behind the line),
 * the line-riding from geometry, the through ball from the carrier's EV,
 * and the burst from the receive reflex. Judge: does it look like a
 * striker playing off the last man? */
export const runsInBehind: ScenarioDef = {
  version: 1,
  name: 'runs-in-behind',
  description: 'A playmaker carries; an unscripted striker rides the two-man line, and the through ball releases him. The whole move is emergent — trigger, line-ride, release, burst.',
  durationTicks: 220,
  bodies: [
    { id: 'playmaker', team: 'home', pos: { x: 46, y: 34 }, attributes: { ...passer, passing: 17 }, brain: 'onBall', instructions: { risk: 0.7 } },
    // the striker starts ON the line, marked — the ball to his feet is
    // taxed (contested receive), so the RUN is where the value lives
    { id: 'striker', team: 'home', pos: { x: 66.5, y: 28 }, attributes: { ...passer, pace: 16, acceleration: 15, firstTouch: 16 }, brain: 'onBall', instructions: { risk: 0.7 } },
    // the two-man line — parked; d1 reacts late (defending AI is L5c/d)
    // d1 marks TIGHT (a loose mark left the feet-ball free and no run
    // was ever needed)
    { id: 'd1', team: 'away', pos: { x: 67.3, y: 28.6 }, attributes: chaser },
    { id: 'd2', team: 'away', pos: { x: 68, y: 39 }, attributes: chaser },
  ],
  ball: { carrier: 'playmaker' },
  script: [
    { atTick: 60, bodyId: 'd1', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 90, bodyId: 'd2', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

/** L5b — the wall pass (one-two): NOTHING scripted. The give, the run
 * beyond, the first-time return into the dart — all emergent from runPlan
 * + the release-meets-the-run coupling. Taxonomy #22 (emergent class). */
export const wallPass: ScenarioDef = {
  version: 1,
  name: 'wall-pass',
  description: 'Give-and-go, unscripted: the playmaker feeds the wall man, runs beyond the line, and the return meets his dart. Judge the one-two shape.',
  durationTicks: 200,
  bodies: [
    { id: 'playmaker', team: 'home', pos: { x: 58, y: 31 }, attributes: { ...passer, pace: 14, acceleration: 14, passing: 17 }, brain: 'onBall', instructions: { risk: 0.6 } },
    // the wall man is a PIVOT: marked from behind, back to goal, keep
    // objective — his best ball is the first-time return (a free wall man
    // just turned and went himself, which was correct EV and no one-two)
    { id: 'wall', team: 'home', pos: { x: 64, y: 33 }, attributes: { ...passer, firstTouch: 17, passing: 16 }, brain: 'onBall', instructions: { risk: 0.25 } },
    { id: 'd1', team: 'away', pos: { x: 65.9, y: 34.6 }, attributes: chaser },
    { id: 'd2', team: 'away', pos: { x: 66, y: 26 }, attributes: chaser },
  ],
  ball: { carrier: 'playmaker' },
  script: [
    // pin the wall as a pivot (his marker pins him in reality; scripted
    // ownership keeps runPlan/support from walking him off the spot —
    // 'keep' staging instead ZEROED the path ball via the station tether)
    { atTick: 190, bodyId: 'wall', command: { type: 'hold' } },
    { atTick: 70, bodyId: 'd1', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 100, bodyId: 'd2', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

/** L5c — the back line as a unit: three defender BRAINS (the first
 * defending brains in the engine) hold a line against circulation. Judge:
 * shared depth, the ball-side slide, step/drop with advance, spacing. */
export const backLineShift: ScenarioDef = {
  version: 1,
  name: 'back-line-shift',
  description: 'Three home passers circulate; an AWAY back three of brains holds the line — watch the unit slide with the ball, drop with advance, and keep its spacing.',
  durationTicks: 400,
  bodies: [
    { id: 'p1', team: 'home', pos: { x: 52, y: 14 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    { id: 'p2', team: 'home', pos: { x: 48, y: 34 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    { id: 'p3', team: 'home', pos: { x: 52, y: 54 }, attributes: passer, brain: 'onBall', instructions: { objective: 'keep' } },
    // a HIGH line (0.8): judge the STEP UP toward the distant circulation
    // as well as the drop — the first tactics knob (defensive.md)
    { id: 'cb1', team: 'away', pos: { x: 72, y: 22 }, attributes: chaser, brain: 'onBall', instructions: { lineHeight: 0.8 } },
    { id: 'cb2', team: 'away', pos: { x: 72, y: 34 }, attributes: chaser, brain: 'onBall', instructions: { lineHeight: 0.8 } },
    { id: 'cb3', team: 'away', pos: { x: 72, y: 46 }, attributes: chaser, brain: 'onBall', instructions: { lineHeight: 0.8 } },
  ],
  ball: { carrier: 'p2' },
  script: [],
};

/** L5c × L5b — the first true small-sided interplay: the APPROVED
 * runs-in-behind attack against a LIVING two-man line (brains, not parked
 * statues). The line drops with the dart and shifts with the ball; the
 * thread must now beat a moving unit. Nothing is scripted on either side. */
export const lineVsRuns: ScenarioDef = {
  version: 1,
  name: 'line-vs-runs',
  description: 'The approved run-in-behind attack vs a living back two: the line drops with the dart, slides with the ball, and the thread must beat a moving unit. Fully emergent, both sides.',
  durationTicks: 260,
  bodies: [
    { id: 'playmaker', team: 'home', pos: { x: 46, y: 34 }, attributes: { ...passer, passing: 17 }, brain: 'onBall', instructions: { risk: 0.7 } },
    { id: 'striker', team: 'home', pos: { x: 66.5, y: 28 }, attributes: { ...passer, pace: 16, acceleration: 15, firstTouch: 16 }, brain: 'onBall', instructions: { risk: 0.7 } },
    { id: 'cb1', team: 'away', pos: { x: 70, y: 29 }, attributes: chaser, brain: 'onBall' },
    { id: 'cb2', team: 'away', pos: { x: 70, y: 39 }, attributes: chaser, brain: 'onBall' },
  ],
  ball: { carrier: 'playmaker' },
  script: [],
};

export const l4Scenarios: ScenarioDef[] = [
  rondo4v2, counter3v2, counterRiskLow, counterRiskHigh, strikerBreakaway, runsInBehind, wallPass, backLineShift, lineVsRuns,
];
