/**
 * curve-* — the Magnus CURVE (physics.md: sidespin bends the flight). The
 * kicker aims WIDE of a defender and bends the ball back to a receiver — a
 * ball the straight lane could not reach cleanly. The last physical-pass
 * piece; the DECISION to bend (trivela / inswinger) layers on next.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const passer = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 16, passing: 18, tackling: 12, strength: 12, stamina: 12 };

/** aimed straight down the line (74,34), a +spin of this curls the ball UP
 * ~3.5 m to end near (73,37.5) — around a defender sitting on the direct
 * kicker→receiver line. */
export const curledPass: ScenarioDef = {
  version: 1,
  name: 'curled-pass',
  description: 'The kicker bends the ball AROUND a defender on the direct line to a receiver — aimed wide, curled back by sidespin. Judge the curve and the receive.',
  durationTicks: 90,
  bodies: [
    { id: 'kicker', team: 'home', pos: { x: 46, y: 34 }, attributes: passer },
    // the receiver is off the straight aim — only the curl reaches him
    { id: 'receiver', team: 'home', pos: { x: 71, y: 37.5 }, attributes: { ...passer, pace: 15 }, brain: 'onBall' },
    // a defender square on the direct kicker→receiver line — a straight ball
    // is his; the curl (aimed wide) bends past him
    { id: 'defender', team: 'away', pos: { x: 59, y: 37 }, attributes: passer },
  ],
  ball: { carrier: 'kicker' },
  script: [
    { atTick: 12, bodyId: 'receiver', command: { type: 'chaseBall', regime: 'run' } },
  ],
  kicks: [
    // aim WIDE (down the line at y34), curl back up to the receiver
    { atTick: 10, bodyId: 'kicker', kick: { target: { x: 74, y: 34 }, speedMps: 20, loftDeg: 8, spin: 52 } },
  ],
};

/** the curling GROUND through ball: a playmaker threads a rolling ball
 * between the two centre backs and BENDS it out to a winger's run — a
 * trivela-style ball the straight thread could not curve into the channel. */
export const curledThrough: ScenarioDef = {
  version: 1,
  name: 'curled-through',
  description: 'A playmaker slides a curling GROUND ball between the two centre backs and bends it out to the winger running the channel. Judge the ball splitting the line and curving to the run.',
  durationTicks: 100,
  bodies: [
    { id: 'playmaker', team: 'home', pos: { x: 50, y: 34 }, attributes: { ...passer, passing: 19 }, brain: 'onBall' },
    // the winger starts wide and runs the channel onto the bending ball
    { id: 'winger', team: 'home', pos: { x: 64, y: 44 }, attributes: { ...passer, pace: 16, acceleration: 15 }, brain: 'onBall' },
    // the two centre backs — a gap between them at y≈34
    { id: 'cb1', team: 'away', pos: { x: 66, y: 29.5 }, attributes: passer },
    { id: 'cb2', team: 'away', pos: { x: 66, y: 38.5 }, attributes: passer },
  ],
  ball: { carrier: 'playmaker' },
  script: [
    { atTick: 12, bodyId: 'winger', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
  kicks: [
    // a driven GROUND ball (loft 0) through the gap, curling out (+spin) to
    // the winger's channel — splits the CBs at ~y36 then bends to ~y42
    { atTick: 10, bodyId: 'playmaker', kick: { target: { x: 78, y: 33 }, speedMps: 16, loftDeg: 0, spin: 85 } },
  ],
};

export const curveScenarios: ScenarioDef[] = [curledPass, curledThrough];
