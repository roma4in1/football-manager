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
    // aim WIDE (down the line at y34), curl +120 back up to the receiver
    { atTick: 10, bodyId: 'kicker', kick: { target: { x: 74, y: 34 }, speedMps: 20, loftDeg: 8, spin: 120 } },
  ],
};

export const curveScenarios: ScenarioDef[] = [curledPass];
