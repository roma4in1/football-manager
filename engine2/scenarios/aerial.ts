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

export const aerialScenarios: ScenarioDef[] = [aerialThrough, aerialChip];
