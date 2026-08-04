/**
 * THE END-TO-END TWO-LEAGUE TEST — phase 3 step 4.
 *
 * One account in two leagues, switching between them THROUGH THE APP: the hub
 * lists both, choosing one calls the switch endpoint, /me re-resolves, and the
 * club, season and every screen that reads them follow. The store test and the
 * route tests already exist; this is the layer that had never been exercised.
 *
 * Also pins where the hub RENDERS. It must be outside `.app` — styles.css hides
 * `.app` on a portrait phone behind the rotate overlay, and an account with no
 * league has the hub as its only screen, so inside `.app` it would be the exact
 * dead end AccountLanding was.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App.tsx';

const mocks = vi.hoisted(() => ({
  me: vi.fn(), selectLeague: vi.fn(),
  // two of these cases render the game shell, whose Home screen fetches on
  // mount; jsdom cannot resolve a relative URL, so stub what it reaches for
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
const BETA = { id: 'lg-b', name: 'Beta League', status: 'active', clubId: 'club-b', clubName: 'Real Coteaux' };

/** /me as the server returns it for a given selected league */
const meIn = (selected: string | null, leagues = [ALPHA, BETA]) => {
  const m = leagues.find((l) => l.id === selected) ?? null;
  return {
    manager: { id: 'm1', email: 'boss@club.io', displayName: 'Boss' },
    leagues,
    selectedLeagueId: selected,
    clubIdentity: IDENTITY,
    club: m ? { id: m.clubId, name: m.clubName } : null,
    season: m ? { id: `season-${m.id}`, number: m.id === 'lg-a' ? 1 : 7, phase: 'regular' } : null,
  };
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  window.history.pushState({}, '', '/leagues');
  mocks.selectLeague.mockResolvedValue({ selectedLeagueId: 'lg-b' });
  mocks.matchweekCurrent.mockResolvedValue({ matchweek: null, fixtures: [] });
  mocks.squad.mockResolvedValue({ players: [] });
  mocks.facilities.mockResolvedValue({});
  mocks.training.mockResolvedValue({});
  mocks.standings.mockResolvedValue({ table: [] });
  mocks.results.mockResolvedValue({ weeks: [] });
});

test('the hub lists BOTH leagues and marks the selected one', async () => {
  mocks.me.mockResolvedValue(meIn('lg-a'));
  render(<App />);

  const rows = await screen.findAllByRole('button', { name: /League/ });
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText('Alpha League')).toBeTruthy();
  expect(within(rows[1]).getByText('Beta League')).toBeTruthy();
  // the selected one offers Open, the other Switch
  expect(within(rows[0]).getByText('Open')).toBeTruthy();
  expect(within(rows[1]).getByText('Switch')).toBeTruthy();
  expect(rows[0].getAttribute('aria-current')).toBe('true');
  expect(rows[1].getAttribute('aria-current')).toBeNull();
});

test('the hub renders OUTSIDE .app, with no rotate gate — the dead end is gone', async () => {
  mocks.me.mockResolvedValue(meIn('lg-a'));
  const { container } = render(<App />);
  await screen.findByText('Your leagues');
  expect(container.querySelector('.app')).toBeNull();
  expect(container.querySelector('.rotate-overlay')).toBeNull();
});

test('SWITCHING: choosing the other league re-resolves the whole app onto it', async () => {
  // first /me is on Alpha; after the switch the server answers Beta
  mocks.me.mockResolvedValueOnce(meIn('lg-a')).mockResolvedValue(meIn('lg-b'));
  render(<App />);

  const beta = await screen.findByRole('button', { name: /Beta League/ });
  fireEvent.click(beta);

  await waitFor(() => expect(mocks.selectLeague).toHaveBeenCalledWith('lg-b'));
  // App re-fetches /me, and the hub now marks Beta as the selected one
  await waitFor(() => {
    const rows = screen.getAllByRole('button', { name: /League/ });
    expect(within(rows[1]).getByText('Open')).toBeTruthy();
    expect(rows[1].getAttribute('aria-current')).toBe('true');
  });
});

test('an account in NO league gets the hub, not a dead end', async () => {
  window.history.pushState({}, '', '/');
  mocks.me.mockResolvedValue(meIn(null, []));
  const { container } = render(<App />);

  expect(await screen.findByText("Your leagues")).toBeTruthy();
  expect(screen.getByText(/aren't in a league yet/)).toBeTruthy();
  expect(container.querySelector('.app')).toBeNull();
  expect(container.querySelector('.rotate-overlay')).toBeNull();
});

test('entering a league renders the always-landscape app, WITH the rotate gate', async () => {
  window.history.pushState({}, '', '/');
  mocks.me.mockResolvedValue(meIn('lg-a'));
  const { container } = render(<App />);

  // the game shell is the app frame, and the gate belongs to it
  await waitFor(() => expect(container.querySelector('.app')).not.toBeNull());
  expect(container.querySelector('.rotate-overlay')).not.toBeNull();
  expect(screen.queryByText('Your leagues')).toBeNull();
});

test('the rail offers the switcher only when there is more than one league', async () => {
  window.history.pushState({}, '', '/');
  mocks.me.mockResolvedValue(meIn('lg-a'));
  const { container, unmount } = render(<App />);
  await waitFor(() => expect(container.querySelector('.app')).not.toBeNull());
  expect(screen.getByRole('link', { name: /leagues/i })).toBeTruthy();
  unmount();

  // ...and not when there is only one to be in
  mocks.me.mockResolvedValue(meIn('lg-a', [ALPHA]));
  render(<App />);
  await waitFor(() => expect(document.querySelector('.app')).not.toBeNull());
  expect(screen.queryByRole('link', { name: /leagues/i })).toBeNull();
});

test('a failed switch surfaces an error and does not strand the hub', async () => {
  mocks.me.mockResolvedValue(meIn('lg-a'));
  mocks.selectLeague.mockRejectedValue(new Error('nope'));
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Beta League/ }));
  expect(await screen.findByText('Could not switch league, try again.')).toBeTruthy();
  // still usable: both rows are live again
  expect(screen.getAllByRole('button', { name: /League/ })).toHaveLength(2);
});
