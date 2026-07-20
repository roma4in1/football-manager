/**
 * curved-run — a sprinting player re-targeted mid-run (spec §5-L1).
 * Judge: momentum. The 90° re-target must carve an arc whose radius visibly
 * grows with speed; the 180° re-target must brake, turn tight, re-launch.
 * Never a pivot-teleport.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const scenario: ScenarioDef = {
  version: 1,
  name: 'curved-run',
  description: 'Both sprint +x from 3s in; at 6s "ninety" is re-targeted 90° down, "reverse" 180° back. Watch the arc vs the brake-turn-relaunch.',
  durationTicks: 220, // 22 s
  bodies: [
    { id: 'ninety', team: 'home', pos: { x: 15, y: 24 }, attributes: { pace: 15, acceleration: 14, agility: 12, balance: 12, dribbling: 12, stamina: 12 } },
    { id: 'reverse', team: 'away', pos: { x: 15, y: 46 }, attributes: { pace: 15, acceleration: 14, agility: 12, balance: 12, dribbling: 12, stamina: 12 } },
  ],
  script: [
    { atTick: 30, bodyId: 'ninety', command: { type: 'moveTo', target: { x: 95, y: 24 }, regime: 'sprint' } },
    { atTick: 60, bodyId: 'ninety', command: { type: 'moveTo', target: { x: 52, y: 62 }, regime: 'sprint' } },
    { atTick: 30, bodyId: 'reverse', command: { type: 'moveTo', target: { x: 95, y: 46 }, regime: 'sprint' } },
    { atTick: 60, bodyId: 'reverse', command: { type: 'moveTo', target: { x: 15, y: 46 }, regime: 'sprint' } },
  ],
};

export default scenario;
