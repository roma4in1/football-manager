/**
 * carry-turn — the dribble coupling under direction change. A sprint carrier
 * is re-targeted 90° mid-carry: his last touch keeps rolling the OLD way
 * while he carves, so the honest sequence is cut → chase your own touch →
 * collect → carry on. Close control loses little; the heavy-feet sibling's
 * chase is visibly longer. Possession is physics, not a flag.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const base = { pace: 15, acceleration: 14, agility: 13, balance: 13, firstTouch: 12, passing: 14, tackling: 12, strength: 12, stamina: 12 };

const scenario: ScenarioDef = {
  version: 1,
  name: 'carry-turn',
  description: 'Sprint-carry cut 90° at 6s: chase the running ball, collect, carry to the new target. Then the ball is fed to a heavy-feet runner who repeats it.',
  durationTicks: 400, // 40 s — two legs
  bodies: [
    { id: 'carrier', team: 'home', pos: { x: 15, y: 24 }, attributes: { ...base, dribbling: 18 } },
    { id: 'heavy', team: 'away', pos: { x: 15, y: 48 }, attributes: { ...base, dribbling: 6 } },
  ],
  ball: { carrier: 'carrier' },
  script: [
    { atTick: 10, bodyId: 'carrier', command: { type: 'moveTo', target: { x: 90, y: 24 }, regime: 'sprint' } },
    // the cut: the decision changed — first collect your own running touch
    { atTick: 60, bodyId: 'carrier', command: { type: 'chaseBall', regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'carrier', command: { type: 'moveTo', target: { x: 55, y: 60 }, regime: 'sprint' } },
    // leg 2: hand the ball to the heavy-feet runner, who repeats the drill
    { atTick: 210, bodyId: 'heavy', command: { type: 'chaseBall', regime: 'run' } },
    { afterPrevious: true, bodyId: 'heavy', command: { type: 'moveTo', target: { x: 90, y: 48 }, regime: 'sprint' } },
    { atTick: 300, bodyId: 'heavy', command: { type: 'chaseBall', regime: 'sprint' } },
    { afterPrevious: true, bodyId: 'heavy', command: { type: 'moveTo', target: { x: 50, y: 10 }, regime: 'sprint' } },
  ],
  kicks: [
    { atTick: 200, bodyId: 'carrier', kick: { target: { x: 25, y: 48 }, speedMps: 11, loftDeg: 0 } },
  ],
};

export default scenario;
