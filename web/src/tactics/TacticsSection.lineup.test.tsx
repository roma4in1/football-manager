/**
 * The lineup tab end-to-end (api mocked): entering offers presets FIRST
 * (saved full-tactic presets + the server standing plan), picking one lays
 * out the XI on the pitch, a bench swap inherits the slot's config, and
 * Save plan submits the remapped tactics exactly as before.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Attributes, Tactics } from '@fm/engine/types';
import type { SquadPlayerView } from '../api.ts';
import { buildTactics, defaultTeamInstructions } from '../lineup/build.ts';
import { TacticsSection } from './TacticsSection.tsx';

const mocks = vi.hoisted(() => ({
  squad: vi.fn(),
  defaultTactics: vi.fn(),
  saveDefaultTactics: vi.fn(),
}));

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

// this jsdom runs on an opaque origin, where localStorage exists but is inert —
// the presets store needs a working one
const lsStore = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, v),
  removeItem: (k: string) => void lsStore.delete(k),
  clear: () => lsStore.clear(),
});

const ATTRS = new Proxy({} as Attributes, { get: () => 12 });

const SQUAD: SquadPlayerView[] = [
  { playerId: 'p0', fullName: 'First0 Sur0', position: 'GK', attributes: ATTRS, fatigue: 0.2, sharpness: 1, injuryWeeksLeft: 0, suspendedNext: false, justReturned: false, seasonMinutes: 0 },
  ...Array.from({ length: 13 }, (_, i) => ({
    playerId: `p${i + 1}`,
    fullName: `First${i + 1} Sur${i + 1}`,
    position: i < 4 ? 'DF' : i < 9 ? 'MF' : 'FW',
    attributes: ATTRS,
    fatigue: 0.2,
    sharpness: 1,
    injuryWeeksLeft: 0,
    suspendedNext: false,
    justReturned: false,
    seasonMinutes: 0,
  })),
];

const defaultPlan = (): Tactics =>
  buildTactics({ starters: SQUAD.slice(0, 11).map((p) => p.playerId), bench: ['p11', 'p12'] }, SQUAD, {}, defaultTeamInstructions);

/** A distinct preset: p12 starts in slot 10 (riskAppetite made recognizable), p10 on the bench. */
const gegenpress = (): Tactics => {
  const starters = [...SQUAD.slice(0, 10).map((p) => p.playerId), 'p12'];
  const t = buildTactics({ starters, bench: ['p10', 'p11'] }, SQUAD, {}, defaultTeamInstructions);
  t.players[10] = { ...t.players[10], instructions: { ...t.players[10].instructions, riskAppetite: 0.91 } };
  return t;
};

beforeEach(() => {
  mocks.squad.mockResolvedValue({ players: SQUAD });
  mocks.defaultTactics.mockResolvedValue({ payload: defaultPlan() });
  mocks.saveDefaultTactics.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

test('lineup tab: presets first → pick one → XI laid out → bench swap inherits the slot → Save plan submits it', async () => {
  const preset = gegenpress();
  localStorage.setItem('fm.presets.tactic', JSON.stringify({ Gegenpress: preset }));

  render(<TacticsSection />);
  await screen.findByRole('button', { name: 'Save plan' });

  // entering the lineup tab offers presets as the starting point
  fireEvent.click(screen.getByRole('button', { name: 'lineup' }));
  const start = screen.getByTestId('lineup-start');
  expect(within(start).getByText('Current draft')).toBeTruthy();
  expect(within(start).getByText('My standing plan')).toBeTruthy();

  // picking the saved preset lays out its XI on the pitch
  fireEvent.click(within(start).getByText('Gegenpress'));
  expect(within(screen.getByTestId('slot-10')).getByText('Sur12')).toBeTruthy();
  const bench = screen.getByTestId('bench-strip');
  expect(within(bench).getByText('Sur10')).toBeTruthy();

  // drag-to-sub (tap path): bench p10 into slot 10 — p12 drops to the bench
  fireEvent.click(within(bench).getByText('Sur10'));
  fireEvent.click(screen.getByTestId('slot-10'));
  expect(within(screen.getByTestId('slot-10')).getByText('Sur10')).toBeTruthy();
  expect(within(screen.getByTestId('bench-strip')).getByText('Sur12')).toBeTruthy();

  // Save plan submits as today — with the incoming player inheriting slot 10's config
  fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await screen.findByText('Saved as your standing plan.');
  const saved = mocks.saveDefaultTactics.mock.calls[0][0] as Tactics;
  expect(saved.players[10].playerId).toBe('p10');
  expect(saved.players[10].anchors).toEqual(preset.players[10].anchors);
  expect(saved.players[10].instructions.riskAppetite).toBe(0.91); // inherit-on-swap
  expect(saved.bench).toEqual(['p12', 'p11']);
});

test('the chooser can be reopened from the pitch, and the standing plan restores the server default', async () => {
  render(<TacticsSection />);
  await screen.findByRole('button', { name: 'Save plan' });
  fireEvent.click(screen.getByRole('button', { name: 'lineup' }));

  fireEvent.click(screen.getByText('Current draft'));
  expect(screen.getByTestId('bench-strip')).toBeTruthy();

  // fine-tune, then reopen the chooser and load the standing plan
  fireEvent.click(screen.getByRole('button', { name: 'Start from a preset…' }));
  fireEvent.click(screen.getByText('My standing plan'));
  expect(await screen.findByTestId('bench-strip')).toBeTruthy();
  expect(within(screen.getByTestId('slot-0')).getByText('Sur0')).toBeTruthy();
  expect(mocks.defaultTactics).toHaveBeenCalledTimes(2); // initial load + the chooser
});
