/**
 * arrival — decelerate-to-arrive at run pace over three distances
 * (spec §5-L1). Judge: each run ends in a firm, planted stop AT the marker —
 * no overshoot, no orbiting, no asymptotic creep. The short run barely gets
 * going before braking; the long one holds cruise then brakes late.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const scenario: ScenarioDef = {
  version: 1,
  name: 'arrival',
  description: 'Runs of 10m / 30m / 60m at run regime, each ending in a stop at the target. Judge decelerate-to-arrive: no overshoot, no orbit.',
  durationTicks: 200, // 20 s
  bodies: [
    { id: 'short', team: 'home', pos: { x: 30, y: 20 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'medium', team: 'home', pos: { x: 25, y: 34 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    { id: 'long', team: 'home', pos: { x: 20, y: 48 }, attributes: { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
  ],
  script: [
    { atTick: 10, bodyId: 'short', command: { type: 'moveTo', target: { x: 40, y: 20 }, regime: 'run' } },
    { atTick: 10, bodyId: 'medium', command: { type: 'moveTo', target: { x: 55, y: 34 }, regime: 'run' } },
    { atTick: 10, bodyId: 'long', command: { type: 'moveTo', target: { x: 80, y: 48 }, regime: 'run' } },
  ],
};

export default scenario;
