/**
 * The lineup-as-pitch swap model (pure). A player is moved from wherever he
 * is onto a target location; occupants EXCHANGE places, so the XI always
 * stays 11 and the bench never exceeds its cap. Tactical config is NOT
 * touched here — it belongs to the slot index (inherit-on-swap happens in
 * inheritSlots when the parent remaps `starters[i]` onto slot i's config).
 */

import { LEAGUE_CFG } from '@fm/engine/config';
import type { Selection } from './build.ts';

export type Loc =
  | { kind: 'slot'; index: number } // pitch slot 0..10 (slot order = config order)
  | { kind: 'bench'; index: number } // bench position; >= bench.length is an empty spot
  | { kind: 'reserve'; playerId: string | null }; // squad rest; null = the open list area

export function locOf(sel: Selection, playerId: string): Loc {
  const s = sel.starters.indexOf(playerId);
  if (s >= 0) return { kind: 'slot', index: s };
  const b = sel.bench.indexOf(playerId);
  if (b >= 0) return { kind: 'bench', index: b };
  return { kind: 'reserve', playerId };
}

export function occupantOf(sel: Selection, loc: Loc): string | null {
  if (loc.kind === 'slot') return sel.starters[loc.index] ?? null;
  if (loc.kind === 'bench') return sel.bench[loc.index] ?? null;
  return loc.playerId;
}

/** Put `playerId` at `loc` (which must be occupied or an empty bench spot). */
const place = (sel: Selection, loc: Loc, playerId: string | null): Selection => {
  if (loc.kind === 'slot') {
    const starters = [...sel.starters];
    starters[loc.index] = playerId!; // slots are never vacated (moves that would are refused)
    return { ...sel, starters };
  }
  if (loc.kind === 'bench') {
    const bench = [...sel.bench];
    if (playerId === null) bench.splice(loc.index, 1);
    else if (loc.index < bench.length) bench[loc.index] = playerId;
    else bench.push(playerId);
    return { ...sel, bench };
  }
  return sel; // reserves are implicit (squad minus starters/bench)
};

/**
 * Move `playerId` onto `target`. Returns the new selection, or null when the
 * move is refused: vacating a pitch slot (the XI must stay 11), or growing
 * the bench past LEAGUE_CFG.benchMax.
 */
export function applyMove(sel: Selection, playerId: string, target: Loc): Selection | null {
  const source = locOf(sel, playerId);
  const outgoing = occupantOf(sel, target);
  if (outgoing === playerId) return null; // dropped on himself

  if (outgoing !== null) {
    // exchange: each takes the other's place
    return place(place(sel, target, playerId), source, outgoing);
  }

  // empty target (open bench spot or the reserve area): a plain move out
  if (source.kind === 'slot') return null; // would leave a hole in the XI
  if (target.kind === 'bench') {
    if (source.kind === 'bench') {
      const bench = sel.bench.filter((id) => id !== playerId);
      return { ...sel, bench: [...bench, playerId] }; // reorder to the end
    }
    if (sel.bench.length >= LEAGUE_CFG.benchMax) return null; // bench full
    return { ...sel, bench: [...sel.bench, playerId] };
  }
  // target reserve area: only meaningful from the bench (drop him from the squad list)
  if (source.kind === 'bench') return { ...sel, bench: sel.bench.filter((id) => id !== playerId) };
  return null; // reserve → reserve
}

/** data-loc wire format for drag hit-testing across HTML and SVG. */
export const locToData = (loc: Loc): string =>
  loc.kind === 'reserve' ? `reserve:${loc.playerId ?? ''}` : `${loc.kind}:${loc.index}`;

export function dataToLoc(data: string): Loc | null {
  const [kind, rest] = data.split(':');
  if (kind === 'slot' || kind === 'bench') {
    const index = Number(rest);
    return Number.isInteger(index) ? { kind, index } : null;
  }
  if (kind === 'reserve') return { kind, playerId: rest || null };
  return null;
}
