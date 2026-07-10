/**
 * Selection → Tactics assembly. Anchors come from the shared 4-4-2 slot
 * template (league-eligibility.formationSlots) assigned by position group —
 * the v0 stand-in for the two-anchor pitch input (DECISIONS.md).
 */

import type { PlayerInstructions, PlayerTactic, Tactics, TeamInstructions } from '@fm/engine/types';
import {
  formationSlots,
  groupOf,
  instructionsFor,
  validateTactics,
  type EligiblePlayer,
  type EligibilityIssue,
  type LineupSlot,
} from '@fm/engine/eligibility';
import type { SquadPlayerView } from '../api.ts';

export interface Selection {
  starters: string[];
  bench: string[];
}

export const toEligible = (squad: SquadPlayerView[]): EligiblePlayer[] =>
  squad.map((p) => ({
    playerId: p.playerId,
    position: p.position,
    attributes: p.attributes,
    injuryWeeksLeft: p.injuryWeeksLeft,
    suspendedNext: p.suspendedNext,
  }));

/** Starters → slots, natural position group first, leftovers fill whatever remains. */
export function assignSlots(starters: SquadPlayerView[]): Map<string, LineupSlot> {
  const free = formationSlots();
  const out = new Map<string, LineupSlot>();
  for (const p of starters) {
    const i = free.findIndex((s) => s.group === groupOf(p.position));
    if (i >= 0) out.set(p.playerId, free.splice(i, 1)[0]);
  }
  for (const p of starters) {
    if (!out.has(p.playerId)) {
      const slot = free.shift();
      if (slot) out.set(p.playerId, slot);
    }
  }
  return out;
}

export const defaultTeamInstructions: TeamInstructions = {
  lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5,
};

export function buildTactics(
  selection: Selection,
  squad: SquadPlayerView[],
  playerInstructions: Record<string, PlayerInstructions>,
  team: TeamInstructions,
): Tactics {
  const byId = new Map(squad.map((p) => [p.playerId, p]));
  const starters = selection.starters.map((id) => byId.get(id)).filter((p): p is SquadPlayerView => !!p);
  const slots = assignSlots(starters);
  const fallback = formationSlots()[5]; // MF slot; only reached while the selection is still invalid

  const best = (f: (p: SquadPlayerView) => number): string =>
    (starters.length ? starters.reduce((m, p) => (f(p) > f(m) ? p : m)) : { playerId: '' }).playerId;

  return {
    players: starters.map((p) => {
      const slot = slots.get(p.playerId) ?? fallback;
      return {
        playerId: p.playerId,
        anchors: slot.anchors,
        instructions: playerInstructions[p.playerId] ?? instructionsFor(slot.group),
        zones: {},
      };
    }),
    team,
    bench: selection.bench,
    setPieceTakers: {
      corners: best((p) => p.attributes.setPieceDelivery),
      freeKicks: best((p) => p.attributes.setPieceDelivery),
      penalties: best((p) => p.attributes.finishing),
    },
  };
}

/**
 * Inherit-on-swap: the tactical config (phase anchors, sliders, zones)
 * belongs to slot i — remapping the starters onto the slots changes only the
 * playerIds. A slot beyond the configured list (squad smaller than a full
 * plan) synthesizes a default from the shared template.
 */
export function inheritSlots(
  slots: PlayerTactic[],
  starters: string[],
  squad: SquadPlayerView[],
  team: TeamInstructions,
): PlayerTactic[] {
  return starters.map((id, i) => {
    const slotConfig = slots[i] ?? buildTactics({ starters: [id], bench: [] }, squad, {}, team).players[0];
    return { ...slotConfig, playerId: id };
  });
}

/** The client-side mirror: same pure validator the server runs. */
export function issuesFor(selection: Selection, squad: SquadPlayerView[]): EligibilityIssue[] {
  return validateTactics(buildTactics(selection, squad, {}, defaultTeamInstructions), toEligible(squad));
}
