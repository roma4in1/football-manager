/**
 * match11 — the 11v11 SITUATION harness (builder direction, Jul 24): the
 * scenario tier stops being artificial stages and becomes full-field
 * match slices — two brained XIs in a 4-4-2, keepers and all, with the
 * BALL PLACED IN CONTEXT (a wing duel, a central drive, a loose ball) so
 * the situation itself simulates the desired behavior. The physics/model
 * units stay as the math tier; these are the field tier.
 *
 * PILOT family: the duel/defense contexts — judged in the workbench
 * before the remaining scenario families are swept.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const out = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 13, firstTouch: 13, passing: 13, tackling: 13, strength: 13, stamina: 13 };
const gloves = { ...out, agility: 15, firstTouch: 14, pace: 12 };

/** 4-4-2 stations, home orientation (attacks +x); away mirrors in x. */
const F442: ReadonlyArray<{ slot: string; x: number; y: number }> = [
  { slot: 'gk', x: 5, y: 34 },
  { slot: 'lb', x: 18, y: 55 }, { slot: 'cb1', x: 16, y: 42 },
  { slot: 'cb2', x: 16, y: 26 }, { slot: 'rb', x: 18, y: 13 },
  { slot: 'lm', x: 40, y: 55 }, { slot: 'cm1', x: 38, y: 42 },
  { slot: 'cm2', x: 38, y: 26 }, { slot: 'rm', x: 40, y: 13 },
  { slot: 'st1', x: 58, y: 42 }, { slot: 'st2', x: 58, y: 26 },
];

export interface SituationDef {
  name: string;
  description: string;
  durationTicks: number;
  /** position overrides, by body id (h-slot / a-slot) */
  place?: Record<string, { x: number; y: number }>;
  /** ball: carried by this body id, or loose at a point */
  ball: { carrier: string } | { pos: { x: number; y: number } };
  homePressing?: number;
  awayPressing?: number;
}

export const matchSituation = (def: SituationDef): ScenarioDef => ({
  version: 1,
  name: def.name,
  description: def.description,
  durationTicks: def.durationTicks,
  bodies: F442.flatMap(({ slot, x, y }) => {
    const mk = (team: 'home' | 'away'): ScenarioDef['bodies'][number] => {
      const id = `${team === 'home' ? 'h' : 'a'}-${slot}`;
      const px = team === 'home' ? x : 105 - x;
      const p = def.place?.[id] ?? { x: px, y };
      const isGk = slot === 'gk';
      return {
        id,
        team,
        pos: p,
        facing: team === 'home' ? 0 : Math.PI,
        attributes: isGk ? gloves : out,
        ...(isGk ? { keeper: true as const } : { brain: 'onBall' as const }),
        instructions: {
          pressing: team === 'home' ? (def.homePressing ?? 0.5) : (def.awayPressing ?? 0.5),
          lineHeight: 0.5,
        },
      };
    };
    return [mk('home'), mk('away')];
  }),
  ball: def.ball,
  script: [],
});

/** the WING DUEL in match context: an away striker has broken onto the
 * home left flank and drives at the fullback — the covered-duel story
 * with the whole match around it (cover from the near CB, the line
 * shifting, the far side holding width). */
export const m11WingDuel = matchSituation({
  name: 'm11-wing-duel',
  description: '11v11: an away carrier drives the home left flank at the fullback. Judge the duel in match ecology — the ride, the near-side cover, the line shift, the far side holding.',
  durationTicks: 300,
  place: {
    'a-st1': { x: 34, y: 52 },
    'h-lb': { x: 26, y: 52 },
    'h-cb1': { x: 20, y: 44 },
    'a-cm1': { x: 44, y: 46 },
  },
  ball: { carrier: 'a-st1' },
  homePressing: 0.6,
});

/** the CENTRAL DRIVE in match context: an away midfielder carries at the
 * heart of the home block — the channel-duel story with a real line
 * behind and runners either side. */
export const m11CentralDrive = matchSituation({
  name: 'm11-central-drive',
  description: '11v11: an away carrier drives centrally at the home block. Judge the press election, the block compacting, the duty board around a real line.',
  durationTicks: 300,
  place: {
    'a-cm1': { x: 45, y: 36 },
    'a-st1': { x: 32, y: 42 },
    'a-st2': { x: 32, y: 28 },
    'h-cm1': { x: 38, y: 38 },
  },
  ball: { carrier: 'a-cm1' },
  homePressing: 0.6,
});

/** the LOOSE BALL in match context: a bouncing second ball in midfield —
 * arbitration, counterpress, and shape all live at once. */
export const m11SecondBall = matchSituation({
  name: 'm11-second-ball',
  description: '11v11: a loose second ball in central midfield. Judge who goes, who covers, and the shape holding around the scramble.',
  durationTicks: 300,
  ball: { pos: { x: 52, y: 34 } },
  homePressing: 0.6,
  awayPressing: 0.6,
});

export const match11Scenarios: ScenarioDef[] = [m11WingDuel, m11CentralDrive, m11SecondBall];
