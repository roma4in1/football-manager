/**
 * league-eligibility.ts — tactics validation + deterministic best-XI fallback.
 *
 * Shared by two callers with different failure modes:
 *  - notifyTacticsSubmitted: invalid fresh submission → TacticsRejectedError
 *    (typed, carries the issue list; the submission row is removed).
 *  - the default/deadline path at sim time: invalid or missing default tactics
 *    → bestXI() fallback, never a rejection — the league must not block.
 *
 * Pure module: callers load squad state (league-store) and pass plain data, so
 * unit tests need no database.
 *
 * bestXI selection order per slot group (GK, then 4-4-2 outfield): availability
 * tier first (fit → injured by fewest weeks → suspended), natural position
 * within tier, then attribute composite. Injured/suspended players are only
 * drafted when fewer than 11 fit players exist — the match must still be
 * simmed. All tiebreaks carry a seeded micro-jitter from the fixture seed, so
 * the lineup is deterministic per fixture.
 */

import { Rng } from './engine-rng.ts';
import type { Attributes, Phase, PlayerInstructions, Tactics, Vec2 } from './engine-types.ts';
import { LEAGUE_CFG } from './league-config.ts';

export interface EligiblePlayer {
  playerId: string;
  position: string; // players.position — coarse GK/DF/MF/FW + subtype
  attributes: Attributes;
  injuryWeeksLeft: number;
  suspendedNext: boolean;
}

export type EligibilityIssue =
  | { code: 'wrong_starter_count'; found: number }
  | { code: 'bench_too_large'; found: number }
  | { code: 'duplicate_player'; playerId: string }
  | { code: 'not_in_squad'; playerId: string }
  | { code: 'player_unavailable'; playerId: string; reason: 'injured' | 'suspended' }
  | { code: 'no_goalkeeper' };

export class TacticsRejectedError extends Error {
  readonly issues: EligibilityIssue[];
  constructor(clubId: string, issues: EligibilityIssue[]) {
    super(`tactics rejected for club ${clubId}: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'TacticsRejectedError';
    this.issues = issues;
  }
}

export type Group = 'GK' | 'DF' | 'MF' | 'FW';

export const groupOf = (position: string): Group => {
  const p = position.toUpperCase();
  if (p.startsWith('GK')) return 'GK';
  if (p.startsWith('DF') || p.startsWith('D')) return 'DF';
  if (p.startsWith('FW') || p.startsWith('F') || p.startsWith('ST')) return 'FW';
  return 'MF';
};

export function validateTactics(tactics: Tactics, squad: EligiblePlayer[]): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];
  const byId = new Map(squad.map((p) => [p.playerId, p]));
  const starterIds = tactics.players.map((p) => p.playerId);
  const allIds = [...starterIds, ...tactics.bench];

  if (starterIds.length !== LEAGUE_CFG.startersRequired) {
    issues.push({ code: 'wrong_starter_count', found: starterIds.length });
  }
  if (tactics.bench.length > LEAGUE_CFG.benchMax) {
    issues.push({ code: 'bench_too_large', found: tactics.bench.length });
  }

  const seen = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) issues.push({ code: 'duplicate_player', playerId: id });
    seen.add(id);
    const p = byId.get(id);
    if (!p) {
      issues.push({ code: 'not_in_squad', playerId: id });
      continue;
    }
    if (p.injuryWeeksLeft > 0) issues.push({ code: 'player_unavailable', playerId: id, reason: 'injured' });
    else if (p.suspendedNext) issues.push({ code: 'player_unavailable', playerId: id, reason: 'suspended' });
  }

  if (!starterIds.some((id) => byId.has(id) && groupOf(byId.get(id)!.position) === 'GK')) {
    issues.push({ code: 'no_goalkeeper' });
  }
  return issues;
}

// ── half-time resubmission rules ─────────────────────────────────────────────

export type HtIssue =
  | { code: 'too_many_subs'; swaps: number; max: number }
  | { code: 'reentry'; playerId: string } // substituted off earlier — cannot return
  | { code: 'sent_off_player'; playerId: string };

/**
 * Server-side HT enforcement (league-api PUT tactics/2):
 *  - at most `subsMax` players of the half-2 XI may differ from the half-1 XI;
 *  - a player removed by a PREVIOUS half-2 submission never re-enters
 *    (substituted players stay off, even across resubmissions);
 *  - players sent off in half 1 (end_state cards) are ineligible.
 * Pure — the client mirrors it.
 */
export function validateHtResubmission(
  h2Tactics: Tactics,
  h1StarterIds: string[],
  previousH2StarterIds: string[] | null,
  sentOffIds: string[],
  subsMax: number,
): HtIssue[] {
  const issues: HtIssue[] = [];
  const h2 = new Set(h2Tactics.players.map((p) => p.playerId));
  const h1 = new Set(h1StarterIds);

  const swaps = h1StarterIds.filter((id) => !h2.has(id)).length;
  if (swaps > subsMax) issues.push({ code: 'too_many_subs', swaps, max: subsMax });

  if (previousH2StarterIds) {
    const prev = new Set(previousH2StarterIds);
    for (const id of h1StarterIds) {
      if (!prev.has(id) && h2.has(id)) issues.push({ code: 'reentry', playerId: id });
    }
  }

  for (const id of sentOffIds) {
    if (h2.has(id) || (!h1.has(id) && h2Tactics.bench.includes(id))) {
      issues.push({ code: 'sent_off_player', playerId: id });
    }
  }
  return issues;
}

// ── best XI (4-4-2) ──────────────────────────────────────────────────────────

// longPassing weighs into DF and MF composites (CB switches, deep-lying passers);
// there is no DM subtype in the coarse groups, so it is folded into both — DECISIONS.md
const SCORES: Record<Group, (a: Attributes) => number> = {
  GK: (a) => a.gkReflexes * 0.4 + a.gkPositioning * 0.35 + a.gkDistribution * 0.25,
  DF: (a) => a.tackling * 0.25 + a.marking * 0.25 + a.positioning * 0.2 + (a.longPassing ?? a.passing) * 0.1 + a.strength * 0.1 + a.heading * 0.1,
  MF: (a) => a.passing * 0.3 + a.vision * 0.2 + a.decisions * 0.2 + a.stamina * 0.15 + a.firstTouch * 0.1 + (a.longPassing ?? a.passing) * 0.05,
  FW: (a) => a.finishing * 0.3 + a.offTheBall * 0.25 + a.pace * 0.2 + a.dribbling * 0.15 + a.composure * 0.1,
};

interface Slot { group: Group; def: Vec2; att: Vec2 }

const FORMATION_442: Slot[] = [
  { group: 'GK', def: { x: 6, y: 34 }, att: { x: 13, y: 34 } },
  { group: 'DF', def: { x: 16, y: 14 }, att: { x: 45, y: 12 } },
  { group: 'DF', def: { x: 16, y: 27 }, att: { x: 40, y: 26 } },
  { group: 'DF', def: { x: 16, y: 41 }, att: { x: 40, y: 42 } },
  { group: 'DF', def: { x: 16, y: 54 }, att: { x: 45, y: 56 } },
  { group: 'MF', def: { x: 34, y: 12 }, att: { x: 72, y: 12 } },
  { group: 'MF', def: { x: 32, y: 27 }, att: { x: 62, y: 28 } },
  { group: 'MF', def: { x: 32, y: 41 }, att: { x: 62, y: 40 } },
  { group: 'MF', def: { x: 34, y: 56 }, att: { x: 72, y: 56 } },
  { group: 'FW', def: { x: 46, y: 28 }, att: { x: 88, y: 28 } },
  { group: 'FW', def: { x: 46, y: 40 }, att: { x: 88, y: 40 } },
];

const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05, buildUp: 0.3, counterPress: 0.55,
  progression: 0.6, counterAttack: 0.85, finalThird: 1.0,
};

const slotAnchors = (slot: Slot): Record<Phase, Vec2> => {
  const anchors = {} as Record<Phase, Vec2>;
  for (const [phase, t] of Object.entries(PHASE_BLEND) as Array<[Phase, number]>) {
    anchors[phase] = {
      x: slot.def.x + (slot.att.x - slot.def.x) * t,
      y: slot.def.y + (slot.att.y - slot.def.y) * t,
    };
  }
  return anchors;
};

export interface LineupSlot {
  group: Group;
  anchors: Record<Phase, Vec2>;
}

/**
 * The 4-4-2 slot template with phase-blended anchors. This is the v0 client's
 * position→coordinates map too (two-anchor input deferred — DECISIONS.md):
 * the lineup screen assigns its starters to these slots by position group.
 */
export function formationSlots(): LineupSlot[] {
  return FORMATION_442.map((slot) => ({ group: slot.group, anchors: slotAnchors(slot) }));
}

/** Default per-slot instruction values — shared by bestXI and the client lineup UI. */
export function instructionsFor(group: Group): PlayerInstructions {
  return { ...INSTRUCTIONS[group] };
}

const INSTRUCTIONS: Record<Group, PlayerInstructions> = {
  GK: { riskAppetite: 0.3, shootingBias: 0.05, dribbleBias: 0.1, pressingIntensity: 0.2, holdPosition: 0.95, crossBias: 0.1 },
  DF: { riskAppetite: 0.35, shootingBias: 0.15, dribbleBias: 0.3, pressingIntensity: 0.45, holdPosition: 0.75, crossBias: 0.4 },
  MF: { riskAppetite: 0.5, shootingBias: 0.4, dribbleBias: 0.4, pressingIntensity: 0.5, holdPosition: 0.5, crossBias: 0.4 },
  FW: { riskAppetite: 0.55, shootingBias: 0.65, dribbleBias: 0.5, pressingIntensity: 0.55, holdPosition: 0.4, crossBias: 0.45 },
};

/** 0 = fit, 1 = injured (ranked by fewest weeks), 2 = suspended. */
const tier = (p: EligiblePlayer): number =>
  p.injuryWeeksLeft > 0 ? 1 : p.suspendedNext ? 2 : 0;

export function bestXI(squad: EligiblePlayer[], fixtureSeed: string): Tactics {
  const jitter = new Map(squad.map((p) => [p.playerId, Rng.fromSeed(`${fixtureSeed}|xi|${p.playerId}`).float() * 1e-6]));
  const rankFor = (group: Group) => (a: EligiblePlayer, b: EligiblePlayer): number =>
    tier(a) - tier(b) ||
    Number(groupOf(b.position) === group) - Number(groupOf(a.position) === group) ||
    a.injuryWeeksLeft - b.injuryWeeksLeft ||
    (SCORES[group](b.attributes) + jitter.get(b.playerId)!) - (SCORES[group](a.attributes) + jitter.get(a.playerId)!);

  const pool = [...squad];
  const starters: Array<{ player: EligiblePlayer; slot: Slot }> = [];
  for (const group of ['GK', 'DF', 'MF', 'FW'] as const) {
    const slots = FORMATION_442.filter((s) => s.group === group);
    pool.sort(rankFor(group));
    for (const slot of slots) {
      const player = pool.shift();
      if (!player) break; // squad smaller than 11 — field what exists
      starters.push({ player, slot });
    }
  }

  // bench: remaining FIT players only, best general score first (an unavailable
  // bench player would make the generated tactics fail validation)
  const overall = (p: EligiblePlayer): number => SCORES[groupOf(p.position)](p.attributes) + jitter.get(p.playerId)!;
  const bench = pool
    .filter((p) => tier(p) === 0)
    .sort((a, b) => overall(b) - overall(a))
    .slice(0, LEAGUE_CFG.benchMax)
    .map((p) => p.playerId);

  const best = (f: (a: Attributes) => number): string =>
    starters.reduce((m, s) => (f(s.player.attributes) + jitter.get(s.player.playerId)! >
      f(m.player.attributes) + jitter.get(m.player.playerId)! ? s : m)).player.playerId;

  return {
    players: starters.map(({ player, slot }) => (
      { playerId: player.playerId, anchors: slotAnchors(slot), instructions: { ...INSTRUCTIONS[slot.group] }, zones: {} }
    )),
    team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
    bench,
    setPieceTakers: {
      corners: best((a) => a.setPieceDelivery),
      freeKicks: best((a) => a.setPieceDelivery),
      penalties: best((a) => a.finishing),
    },
  };
}
