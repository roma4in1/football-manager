/**
 * chase — attribute gaps expressed through physics (spec §5-L1).
 * Two body profiles race in two heats: over 70m the higher TOP SPEED wins;
 * over 8m the quicker ACCELERATION wins. The outcome is asserted — it must
 * follow from the force–velocity model, not from a scripted result.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const speedster = { pace: 18, acceleration: 10, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 };
const igniter = { pace: 12, acceleration: 18, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 };

const scenario: ScenarioDef = {
  version: 1,
  name: 'chase',
  description: 'Long heat (70m): pace-18 vs accel-18 — top speed wins. Short heat (8m): the igniter wins. Physics decides; the test asserts.',
  durationTicks: 160, // 16 s
  bodies: [
    { id: 'long-speedster', team: 'home', pos: { x: 15, y: 24 }, attributes: { ...speedster } },
    { id: 'long-igniter', team: 'away', pos: { x: 15, y: 30 }, attributes: { ...igniter } },
    { id: 'short-speedster', team: 'home', pos: { x: 30, y: 50 }, attributes: { ...speedster } },
    { id: 'short-igniter', team: 'away', pos: { x: 30, y: 56 }, attributes: { ...igniter } },
  ],
  script: [
    { atTick: 10, bodyId: 'long-speedster', command: { type: 'moveTo', target: { x: 85, y: 24 }, regime: 'sprint' } },
    { atTick: 10, bodyId: 'long-igniter', command: { type: 'moveTo', target: { x: 85, y: 30 }, regime: 'sprint' } },
    { atTick: 10, bodyId: 'short-speedster', command: { type: 'moveTo', target: { x: 38, y: 50 }, regime: 'sprint' } },
    { atTick: 10, bodyId: 'short-igniter', command: { type: 'moveTo', target: { x: 38, y: 56 }, regime: 'sprint' } },
  ],
};

export default scenario;
