/**
 * Lineup selection state tests (vitest + testing-library, jsdom).
 * Eligibility RULES are covered by league-eligibility.test.ts — here we test
 * the selection interactions: select/deselect, bench limits, invalid states.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, expect, test, vi } from 'vitest';
import type { Attributes } from '@fm/engine/types';
import type { SquadPlayerView } from '../api.ts';
import { LineupPicker } from './LineupPicker.tsx';

afterEach(cleanup);

const ATTRS = new Proxy({} as Attributes, { get: () => 12 });

function player(i: number, position: string, extra: Partial<SquadPlayerView> = {}): SquadPlayerView {
  return {
    playerId: `p${i}`,
    fullName: `Player ${i}`,
    position,
    attributes: ATTRS,
    fatigue: 0.2,
    injuryWeeksLeft: 0,
    suspendedNext: false,
    justReturned: false,
    seasonMinutes: 0,
    ...extra,
  };
}

/** 1 GK + 12 outfielders + a spare GK = 14 players. */
function squad(): SquadPlayerView[] {
  return [
    player(0, 'GK'),
    ...Array.from({ length: 12 }, (_, i) => player(i + 1, i < 4 ? 'DF' : i < 9 ? 'MF' : 'FW')),
    player(13, 'GK'),
  ];
}

const row = (name: string) => screen.getByText(name).closest('li')!;
const startBtn = (name: string) => within(row(name)).getByRole('button', { name: 'Start' });
const benchBtn = (name: string) => within(row(name)).getByRole('button', { name: 'Bench' });

function selectEleven(): void {
  for (let i = 0; i < 11; i++) fireEvent.click(startBtn(`Player ${i}`));
}

test('selecting players updates counts; a full XI with GK clears the issues', () => {
  const onChange = vi.fn();
  render(<LineupPicker squad={squad()} onChange={onChange} />);

  expect(screen.getByTestId('starter-count').textContent).toContain('0/11');
  fireEvent.click(startBtn('Player 0'));
  expect(screen.getByTestId('starter-count').textContent).toContain('1/11');
  expect(screen.getByTestId('issues').textContent).toContain('Select exactly 11 starters');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ starters: ['p0'] }), false);

  for (let i = 1; i < 11; i++) fireEvent.click(startBtn(`Player ${i}`));
  expect(screen.getByTestId('starter-count').textContent).toContain('11/11');
  expect(screen.queryByTestId('issues')).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ starters: expect.arrayContaining(['p0', 'p10']) }), true);
});

test('deselect: clicking Start again removes the player from the XI', () => {
  const onChange = vi.fn();
  render(<LineupPicker squad={squad()} onChange={onChange} />);
  selectEleven();
  fireEvent.click(startBtn('Player 5'));
  expect(screen.getByTestId('starter-count').textContent).toContain('10/11');
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ starters: expect.not.arrayContaining(['p5']) }),
    false,
  );
});

test('a 12th starter is refused while the XI is full', () => {
  render(<LineupPicker squad={squad()} onChange={() => {}} />);
  selectEleven();
  fireEvent.click(startBtn('Player 11'));
  expect(screen.getByTestId('starter-count').textContent).toContain('11/11');
  expect(startBtn('Player 11')).toHaveProperty('ariaPressed', 'false');
});

test('bench: toggling moves players between roles and respects the cap of 9', () => {
  const onChange = vi.fn();
  const bigSquad = [...squad(), ...Array.from({ length: 8 }, (_, i) => player(20 + i, 'MF'))]; // 22 players
  render(<LineupPicker squad={bigSquad} onChange={onChange} />);
  selectEleven();

  fireEvent.click(benchBtn('Player 11'));
  expect(screen.getByTestId('bench-count').textContent).toContain('1/9');

  // a starter demoted to bench leaves the XI
  fireEvent.click(benchBtn('Player 10'));
  expect(screen.getByTestId('starter-count').textContent).toContain('10/11');
  expect(screen.getByTestId('bench-count').textContent).toContain('2/9');

  // fill the bench to 9, then the 10th is refused
  for (const n of [12, 13, 20, 21, 22, 23, 24]) fireEvent.click(benchBtn(`Player ${n}`));
  expect(screen.getByTestId('bench-count').textContent).toContain('9/9');
  fireEvent.click(benchBtn('Player 25'));
  expect(screen.getByTestId('bench-count').textContent).toContain('9/9');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ bench: expect.not.arrayContaining(['p25']) }), false);
});

test('invalid states: unavailable players and missing GK surface as issues', () => {
  const onChange = vi.fn();
  const wrecked = squad().map((p) =>
    p.playerId === 'p3' ? { ...p, injuryWeeksLeft: 2 } : p.playerId === 'p5' ? { ...p, suspendedNext: true } : p,
  );
  render(<LineupPicker squad={wrecked} onChange={onChange} />);

  expect(within(row('Player 3')).getByText('INJ 2w')).toBeTruthy();
  expect(within(row('Player 5')).getByText('SUSPENDED')).toBeTruthy();

  selectEleven(); // includes the injured + suspended players
  const issues = screen.getByTestId('issues').textContent!;
  expect(issues).toContain('Unavailable player selected');
  expect(onChange).toHaveBeenLastCalledWith(expect.anything(), false);

  // swap them for fit players → becomes valid
  fireEvent.click(startBtn('Player 3'));
  fireEvent.click(startBtn('Player 5'));
  fireEvent.click(startBtn('Player 11'));
  fireEvent.click(startBtn('Player 12'));
  expect(screen.queryByTestId('issues')).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith(expect.anything(), true);
});

test('missing goalkeeper is reported', () => {
  render(<LineupPicker squad={squad()} onChange={() => {}} />);
  // select 11 outfielders, no GK (players 1..11)
  for (let i = 1; i <= 11; i++) fireEvent.click(startBtn(`Player ${i}`));
  expect(screen.getByTestId('issues').textContent).toContain('Starting XI needs a goalkeeper');
});
