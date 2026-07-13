/**
 * Auction bid flow (api mocked): a placed bid is irretractable, so pressing
 * Bid opens a confirmation rather than firing immediately. Confirming calls
 * api.bid with the intended amount and raises a success toast; cancelling
 * fires nothing.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Attributes } from '@fm/engine/types';
import type { AuctionStateView } from '../api.ts';
import { ToastProvider } from '../ui.tsx';
import { AuctionScreen } from './AuctionScreen.tsx';

const mocks = vi.hoisted(() => ({ auctionState: vi.fn(), squad: vi.fn(), bid: vi.fn() }));

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ATTRS = new Proxy({} as Attributes, { get: () => 12 });

const state = (): AuctionStateView => ({
  phase: 'auction',
  lot: {
    lotId: 'lot-1',
    player: { playerId: 'pl-1', fullName: 'Marco Rossi', position: 'DF', marketValue: 5_000_000, attributes: ATTRS },
    opensAt: new Date(Date.now() - 1000).toISOString(),
    closesAt: new Date(Date.now() + 60_000).toISOString(),
    highBid: null,
  },
  turn: { clubId: 'c2', name: 'Rivals', you: false },
  clubs: [{ clubId: 'c1', name: 'You', remaining: 40_000_000, squadCount: 3, you: true }],
  you: {
    remaining: 40_000_000, squadCount: 3, wageBill: 0, wageCap: 1_000_000,
    totalPot: 50_000_000, auctionBudget: 40_000_000, reserve: 10_000_000, splitLocked: true,
  },
  signings: [],
  squadMin: 16,
  squadMax: 25,
});

const renderScreen = () =>
  render(<ToastProvider><AuctionScreen /></ToastProvider>);

beforeEach(() => {
  mocks.auctionState.mockResolvedValue(state());
  mocks.squad.mockResolvedValue({ players: [] });
  mocks.bid.mockResolvedValue({ closesAt: new Date(Date.now() + 90_000).toISOString() });
});

test('pressing Bid confirms first; confirming calls api.bid and toasts', async () => {
  renderScreen();
  await screen.findByText('Marco Rossi');

  // no bid fired yet — Bid opens the confirmation
  fireEvent.click(screen.getByRole('button', { name: 'Bid' }));
  expect(mocks.bid).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Place this bid?')).toBeTruthy();

  // confirming fires the bid and confirms it happened
  fireEvent.click(within(dialog).getByRole('button', { name: /^Bid/ }));
  await screen.findByText('Bid placed');
  expect(mocks.bid).toHaveBeenCalledTimes(1);
  expect(mocks.bid.mock.calls[0][0]).toBe('lot-1');
  expect(mocks.bid.mock.calls[0][1]).toBeGreaterThan(0);
});

test('cancelling the confirmation fires no bid', async () => {
  renderScreen();
  await screen.findByText('Marco Rossi');

  fireEvent.click(screen.getByRole('button', { name: 'Bid' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(mocks.bid).not.toHaveBeenCalled();
});
