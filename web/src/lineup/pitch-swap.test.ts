/**
 * The lineup-as-pitch swap model: exchange semantics (XI always stays 11,
 * bench never over cap) + inherit-on-swap (config belongs to the slot).
 */

import { describe, expect, test } from 'vitest';
import type { Attributes } from '@fm/engine/types';
import type { SquadPlayerView } from '../api.ts';
import { buildTactics, defaultTeamInstructions, inheritSlots, type Selection } from './build.ts';
import { applyMove, dataToLoc, locToData } from './pitch-swap.ts';

const sel = (): Selection => ({
  starters: Array.from({ length: 11 }, (_, i) => `s${i}`),
  bench: ['b0', 'b1', 'b2'],
});

describe('applyMove', () => {
  test('bench → slot: they exchange places (the outgoing starter takes the bench spot)', () => {
    const next = applyMove(sel(), 'b0', { kind: 'slot', index: 3 })!;
    expect(next.starters[3]).toBe('b0');
    expect(next.bench).toEqual(['s3', 'b1', 'b2']);
    expect(next.starters).toHaveLength(11);
  });

  test('slot → slot: the two starters swap slots', () => {
    const next = applyMove(sel(), 's2', { kind: 'slot', index: 5 })!;
    expect(next.starters[5]).toBe('s2');
    expect(next.starters[2]).toBe('s5');
  });

  test('reserve → slot: pure exchange — the outgoing starter goes to reserves, bench untouched', () => {
    const next = applyMove(sel(), 'r0', { kind: 'slot', index: 0 })!;
    expect(next.starters[0]).toBe('r0');
    expect(next.starters).not.toContain('s0');
    expect(next.bench).toEqual(['b0', 'b1', 'b2']);
  });

  test('reserve → occupied bench spot: exchange', () => {
    const next = applyMove(sel(), 'r0', { kind: 'bench', index: 1 })!;
    expect(next.bench).toEqual(['b0', 'r0', 'b2']);
  });

  test('reserve → empty bench spot: appended, refused once the bench is full', () => {
    const grown = applyMove(sel(), 'r0', { kind: 'bench', index: 7 })!;
    expect(grown.bench).toEqual(['b0', 'b1', 'b2', 'r0']);

    const full = { starters: sel().starters, bench: Array.from({ length: 9 }, (_, i) => `b${i}`) };
    expect(applyMove(full, 'r9', { kind: 'bench', index: 9 })).toBeNull();
  });

  test('bench → reserve area: dropped from the matchday squad', () => {
    const next = applyMove(sel(), 'b1', { kind: 'reserve', playerId: null })!;
    expect(next.bench).toEqual(['b0', 'b2']);
  });

  test('a starter can never vacate the XI: empty bench spot and reserve area are refused', () => {
    expect(applyMove(sel(), 's4', { kind: 'bench', index: 5 })).toBeNull();
    expect(applyMove(sel(), 's4', { kind: 'reserve', playerId: null })).toBeNull();
  });

  test('bench → reserve player: exchange', () => {
    const next = applyMove(sel(), 'b2', { kind: 'reserve', playerId: 'r1' })!;
    expect(next.bench).toEqual(['b0', 'b1', 'r1']);
  });

  test('dropping a player on himself is a no-op', () => {
    expect(applyMove(sel(), 's3', { kind: 'slot', index: 3 })).toBeNull();
    expect(applyMove(sel(), 'b0', { kind: 'bench', index: 0 })).toBeNull();
  });
});

test('data-loc wire format round-trips', () => {
  for (const loc of [
    { kind: 'slot', index: 7 } as const,
    { kind: 'bench', index: 0 } as const,
    { kind: 'reserve', playerId: 'p9' } as const,
    { kind: 'reserve', playerId: null } as const,
  ]) {
    expect(dataToLoc(locToData(loc))).toEqual(loc);
  }
  expect(dataToLoc('nonsense')).toBeNull();
  expect(dataToLoc('slot:x')).toBeNull();
});

describe('inheritSlots (inherit-on-swap)', () => {
  const ATTRS = new Proxy({} as Attributes, { get: () => 12 });
  const squad: SquadPlayerView[] = Array.from({ length: 14 }, (_, i) => ({
    playerId: `p${i}`,
    fullName: `Player ${i}`,
    position: i === 0 ? 'GK' : i < 5 ? 'DF' : i < 10 ? 'MF' : 'FW',
    attributes: ATTRS,
    fatigue: 0.2,
    sharpness: 1,
    injuryWeeksLeft: 0,
    suspendedNext: false,
    justReturned: false,
    seasonMinutes: 0,
  }));

  test('the swapped-in player inherits the slot config (anchors, sliders, zones); only playerId changes', () => {
    const starters = squad.slice(0, 11).map((p) => p.playerId);
    const slots = buildTactics({ starters, bench: [] }, squad, {}, defaultTeamInstructions).players.map((t, i) => ({
      ...t,
      // make slot 4's config distinctive so inheritance is observable
      ...(i === 4
        ? {
            instructions: { ...t.instructions, riskAppetite: 0.95 },
            zones: { buildUp: [{ zoneType: 'operating' as const, weight: 0.7, polygon: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }, { x: 1, y: 9 }] }] },
          }
        : {}),
    }));

    const swapped = [...starters];
    swapped[4] = 'p12'; // bench player in for the slot-4 starter
    const next = inheritSlots(slots, swapped, squad, defaultTeamInstructions);

    expect(next[4].playerId).toBe('p12');
    expect(next[4].anchors).toEqual(slots[4].anchors);
    expect(next[4].instructions.riskAppetite).toBe(0.95);
    expect(next[4].zones).toEqual(slots[4].zones);
    // untouched slots keep their occupants and configs
    expect(next[3]).toEqual(slots[3]);
  });

  test('slot↔slot swap: each player takes the OTHER slot’s config', () => {
    const starters = squad.slice(0, 11).map((p) => p.playerId);
    const slots = buildTactics({ starters, bench: [] }, squad, {}, defaultTeamInstructions).players;
    const swapped = [...starters];
    [swapped[1], swapped[6]] = [swapped[6], swapped[1]];
    const next = inheritSlots(slots, swapped, squad, defaultTeamInstructions);
    expect(next[1].playerId).toBe(starters[6]);
    expect(next[1].anchors).toEqual(slots[1].anchors);
    expect(next[6].playerId).toBe(starters[1]);
    expect(next[6].anchors).toEqual(slots[6].anchors);
  });
});
