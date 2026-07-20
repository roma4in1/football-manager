/**
 * shuttle-runs — sprint pitch-length, stop, return (spec §5-L1 acceptance).
 * Judge: acceleration builds, top speed holds, braking is a firm plant (no
 * overshoot, no glide-through), the turn at each end is a stop-and-go.
 * One mid-attribute runner and one elite runner side by side — the attribute
 * gap must be visible lap over lap.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const scenario: ScenarioDef = {
  version: 1,
  name: 'shuttle-runs',
  description: 'Sprint 20m→85m and back, twice. Mid runner (12s) vs elite runner (18/16). Judge accel/decel honesty and the stop-turn at each end.',
  durationTicks: 600, // 60 s
  bodies: [
    { id: 'mid', team: 'home', pos: { x: 20, y: 28 }, attributes: { pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12, stamina: 12 } },
    { id: 'elite', team: 'away', pos: { x: 20, y: 40 }, attributes: { pace: 18, acceleration: 16, agility: 14, balance: 14, dribbling: 12, stamina: 14 } },
  ],
  script: [
    { atTick: 10, bodyId: 'mid', command: { type: 'moveTo', target: { x: 85, y: 28 }, regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'mid', command: { type: 'moveTo', target: { x: 20, y: 28 }, regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'mid', command: { type: 'moveTo', target: { x: 85, y: 28 }, regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'mid', command: { type: 'moveTo', target: { x: 20, y: 28 }, regime: 'sprint' } },
    { atTick: 10, bodyId: 'elite', command: { type: 'moveTo', target: { x: 85, y: 40 }, regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'elite', command: { type: 'moveTo', target: { x: 20, y: 40 }, regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'elite', command: { type: 'moveTo', target: { x: 85, y: 40 }, regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'elite', command: { type: 'moveTo', target: { x: 20, y: 40 }, regime: 'sprint' } },
  ],
};

export default scenario;
