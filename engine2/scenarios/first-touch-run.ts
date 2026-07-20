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
    description: 'The receiver charges INTO the drive — closing speeds add and even silk feet spill some. Judge the difference against run-with.',
    durationTicks: 120,
    bodies: [
      { id: 'feeder', team: 'home', pos: { x: 20, y: 34 }, attributes: { ...base, firstTouch: 12 } },
      { id: 'receiver', team: 'home', pos: { x: 80, y: 34 }, attributes: { ...base } },
    ],
    ball: { carrier: 'feeder' },
    script: [
      { atTick: 24, bodyId: 'receiver', command: { type: 'moveTo', target: { x: 30, y: 34 }, regime: 'run' } },
    ],
    kicks: [
      { atTick: 12, bodyId: 'feeder', kick: { target: { x: 65, y: 34 }, speedMps: 13, loftDeg: 0 } },
    ],
  },
];
