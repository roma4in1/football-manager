/**
 * The account surface, and the two gaps it closes.
 *
 * Logout was NOT unwired — the rail has called it since phase 1, end to end.
 * The real gaps were (a) it is reachable only in landscape, because the rail
 * lives inside `.app` which styles.css hides in portrait, and (b) the club
 * identity EDITOR shipped in phase 2 and nothing ever routed to it.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App.tsx';

const mocks = vi.hoisted(() => ({
  me: vi.fn(), logout: vi.fn(), saveClubIdentity: vi.fn(),
  matchweekCurrent: vi.fn(), squad: vi.fn(), facilities: vi.fn(),
  training: vi.fn(), standings: vi.fn(), results: vi.fn(),
}));
vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const IDENTITY = {
  name: 'Real Coteaux', badgeShape: 'shield' as const, badgeEmblem: 'lion' as const,
  primaryColor: '#534ab7', secondaryColor: '#1e3a8a',
};
const ALPHA = { id: 'lg-a', name: 'Alpha League', status: 'active', clubId: 'club-a', clubName: 'Real Coteaux' };

const meIn = (leagues = [ALPHA], selected: string | null = 'lg-a') => ({
  manager: { id: 'm1', email: 'boss@club.io', displayName: 'Boss' },
  leagues, selectedLeagueId: selected, clubIdentity: IDENTITY,
  club: selected ? { id: 'club-a', name: 'Real Coteaux' } : null,
  season: selected ? { id: 's1', number: 1, phase: 'regular' } : null,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  window.history.pushState({}, '', '/account');
  mocks.me.mockResolvedValue(meIn());
  mocks.logout.mockResolvedValue(undefined);
  mocks.saveClubIdentity.mockImplementation(async (i: unknown) => i);
  mocks.matchweekCurrent.mockResolvedValue({ matchweek: null, fixtures: [] });
  mocks.squad.mockResolvedValue({ players: [] });
  mocks.facilities.mockResolvedValue({});
  mocks.training.mockResolvedValue({});
  mocks.standings.mockResolvedValue({ table: [] });
  mocks.results.mockResolvedValue({ weeks: [] });
});

test('the account surface shows only what exists: email, club, league, sign out', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Account' })).toBeTruthy();
  expect(screen.getByText('boss@club.io')).toBeTruthy();
  expect(screen.getByText('Real Coteaux')).toBeTruthy();
  expect(screen.getByText('Alpha League')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  // no invented surfaces
  expect(screen.queryByText(/profile/i)).toBeNull();
  expect(screen.queryByText(/settings/i)).toBeNull();
});

test('it renders OUTSIDE .app, so signing out never needs the phone rotated', async () => {
  const { container } = render(<App />);
  await screen.findByRole('heading', { name: 'Account' });
  expect(container.querySelector('.app')).toBeNull();
  expect(container.querySelector('.rotate-overlay')).toBeNull();
});

test('SIGN OUT ends the session and returns to the public side', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

  await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
  // the app drops to anon and the public landing page renders — not stale state
  expect(await screen.findByText(/how a season goes/i)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Account' })).toBeNull();
});

test('the club identity EDITOR is reachable at last — phase 2 built it, nothing routed to it', async () => {
  render(<App />);
  const edit = await screen.findByRole('link', { name: 'Edit' });
  expect(edit.getAttribute('href')).toBe('/account/club');

  window.history.pushState({}, '', '/account/club');
  cleanup();
  render(<App />);
  // pre-filled, in EDIT mode — not the create-club first-run copy
  expect(await screen.findByRole('heading', { name: 'Your club' })).toBeTruthy();
  expect(screen.getByLabelText(/club name/i)).toHaveProperty('value', 'Real Coteaux');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
});

test('saving an edit calls the API and returns to the account surface', async () => {
  window.history.pushState({}, '', '/account/club');
  render(<App />);
  fireEvent.change(await screen.findByLabelText(/club name/i), { target: { value: 'Coteaux United' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(mocks.saveClubIdentity).toHaveBeenCalledTimes(1));
  expect(mocks.saveClubIdentity.mock.calls[0][0].name).toBe('Coteaux United');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy());
});

test('the rail carries the account entry AND keeps one-tap sign out', async () => {
  window.history.pushState({}, '', '/');
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector('.app')).not.toBeNull());

  const rail = container.querySelector('.rail')!;
  expect(within(rail as HTMLElement).getByRole('link', { name: /Real Coteaux/ }).getAttribute('href')).toBe('/account');
  // the icon button is still there — the surface is a container, not a replacement
  expect(within(rail as HTMLElement).getByRole('button', { name: 'Sign out' })).toBeTruthy();
});

test('the rotate overlay offers a way out — the only thing portrait renders in a league', async () => {
  window.history.pushState({}, '', '/');
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector('.rotate-overlay')).not.toBeNull());
  const overlay = container.querySelector('.rotate-overlay')!;
  const out = within(overlay as HTMLElement).getByRole('link', { name: /Account/ });
  expect(out.getAttribute('href')).toBe('/account');
});
