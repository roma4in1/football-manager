/**
 * aerial-* — the LOFTED ball (physics.md flight: gravity + drag + bounce).
 * The ground thread is dead (a defender sits in the lane), but a driven ball
 * OVER the line drops for a runner beyond it — the aerial through ball the
 * KDB kit was deferred for. First the RECEIVE (scripted loft, emergent
 * control-on-the-drop); the DECISION to loft is layered on next.
 */
import type { ScenarioDef } from '../engine2-types.ts';
import { solveLoftSpeed } from '../ball.ts';

const passer = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 16, passing: 17, tackling: 12, strength: 12, stamina: 12 };

/** a lofted ball from the feeder over the defensive line to a runner who
 * arrives on the drop. The loft is weighted to CLEAR the line as it rises
 * (32° peaks ~2.7 m by the line at 12 m) and then DROP behind it, settling
 * ~30 m out for the runner — not a driven ball that skips on to the penalty
 * spot (the judged over-hit). */
const feedDist = 30;
const feedLoft = 32;

export const aerialThrough: ScenarioDef = {
  version: 1,
  name: 'aerial-through',
  description: 'A driven lofted ball over a parked defender drops behind the line for a runner arriving on it — the aerial through ball. Judge the flight and the control-on-the-drop.',
  durationTicks: 120,
  bodies: [
    { id: 'feeder', team: 'home', pos: { x: 46, y: 34 }, attributes: passer },
    // the runner starts just behind the line, times his run onto the drop
    { id: 'runner', team: 'home', pos: { x: 56, y: 34 }, attributes: { ...passer, pace: 16, acceleration: 15 }, brain: 'onBall' },
    // a defender on the line, in the GROUND lane — a rolled ball never arrives
    { id: 'blocker', team: 'away', pos: { x: 58, y: 34 }, attributes: passer },
  ],
  ball: { carrier: 'feeder' },
  script: [
    // the runner breaks onto the space behind as the ball is struck
    { atTick: 10, bodyId: 'runner', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
  kicks: [
    // land ~34 m out (x≈80), a driven 22° loft clearing the blocker at x60
    { atTick: 12, bodyId: 'feeder', kick: { target: { x: 46 + feedDist, y: 34 }, speedMps: solveLoftSpeed(feedDist, feedLoft), loftDeg: feedLoft } },
  ],
};

/** the DECISION: an unscripted carrier's direct ground lane to a mate is
 * blocked by a defender; the mate is open beyond. The carrier should LOFT it
 * over — the ground ball never arrives, the air ball does. */
export const aerialChip: ScenarioDef = {
  version: 1,
  name: 'aerial-chip',
  description: 'The carrier\'s ground lane to an open mate is blocked by a defender in the way; he should chip/loft over rather than force the ground ball. Judge the decision to go aerial.',
  durationTicks: 90,
  bodies: [
    { id: 'carrier', team: 'home', pos: { x: 46, y: 34 }, attributes: { ...passer, passing: 17 }, brain: 'onBall', instructions: { risk: 0.6 } },
    // the open mate beyond the block — a clean drop, no defender near him
    { id: 'mate', team: 'home', pos: { x: 72, y: 34 }, attributes: passer, brain: 'onBall', instructions: { risk: 0.4 } },
    // a defender square in the DIRECT ground lane, mid-way
    { id: 'blocker', team: 'away', pos: { x: 58, y: 34 }, attributes: passer },
  ],
  ball: { carrier: 'carrier' },
  script: [],
};

/** the AERIAL CONTEST: a lofted ball drops into a zone where an attacker and
 * a defender both stand under it — they challenge in the air. The defender
 * (deep, near his own goal) should HEAD IT CLEAR upfield; unchallenged the
 * attacker would have collected it. Makes the loft over a defender honest. */
// a SHORT, steep drop right onto the two players — small travel keeps the
// landing tight (loft range scatters with v²), so both are reliably under it
const contestDist = 6;
const contestLoft = 68;
export const aerialContest: ScenarioDef = {
  version: 1,
  name: 'aerial-contest',
  description: 'A lofted ball drops between an attacker and a defender standing under it — they contest the header. The defender clears it; unchallenged the attacker takes it. Judge the aerial duel.',
  durationTicks: 90,
  bodies: [
    { id: 'feeder', team: 'home', pos: { x: 66, y: 34 }, attributes: { ...passer, passing: 19 } },
    // both stand under the drop and leap together
    { id: 'attacker', team: 'home', pos: { x: 72.7, y: 34.6 }, attributes: { ...passer, strength: 12 }, brain: 'onBall' },
    { id: 'defender', team: 'away', pos: { x: 71.5, y: 33.5 }, attributes: { ...passer, strength: 16 }, brain: 'onBall' },
  ],
  ball: { carrier: 'feeder' },
  kicks: [
    { atTick: 10, bodyId: 'feeder', kick: { target: { x: 66 + contestDist, y: 34 }, speedMps: solveLoftSpeed(contestDist, contestLoft), loftDeg: contestLoft } },
  ],
  script: [
    // both read the steep drop and converge on it, then leap together
    { atTick: 11, bodyId: 'attacker', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 11, bodyId: 'defender', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

/** the CROSS + attacking header: a wide player floats a ball into the box and
 * a striker attacks it, heading it AT GOAL (the attacking-header branch — the
 * winner near the opponent goal heads toward it, not a clearance). */
const crossDist = 16;
const crossLoft = 54;
export const crossHeader: ScenarioDef = {
  version: 1,
  name: 'cross-header',
  description: 'A wide player crosses into the box; a striker attacks the drop and heads it AT GOAL. Judge the delivery, the attacking header, and its direction on target.',
  durationTicks: 90,
  bodies: [
    // a crosser near the right by-line (home attacks +x, goal at 105)
    { id: 'crosser', team: 'home', pos: { x: 89, y: 47 }, attributes: { ...passer, passing: 18 } },
    // the striker attacks the near-central drop, ~7 m from goal
    { id: 'striker', team: 'home', pos: { x: 96, y: 35.5 }, attributes: { ...passer, strength: 15, pace: 15 }, brain: 'onBall' },
  ],
  ball: { carrier: 'crosser' },
  kicks: [
    // a floated cross that drops steeply into the six-yard area (~x99, y33)
    { atTick: 10, bodyId: 'crosser', kick: { target: { x: 98.5, y: 34 }, speedMps: solveLoftSpeed(crossDist, crossLoft), loftDeg: crossLoft } },
  ],
  script: [
    { atTick: 11, bodyId: 'striker', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

export const aerialScenarios: ScenarioDef[] = [aerialThrough, aerialChip, aerialContest, crossHeader];
