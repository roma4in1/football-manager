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
import { PITCH, type ScenarioDef } from '../engine2-types.ts';

const out = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 13, firstTouch: 13, passing: 13, tackling: 13, strength: 13, stamina: 13 };
const gloves = { ...out, agility: 15, firstTouch: 14, pace: 12 };

/** formation tables, home orientation (attacks +x); away mirrors in x.
 * The engine is formation-agnostic — homes drive the stations, the duty
 * zones, and the back-line detection (deepest outfield home +6 m), so a
 * back FIVE and a front THREE need no new machinery, only a table. */
const F442: ReadonlyArray<{ slot: string; x: number; y: number; instr?: Record<string, unknown> }> = [
  { slot: 'gk', x: 5, y: 34 },
  { slot: 'lb', x: 18, y: 55 }, { slot: 'cb1', x: 16, y: 42 },
  { slot: 'cb2', x: 16, y: 26 }, { slot: 'rb', x: 18, y: 13 },
  { slot: 'lm', x: 40, y: 55, instr: { holdWidth: true } }, { slot: 'cm1', x: 38, y: 42 },
  { slot: 'cm2', x: 38, y: 26 }, { slot: 'rm', x: 40, y: 13, instr: { holdWidth: true } },
  { slot: 'st1', x: 58, y: 42 }, { slot: 'st2', x: 58, y: 26 },
];

/** 4-3-3: a holding mid behind two eights, wingers high and wide */
const F433: ReadonlyArray<{ slot: string; x: number; y: number; instr?: Record<string, unknown> }> = [
  { slot: 'gk', x: 5, y: 34 },
  { slot: 'lb', x: 18, y: 55 }, { slot: 'cb1', x: 16, y: 42 },
  { slot: 'cb2', x: 16, y: 26 }, { slot: 'rb', x: 18, y: 13 },
  { slot: 'dm', x: 31, y: 34 },
  { slot: 'cm1', x: 40, y: 45 }, { slot: 'cm2', x: 40, y: 23 },
  { slot: 'lw', x: 56, y: 55, instr: { holdWidth: true } }, { slot: 'st', x: 58, y: 34 },
  { slot: 'rw', x: 56, y: 13, instr: { holdWidth: true } },
];

/** 5-2-3: a back five with wingbacks, a double pivot, a front three */
/** the MANAGER-PLACEMENT proof preset: a 4-2-3-1 whose key players are
 * placed ANYWHERE per phase — a false nine dropping into midfield in
 * build-up, an attacking mid surging to the box edge in the final
 * third, a left back bombing high when pressing and pinning deep in the
 * low block. Not derivable from any rigid formation band: the point. */
const F4231X: ReadonlyArray<{ slot: string; x: number; y: number; instr?: Record<string, unknown>; phases?: Record<string, { x: number; y: number }> }> = [
  { slot: 'gk', x: 5, y: 34 },
  { slot: 'lb', x: 18, y: 55, phases: { high: { x: 60, y: 60 }, low: { x: 12, y: 53 } } },
  { slot: 'cb1', x: 16, y: 42 }, { slot: 'cb2', x: 16, y: 26 },
  { slot: 'rb', x: 18, y: 13 },
  { slot: 'dm1', x: 32, y: 40 }, { slot: 'dm2', x: 32, y: 28 },
  { slot: 'lw', x: 52, y: 55, instr: { holdWidth: true } },
  { slot: 'am', x: 46, y: 34, phases: { final: { x: 75, y: 34 } } },
  { slot: 'rw', x: 52, y: 13, instr: { holdWidth: true } },
  { slot: 'st', x: 58, y: 34, phases: { build: { x: 40, y: 34 }, final: { x: 88, y: 34 } } },
];

const F523: ReadonlyArray<{ slot: string; x: number; y: number; instr?: Record<string, unknown> }> = [
  { slot: 'gk', x: 5, y: 34 },
  { slot: 'lwb', x: 20, y: 58, instr: { joinAttack: 0.8, holdWidth: true } }, { slot: 'cb1', x: 15, y: 46 },
  { slot: 'cb2', x: 14, y: 34 }, { slot: 'cb3', x: 15, y: 22 },
  { slot: 'rwb', x: 20, y: 10, instr: { joinAttack: 0.8, holdWidth: true } },
  { slot: 'cm1', x: 36, y: 42 }, { slot: 'cm2', x: 36, y: 26 },
  { slot: 'lw', x: 54, y: 52, instr: { holdWidth: true } }, { slot: 'st', x: 56, y: 34 },
  { slot: 'rw', x: 54, y: 16, instr: { holdWidth: true } },
];

export const FORMATIONS: Readonly<Record<string, ReadonlyArray<{ slot: string; x: number; y: number; instr?: Record<string, unknown>; phases?: Record<string, { x: number; y: number }> }>>> = {
  '442': F442, '433': F433, '523': F523, '4231x': F4231X,
};

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
  /** formation table names (FORMATIONS keys), default '442' */
  homeFormation?: string;
  awayFormation?: string;
  /** team-wide instruction overrides (merged onto every outfielder) —
   * the manager's tactical identity for the showcase/monitor */
  homeInstr?: Record<string, unknown>;
  awayInstr?: Record<string, unknown>;
  /** team tactical attribute (how faithfully they execute the instr) */
  homeTactical?: number;
  awayTactical?: number;
}

export const matchSituation = (def: SituationDef): ScenarioDef => ({
  version: 1,
  name: def.name,
  description: def.description,
  durationTicks: def.durationTicks,
  bodies: (['home', 'away'] as const).flatMap((team) =>
    (FORMATIONS[(team === 'home' ? def.homeFormation : def.awayFormation) ?? '442'] ?? F442).map(({ slot, x, y, instr, phases }) => {
      const id = `${team === 'home' ? 'h' : 'a'}-${slot}`;
      const px = team === 'home' ? x : 105 - x;
      const p = def.place?.[id] ?? { x: px, y };
      const isGk = slot === 'gk';
      // manager phase placements mirror with the team like everything else
      const ph = phases
        ? Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, { x: team === 'home' ? v.x : PITCH.length - v.x, y: v.y }]))
        : undefined;
      return {
        id,
        team,
        pos: p,
        facing: team === 'home' ? 0 : Math.PI,
        attributes: {
          ...(isGk ? gloves : out),
          tactical: team === 'home' ? (def.homeTactical ?? 11) : (def.awayTactical ?? 11),
        },
        ...(isGk ? { keeper: true as const } : { brain: 'onBall' as const }),
        ...(ph ? { phaseHomes: ph } : {}),
        instructions: {
          pressing: team === 'home' ? (def.homePressing ?? 0.5) : (def.awayPressing ?? 0.5),
          lineHeight: 0.5,
          ...((team === 'home' ? def.homeInstr : def.awayInstr) ?? {}),
          ...(instr ?? {}),
        },
      };
    })),
  ball: def.ball,
  script: [],
  // full-match slices get the real match shape: opening kickoff,
  // half-time, second-half handover
  halves: 'pos' in def.ball && def.durationTicks >= 600 ? true : undefined,
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
/** THE SCREEN, made VISIBLE (builder: 'you should be able to SEE a
 * player holding that pocket before the ball arrives, at slow-mo'): an
 * away side works the ball on the edge of the home box with a receiver
 * loitering in the top-of-box POCKET. Watch h-cm2 (or the spare) drop
 * to screen that pocket goal-side of the lurker BEFORE the ball is
 * played to him — the off-ball defending behavior, legible. */
export const m11Screen = matchSituation({
  name: 'm11-screen',
  description: 'The off-ball SCREEN, made visible: an away attack on the edge of the home box with a receiver in the top-of-box pocket. Watch a home midfielder hold that pocket goal-side of the lurker before the ball arrives — proactive screening, not a reactive chase. Judge at 0.25x with overlays on.',
  durationTicks: 300,
  place: {
    // away attacks toward x=0 (home's goal); the pocket is the top of
    // home's box at x~16, the lurker just inside it
    'a-cm1': { x: 31, y: 40 },   // the carrier, edge of box wide
    'a-st1': { x: 17, y: 34 },   // the pocket lurker (top of home box, central)
    'a-st2': { x: 13, y: 44 },   // a second box runner
    'a-cm2': { x: 39, y: 28 },
    'h-cm1': { x: 24, y: 40 },
    'h-cm2': { x: 26, y: 30 },   // the screener candidate
  },
  ball: { carrier: 'a-cm1' },
  homePressing: 0.6,
});

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

/** the full MATCH for self-play: kickoff-ish neutral ball at the centre,
 * restarts keep it flowing — the memory space's stage. */
export const m11Match = matchSituation({
  name: 'm11-match',
  description: 'A full 11v11 match slice from a neutral centre ball — restarts keep play flowing. The self-play harness stage; also the workbench\'s longest look at everything at once.',
  durationTicks: 2700,
  ball: { pos: { x: 52.5, y: 34 } },
  homePressing: 0.6,
  awayPressing: 0.6,
});

/** the FORMATION DUEL (builder request): a 4-3-3 against a 5-2-3 — the
 * fluid front three vs the back five, wingbacks against high wingers,
 * a double pivot against a midfield triangle. Same neutral centre ball
 * as m11-match; the formations are the experiment. */
export const m11Formations = matchSituation({
  name: 'm11-433-523',
  description: 'A full 11v11 slice: home 4-3-3 vs away 5-2-3 from a neutral centre ball. Judge the front three against the back five, the wingbacks\' dual role, and the pivot battle.',
  durationTicks: 2700,
  ball: { pos: { x: 52.5, y: 34 } },
  homePressing: 0.6,
  awayPressing: 0.6,
  homeFormation: '433',
  awayFormation: '523',
});

/** the MANAGER-PLACEMENT proof match: the phase-authored 4-2-3-1x
 * against a stock 4-4-2 — the pin asserts players FOLLOW the authored
 * placements phase by phase */
export const m11Placement = matchSituation({
  name: 'm11-4231x-442',
  description: 'The manager-placement proof: home plays a 4-2-3-1 with per-phase authored positions (false nine drops in build, AM surges in the final third, LB bombs in the high press). Judge whether players follow the manager, not the formation.',
  durationTicks: 2700,
  ball: { pos: { x: 52.5, y: 34 } },
  homePressing: 0.6,
  awayPressing: 0.6,
  homeFormation: '4231x',
  awayFormation: '442',
});

/** THE TACTICAL SHOWCASE (builder monitor): two opposed identities so
 * the sliders are VISIBLE. Home = a high-pressing, high-line,
 * central-penetration, gegenpressing side of DISCIPLINED players
 * (tactical 17) — they execute the plan. Away = a deep, compact,
 * counter-attacking, wide side of LESS disciplined players (tactical 8)
 * — the same instructions, looser execution. Watch the two shapes
 * diverge, and run the monitor on it to read every system at once. */
export const m11Showcase = matchSituation({
  name: 'm11-showcase',
  description: 'Tactical showcase: home high-press/high-line/central/gegenpress (disciplined, tactical 17) vs away deep-block/compact/counter/wide (looser, tactical 8). Watch the sliders express — run monitor.ts on it for the full dashboard.',
  durationTicks: 2700,
  ball: { pos: { x: 52.5, y: 34 } },
  homePressing: 0.7,
  awayPressing: 0.2,
  homeInstr: { lineHeight: 0.78, compactness: 0.4, counterpress: 0.7, passChannel: 0.75, tempo: 0.7, risk: 0.6, shootOnSight: 0.6 },
  awayInstr: { lineHeight: 0.2, compactness: 0.85, counterpress: 0.2, passChannel: 0.3, tempo: 0.35, risk: 0.35, holdWidth: true },
  homeTactical: 17,
  awayTactical: 8,
});

export const match11Scenarios: ScenarioDef[] = [m11WingDuel, m11CentralDrive, m11SecondBall, m11Match, m11Formations, m11Placement, m11Showcase, m11Screen];
