/**
 * Lineup-as-pitch interactions (vitest + testing-library, jsdom). Drag and
 * tap share one swap model (pitch-swap.ts, unit-tested there); jsdom has no
 * layout, so the interaction under test here is the tap-to-swap path plus
 * rendering: XI on the pitch, bench underneath, availability + the live
 * eligibility mirror.
 */

import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, expect, test } from 'vitest';
import type { Attributes, PlayerTactic } from '@fm/engine/types';
import type { SquadPlayerView } from '../api.ts';
import { buildTactics, defaultTeamInstructions, inheritSlots, type Selection } from './build.ts';
import { LineupPitch } from './LineupPitch.tsx';

afterEach(cleanup);

const ATTRS = new Proxy({} as Attributes, { get: () => 12 });

function player(i: number, position: string, extra: Partial<SquadPlayerView> = {}): SquadPlayerView {
  return {
    playerId: `p${i}`,
    fullName: `First${i} Sur${i}`,
    position,
    attributes: ATTRS,
    fatigue: 0.2,
    sharpness: 1,
    injuryWeeksLeft: 0,
    suspendedNext: false,
    justReturned: false,
    seasonMinutes: 0,
    ...extra,
  };
}

/** 1 GK + 12 outfielders + a spare GK = 14 players; p0..p10 start. */
function squad(): SquadPlayerView[] {
  return [
    player(0, 'GK'),
    ...Array.from({ length: 12 }, (_, i) => player(i + 1, i < 4 ? 'DF' : i < 9 ? 'MF' : 'FW')),
    player(13, 'GK'),
  ];
}

/** Stateful harness: remaps starters onto slot configs like TacticsSection does. */
function Harness({ squad, initialBench = ['p11', 'p12'] }: { squad: SquadPlayerView[]; initialBench?: string[] }) {
  const starters = squad.slice(0, 11).map((p) => p.playerId);
  const [state, setState] = useState<{ slots: PlayerTactic[]; bench: string[] }>(() => ({
    slots: buildTactics({ starters, bench: initialBench }, squad, {}, defaultTeamInstructions).players,
    bench: initialBench,
  }));
  const onChange = (sel: Selection) =>
    setState((s) => ({ slots: inheritSlots(s.slots, sel.starters, squad, defaultTeamInstructions), bench: sel.bench }));
  return <LineupPitch squad={squad} slots={state.slots} bench={state.bench} onChange={onChange} />;
}

const slotEl = (i: number) => screen.getByTestId(`slot-${i}`);
const benchStrip = () => screen.getByTestId('bench-strip');

test('renders the XI on the pitch, the bench underneath, the rest as reserves', () => {
  render(<Harness squad={squad()} />);
  for (let i = 0; i < 11; i++) expect(within(slotEl(i)).getByText(`Sur${i}`)).toBeTruthy();
  expect(within(benchStrip()).getByText('Sur11')).toBeTruthy();
  expect(within(benchStrip()).getByText('Sur12')).toBeTruthy();
  // 14 - 11 - 2 = 1 reserve
  expect(within(screen.getByTestId('reserves')).getByText('First13 Sur13')).toBeTruthy();
  expect(screen.queryByTestId('issues')).toBeNull();
});

test('tap-to-swap: bench player onto a pitch slot — he takes the slot, the starter takes his bench spot', () => {
  render(<Harness squad={squad()} />);
  fireEvent.click(within(benchStrip()).getByText('Sur11'));
  fireEvent.click(slotEl(9));

  expect(within(slotEl(9)).getByText('Sur11')).toBeTruthy();
  expect(within(benchStrip()).getByText('Sur9')).toBeTruthy();
  expect(within(benchStrip()).queryByText('Sur11')).toBeNull();
});

test('the swapped-in player inherits the slot config: slot 9 keeps its anchors after the swap', () => {
  const sq = squad();
  const before = buildTactics({ starters: sq.slice(0, 11).map((p) => p.playerId), bench: [] }, sq, {}, defaultTeamInstructions)
    .players[9].anchors;

  let latest: Selection | null = null;
  const slots = buildTactics({ starters: sq.slice(0, 11).map((p) => p.playerId), bench: ['p11'] }, sq, {}, defaultTeamInstructions).players;
  render(<LineupPitch squad={sq} slots={slots} bench={['p11']} onChange={(sel) => { latest = sel; }} />);
  fireEvent.click(within(benchStrip()).getByText('Sur11'));
  fireEvent.click(slotEl(9));

  const remapped = inheritSlots(slots, latest!.starters, sq, defaultTeamInstructions);
  expect(remapped[9].playerId).toBe('p11');
  expect(remapped[9].anchors).toEqual(before);
});

test('tap-to-swap: two pitch players exchange slots', () => {
  render(<Harness squad={squad()} />);
  fireEvent.click(slotEl(1));
  fireEvent.click(slotEl(2));
  expect(within(slotEl(1)).getByText('Sur2')).toBeTruthy();
  expect(within(slotEl(2)).getByText('Sur1')).toBeTruthy();
});

test('tapping the picked player again deselects instead of swapping', () => {
  render(<Harness squad={squad()} />);
  fireEvent.click(slotEl(3));
  expect(screen.getByText(/Moving Sur3/)).toBeTruthy();
  fireEvent.click(slotEl(3));
  expect(screen.queryByText(/Moving/)).toBeNull();
  expect(within(slotEl(3)).getByText('Sur3')).toBeTruthy();
});

test('reserve → empty bench spot joins the bench; a starter cannot be moved to an empty spot', () => {
  render(<Harness squad={squad()} />);
  fireEvent.click(within(screen.getByTestId('reserves')).getByText('First13 Sur13'));
  fireEvent.click(screen.getByLabelText('empty bench spot 3'));
  expect(within(benchStrip()).getByText('Sur13')).toBeTruthy();

  // starter → empty spot is refused (the XI must stay 11)
  fireEvent.click(slotEl(5));
  fireEvent.click(screen.getByLabelText('empty bench spot 4'));
  expect(within(slotEl(5)).getByText('Sur5')).toBeTruthy();
});

test('reserve straight onto the pitch: exchange — the outgoing starter drops to reserves', () => {
  render(<Harness squad={squad()} />);
  fireEvent.click(within(screen.getByTestId('reserves')).getByText('First13 Sur13'));
  fireEvent.click(slotEl(0));
  expect(within(slotEl(0)).getByText('Sur13')).toBeTruthy();
  expect(within(screen.getByTestId('reserves')).getByText('First0 Sur0')).toBeTruthy();
});

test('unavailable players are visible on the pitch and flagged by the eligibility mirror', () => {
  const sq = squad().map((p) =>
    p.playerId === 'p3' ? { ...p, injuryWeeksLeft: 2 } : p.playerId === 'p7' ? { ...p, suspendedNext: true } : p,
  );
  render(<Harness squad={sq} />);
  expect(within(slotEl(3)).getByText('INJ 2w')).toBeTruthy();
  expect(within(slotEl(7)).getByText('SUS')).toBeTruthy();
  expect(screen.getByTestId('issues').textContent).toContain('Unavailable player selected');

  // swap the injured starter out for the fit reserve → one issue resolves
  fireEvent.click(within(screen.getByTestId('reserves')).getByText('First13 Sur13'));
  fireEvent.click(slotEl(3));
  // suspended p7 still in the XI
  expect(screen.getByTestId('issues').textContent).toContain('Unavailable player selected');
  fireEvent.click(within(benchStrip()).getByText('Sur11'));
  fireEvent.click(slotEl(7));
  // the exchange parked p7 on the bench — the validator flags him there too;
  // drop him to reserves (tap him, then tap the reserves area)
  expect(screen.getByTestId('issues').textContent).toContain('Unavailable player selected');
  fireEvent.click(within(benchStrip()).getByText('Sur7'));
  fireEvent.click(screen.getByTestId('reserves'));
  expect(screen.queryByTestId('issues')).toBeNull();
});

test('a missing goalkeeper surfaces in the mirror', () => {
  render(<Harness squad={squad()} />);
  // swap the GK (slot 0) out for an outfield bench player
  fireEvent.click(within(benchStrip()).getByText('Sur12'));
  fireEvent.click(slotEl(0));
  expect(screen.getByTestId('issues').textContent).toContain('Starting XI needs a goalkeeper');
});
