/**
 * tackle-duel-* — L3 tackles as physical contests. A carrier shields the
 * ball at walking pace while a hunter closes and lunges (chaseBall intent →
 * tackle attempts, cooldown-paced). Two castings decide by attributes:
 * a strong ball-winner strips a light carrier; a strong, balanced carrier
 * holds off a weak tackler. Outcomes are keyed draws — deterministic per
 * seed, ordered across seeds.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const base = { pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 };

const duel = (name: string, carrier: Partial<typeof base>, tackler: Partial<typeof base>): ScenarioDef => ({
  version: 1,
  name,
  description: 'A standing carrier shields the glued ball; the hunter closes and lunges on a cooldown. Attributes alone decide the contest.',
  durationTicks: 300, // 30 s
  bodies: [
    { id: 'carrier', team: 'home', pos: { x: 40, y: 34 }, attributes: { ...base, ...carrier } },
    { id: 'hunter', team: 'away', pos: { x: 30, y: 34 }, attributes: { ...base, ...tackler } },
  ],
  ball: { carrier: 'carrier' },
  script: [
    // the carrier STANDS and shields (a glued ball cannot be pinched — the
    // tackle contest is the only way through); the hunter closes and lunges
    { atTick: 14, bodyId: 'hunter', command: { type: 'chaseBall', regime: 'run' } },
  ],
});

export const tackleScenarios: ScenarioDef[] = [
  duel('tackle-duel-strip', { dribbling: 8, balance: 8, strength: 8 }, { tackling: 17, strength: 16 }),
  duel('tackle-duel-hold', { dribbling: 17, balance: 16, strength: 16 }, { tackling: 7, strength: 8 }),
];
