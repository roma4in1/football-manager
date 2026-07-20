/**
 * regimes — the same 70m route at walk / jog / run / sprint (spec §5-L1).
 * Judge: four visually distinct gaits, correctly speed-ordered, each holding
 * its own cruise speed — the effort-regime structure the later stamina model
 * will bill against.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const attrs = { pace: 14, acceleration: 14, agility: 13, stamina: 12 };

const scenario: ScenarioDef = {
  version: 1,
  name: 'regimes',
  description: 'Four identical bodies run 15m→85m at walk/jog/run/sprint. Distinct, ordered cruise speeds; arrivals in strict regime order.',
  durationTicks: 700, // 70 s — the walker needs ~47 s
  bodies: [
    { id: 'walk', team: 'home', pos: { x: 15, y: 14 }, attributes: { ...attrs } },
    { id: 'jog', team: 'home', pos: { x: 15, y: 28 }, attributes: { ...attrs } },
    { id: 'run', team: 'home', pos: { x: 15, y: 42 }, attributes: { ...attrs } },
    { id: 'sprint', team: 'home', pos: { x: 15, y: 56 }, attributes: { ...attrs } },
  ],
  script: [
    { atTick: 10, bodyId: 'walk', command: { type: 'moveTo', target: { x: 85, y: 14 }, regime: 'walk' } },
    { atTick: 10, bodyId: 'jog', command: { type: 'moveTo', target: { x: 85, y: 28 }, regime: 'jog' } },
    { atTick: 10, bodyId: 'run', command: { type: 'moveTo', target: { x: 85, y: 42 }, regime: 'run' } },
    { atTick: 10, bodyId: 'sprint', command: { type: 'moveTo', target: { x: 85, y: 56 }, regime: 'sprint' } },
  ],
};

export default scenario;
