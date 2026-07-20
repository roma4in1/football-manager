/**
 * first-touch-run-* — receiving while MOVING (the L3 judgment ask). The
 * difficulty model rides CLOSING speed (ball relative to receiver), so the
 * same silk feet face two different problems: cushioning a ball they run
 * WITH (low closing speed — taken in stride) vs charging ONTO a drive
 * (closing speeds add — even good feet spill some).
 */
import type { ScenarioDef } from '../engine2-types.ts';

const base = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 18, passing: 19, tackling: 12, strength: 12, stamina: 12 };

export const firstTouchRunScenarios: ScenarioDef[] = [
  {
    version: 1,
    name: 'first-touch-run-with',
    description: 'The receiver runs the same line the pass travels — a cushioned take in stride (low closing speed). Silk feet should keep almost everything.',
    durationTicks: 160,
    bodies: [
      { id: 'feeder', team: 'home', pos: { x: 20, y: 34 }, attributes: { ...base, firstTouch: 12 } },
      { id: 'receiver', team: 'home', pos: { x: 45, y: 34.5 }, attributes: { ...base } },
    ],
    ball: { carrier: 'feeder' },
    script: [
      { atTick: 30, bodyId: 'receiver', command: { type: 'moveTo', target: { x: 90, y: 34.5 }, regime: 'run' } },
    ],
    kicks: [
      { atTick: 12, bodyId: 'feeder', kick: { target: { x: 70, y: 34.5 }, speedMps: 15, loftDeg: 0 } },
    ],
  },
  {
    version: 1,
    name: 'first-touch-run-onto',
    description: 'The receiver charges INTO the drive, adjusting to its actual line — closing speeds add and even silk feet spill some. Judge against run-with.',
    durationTicks: 120,
    bodies: [
      // a SHORT feed keeps the lateral noise inside the charge line — the
      // receiver genuinely charges (a chaseBall receiver arrives early and
      // waits, which is not this drill)
      { id: 'feeder', team: 'home', pos: { x: 45, y: 34 }, attributes: { ...base, firstTouch: 12 } },
      { id: 'receiver', team: 'home', pos: { x: 80, y: 34 }, attributes: { ...base } },
    ],
    ball: { carrier: 'feeder' },
    script: [
      { atTick: 20, bodyId: 'receiver', command: { type: 'moveTo', target: { x: 35, y: 34 }, regime: 'run' } },
    ],
    kicks: [
      { atTick: 12, bodyId: 'feeder', kick: { target: { x: 65, y: 34 }, speedMps: 13, loftDeg: 0 } },
    ],
  },
];

/** perpendicular + angled receives — the geometry matrix the judgment asked
 * for. The model rides RELATIVE velocity, so the angle expresses through the
 * closing-speed magnitude plus the receiver's own-speed term. */
export const firstTouchAngleScenarios: ScenarioDef[] = [
  {
    version: 1,
    name: 'first-touch-run-across',
    description: 'The receiver crosses the pass line at 90° — a ball taken across the body mid-stride.',
    durationTicks: 140,
    bodies: [
      { id: 'feeder', team: 'home', pos: { x: 25, y: 34 }, attributes: { ...base, firstTouch: 12 } },
      { id: 'receiver', team: 'home', pos: { x: 58, y: 12 }, attributes: { ...base } },
    ],
    ball: { carrier: 'feeder' },
    script: [
      { atTick: 16, bodyId: 'receiver', command: { type: 'moveTo', target: { x: 58, y: 58 }, regime: 'run' } },
      // the crossing runner ADJUSTS to the pass at the end — speed noise
      // moves the meeting point meters; nobody receives on rails
      { atTick: 44, bodyId: 'receiver', command: { type: 'chaseBall', regime: 'run' } },
    ],
    kicks: [
      { atTick: 26, bodyId: 'feeder', kick: { target: { x: 58, y: 33 }, speedMps: 13, loftDeg: 0 } },
    ],
  },
  {
    version: 1,
    name: 'first-touch-run-angled',
    description: 'The receiver meets the pass at ~45° — the between case of the receive-geometry matrix.',
    durationTicks: 140,
    bodies: [
      { id: 'feeder', team: 'home', pos: { x: 25, y: 34 }, attributes: { ...base, firstTouch: 12 } },
      { id: 'receiver', team: 'home', pos: { x: 68, y: 16 }, attributes: { ...base } },
    ],
    ball: { carrier: 'feeder' },
    script: [
      { atTick: 14, bodyId: 'receiver', command: { type: 'moveTo', target: { x: 50, y: 44 }, regime: 'run' } },
      { atTick: 42, bodyId: 'receiver', command: { type: 'chaseBall', regime: 'run' } },
    ],
    kicks: [
      { atTick: 24, bodyId: 'feeder', kick: { target: { x: 58, y: 32 }, speedMps: 13, loftDeg: 0 } },
    ],
  },
];
