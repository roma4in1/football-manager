/**
 * first-touch-* — L3 acceptance (spec §5-L3): "a poor first touch under
 * pressure pops loose; a great one kills a driven ball dead." A feeder
 * drives 13 m/s balls at a receiver; a presser stands on the receiver's
 * shoulder in the pressured variants. Four combinations: silk/heavy ×
 * free/pressured — the pop rate must order accordingly (keyed draws:
 * deterministic per seed, honest across seeds).
 */
import type { ScenarioDef } from '../engine2-types.ts';

const feeder = { pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 19, tackling: 12, strength: 12, stamina: 12 };

const drill = (name: string, firstTouch: number, pressured: boolean): ScenarioDef => ({
  version: 1,
  name,
  description: `A 13 m/s drive at a receiver (firstTouch ${firstTouch})${pressured ? ' with a presser on his shoulder' : ''} — killed dead or popped loose?`,
  durationTicks: 130, // 13 s: feed, touch, aftermath
  bodies: [
    { id: 'feeder', team: 'home', pos: { x: 35, y: 34 }, attributes: { ...feeder } },
    { id: 'receiver', team: 'home', pos: { x: 55, y: 34 }, attributes: { ...feeder, passing: 12, firstTouch } },
    ...(pressured
      ? [{ id: 'presser', team: 'away' as const, pos: { x: 56.5, y: 35.2 }, attributes: { ...feeder, passing: 12 } }]
      : []),
  ],
  ball: { carrier: 'feeder' },
  script: [],
  kicks: [
    { atTick: 10, bodyId: 'feeder', kick: { target: { x: 55, y: 34 }, speedMps: 13, loftDeg: 0 } },
  ],
});

export const firstTouchScenarios: ScenarioDef[] = [
  drill('first-touch-silk', 18, false),
  drill('first-touch-silk-pressed', 18, true),
  drill('first-touch-heavy', 5, false),
  drill('first-touch-heavy-pressed', 5, true),
];
