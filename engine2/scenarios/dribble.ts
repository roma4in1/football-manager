/**
 * dribble-* — the carried ball, one drill per control × speed combination
 * (spec §5-L2 acceptance: "a carried ball looks dribbled"). One ball per sim
 * is the match contract, so the comparison is four sibling drills: the same
 * 60m route carried at jog vs sprint with close control (18) vs heavy feet
 * (6). Judge: touch cadence and length — the elite jogger's ball is glued,
 * the heavy-feet sprinter's touches run meters ahead and get chased down.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const base = { pace: 14, acceleration: 14, agility: 13, balance: 13, firstTouch: 12, passing: 14, tackling: 12, strength: 12, stamina: 12 };

const drill = (name: string, dribbling: number, regime: 'jog' | 'sprint'): ScenarioDef => ({
  version: 1,
  name,
  description: `60m carry at ${regime}, dribbling ${dribbling} — watch touch length and the chase between touches.`,
  durationTicks: 250, // 25 s
  bodies: [
    { id: 'carrier', team: 'home', pos: { x: 20, y: 34 }, attributes: { ...base, dribbling } },
  ],
  ball: { carrier: 'carrier' },
  script: [
    { atTick: 10, bodyId: 'carrier', command: { type: 'moveTo', target: { x: 80, y: 34 }, regime } },
  ],
});

export const dribbleScenarios: ScenarioDef[] = [
  drill('dribble-close-jog', 18, 'jog'),
  drill('dribble-close-sprint', 18, 'sprint'),
  drill('dribble-heavy-jog', 6, 'jog'),
  drill('dribble-heavy-sprint', 6, 'sprint'),
];
