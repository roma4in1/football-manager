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

/** a driven lofted ball from the feeder over the defensive LINE to a runner
 * who arrives on the drop. Loft solved so it LANDS ~38 m out, behind the
 * line — by the line's distance (~20 m) the ball is at/past apex, over a
 * standing defender's head. A near blocker needs a steeper chip (later). */
const feedDist = 38;
const feedLoft = 24;

export const aerialThrough: ScenarioDef = {
  version: 1,
  name: 'aerial-through',
  description: 'A driven lofted ball over a parked defender drops behind the line for a runner arriving on it — the aerial through ball. Judge the flight and the control-on-the-drop.',
  durationTicks: 120,
  bodies: [
    { id: 'feeder', team: 'home', pos: { x: 46, y: 34 }, attributes: passer },
    // the runner starts level with the line, times his run onto the drop
    { id: 'runner', team: 'home', pos: { x: 64, y: 34 }, attributes: { ...passer, pace: 16, acceleration: 15 }, brain: 'onBall' },
    // a defender on the LINE, in the GROUND lane — a rolled ball never arrives
    { id: 'blocker', team: 'away', pos: { x: 66, y: 34 }, attributes: passer },
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

export const aerialScenarios: ScenarioDef[] = [aerialThrough];
