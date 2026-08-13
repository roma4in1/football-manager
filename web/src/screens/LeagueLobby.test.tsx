/**
 * THE LOBBY, THROUGH THE APP — phase 4.
 *
 * The route tests (server/league-lobby.test.ts) pin what the server allows. This
 * pins what a person can actually reach, and it exists for three moments that
 * are only visible on a screen:
 *
 *  · A TYPO'D CODE. It is the commonest thing a first user does and a raw 404 is
 *    the second-worst outcome after a league that cannot run. The code they
 *    typed comes back in the sentence.
 *  · TWO CLUBS OF EIGHT STARTS. Capacity is a ceiling, not a quorum — the button
 *    must be live at two, and the count must still say what the ceiling is.
 *  · A `none` POOL IS SAID AT CREATION AND BLOCKS THE START. Both halves: the
 *    sentence when the league is made, and the dead button when it is opened.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App.tsx';
import { ApiError } from '../api.ts';

const mocks = vi.hoisted(() => ({
  me: vi.fn(), selectLeague: vi.fn(),
  createLeague: vi.fn(), joinLeague: vi.fn(), leagueLobby: vi.fn(), startLeague: vi.fn(),
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
const LOBBY_LEAGUE = { id: 'lg-x', name: 'Sunday League', status: 'lobby', clubId: 'club-x', clubName: 'Real Coteaux' };

/** /me for an account whose only league has NO SEASON YET — the lobby state. */
const meInLobby = (leagues = [LOBBY_LEAGUE]) => ({
  manager: { id: 'm1', email: 'boss@club.io', displayName: 'Boss' },
  leagues,
  selectedLeagueId: leagues[0]?.id ?? null,
  clubIdentity: IDENTITY,
  club: leagues[0] ? { id: leagues[0].clubId, name: leagues[0].clubName } : null,
  season: null,
});

const lobby = (over: Partial<{
  clubs: Array<{ clubId: string; clubName: string; managerId: string; displayName: string }>;
  capacity: number; poolCount: number; isHost: boolean;
}> = {}) => ({
  leagueId: 'lg-x', name: 'Sunday League', status: 'lobby', capacity: 8, joinCode: 'K7QM2X',
  isHost: true, poolCount: 512,
  clubs: [
    { clubId: 'club-x', clubName: 'Real Coteaux', managerId: 'm1', displayName: 'Boss' },
    { clubId: 'club-y', clubName: 'Beta United', managerId: 'm2', displayName: 'Sam' },
  ],
  ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  window.history.pushState({}, '', '/leagues');
  mocks.selectLeague.mockResolvedValue({ selectedLeagueId: 'lg-x' });
  mocks.matchweekCurrent.mockResolvedValue({ matchweek: null, fixtures: [] });
  mocks.squad.mockResolvedValue({ players: [] });
  mocks.facilities.mockResolvedValue({});
  mocks.training.mockResolvedValue({});
  mocks.standings.mockResolvedValue({ table: [] });
  mocks.results.mockResolvedValue({ weeks: [] });
});

test('an account in no league is offered BOTH acts — create, and join by code', async () => {
  mocks.me.mockResolvedValue({ ...meInLobby([]), club: null });
  render(<App />);

  expect(await screen.findByText('Start a league')).toBeTruthy();
  expect(screen.getByText('Join with a code')).toBeTruthy();
  // and the phase-4 promissory note is gone
  expect(screen.queryByText(/arrives in the next update/)).toBeNull();
});

test('CREATING one opens its lobby, with the code and a way to copy it', async () => {
  mocks.me.mockResolvedValueOnce({ ...meInLobby([]), club: null }).mockResolvedValue(meInLobby());
  mocks.createLeague.mockResolvedValue({
    leagueId: 'lg-x', joinCode: 'K7QM2X', clubId: 'club-x', pool: { copied: 512, source: 'templates' },
  });
  mocks.leagueLobby.mockResolvedValue(lobby({ clubs: [lobby().clubs[0]] }));
  render(<App />);

  fireEvent.change(await screen.findByLabelText(/League name/), { target: { value: 'Sunday League' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create league' }));

  await waitFor(() => expect(mocks.createLeague).toHaveBeenCalledWith('Sunday League', 8, 'Real Coteaux'));
  // the code is on screen, verbatim, next to a copy control
  expect(await screen.findByText('K7QM2X')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});

test('A `none` POOL IS SAID AT CREATION and the start is dead when the lobby opens', async () => {
  mocks.me.mockResolvedValueOnce({ ...meInLobby([]), club: null }).mockResolvedValue(meInLobby());
  mocks.createLeague.mockResolvedValue({
    leagueId: 'lg-x', joinCode: 'K7QM2X', clubId: 'club-x', pool: { copied: 0, source: 'none' },
  });
  mocks.leagueLobby.mockResolvedValue(lobby({ poolCount: 0 }));
  render(<App />);

  fireEvent.change(await screen.findByLabelText(/League name/), { target: { value: 'Empty Tree' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create league' }));

  // the sentence HOLDS THE SCREEN — it is not unmounted by walking into the lobby
  expect(await screen.findByText(/no players could be copied into it/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start the season' })).toBeNull();

  // ...and opening the lobby says it again, with the button it blocks
  fireEvent.click(await screen.findByRole('button', { name: /Sunday League/ }));
  const start = await screen.findByRole('button', { name: 'Start the season' });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/cannot run an auction/)).toBeTruthy();
});

test('TWO CLUBS OF EIGHT STARTS — capacity is a ceiling, not a quorum', async () => {
  mocks.me.mockResolvedValue(meInLobby());
  mocks.leagueLobby.mockResolvedValue(lobby());
  mocks.startLeague.mockResolvedValue({ leagueId: 'lg-x', seasonId: 's1', clubs: 2 });
  render(<App />);

  expect(await screen.findByText('2 of 8 joined')).toBeTruthy();
  const list = screen.getByRole('list');
  expect(within(list).getByText('Real Coteaux')).toBeTruthy();
  expect(within(list).getByText(/Beta United/)).toBeTruthy();

  const start = screen.getByRole('button', { name: 'Start the season' });
  expect((start as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(start);
  await waitFor(() => expect(mocks.startLeague).toHaveBeenCalledWith('lg-x'));
});

test('ONE CLUB WAITS, and the reason is on the screen rather than in a 409', async () => {
  mocks.me.mockResolvedValue(meInLobby());
  mocks.leagueLobby.mockResolvedValue(lobby({ clubs: [lobby().clubs[0]] }));
  render(<App />);

  expect(await screen.findByText('1 of 8 joined')).toBeTruthy();
  const start = screen.getByRole('button', { name: 'Start the season' });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/at least two clubs/)).toBeTruthy();
});

test('a member who is NOT the host is told who starts it, and offered no button', async () => {
  mocks.me.mockResolvedValue(meInLobby());
  mocks.leagueLobby.mockResolvedValue(lobby({ isHost: false }));
  render(<App />);

  expect(await screen.findByText(/The host starts the season/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start the season' })).toBeNull();
});

test('A TYPO IN THE CODE COMES BACK AS THE CODE THEY TYPED, not a raw 404', async () => {
  mocks.me.mockResolvedValue({ ...meInLobby([]), club: null });
  mocks.joinLeague.mockRejectedValue(new ApiError(404, { error: 'not_found' }));
  render(<App />);

  fireEvent.change(await screen.findByLabelText(/Join code/), { target: { value: 'k7qm2z' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join league' }));

  expect(await screen.findByText(/No league has the code K7QM2Z/)).toBeTruthy();
  expect(screen.queryByText(/404/)).toBeNull();
  // still usable — the field is live for the second try
  expect((screen.getByLabelText(/Join code/) as HTMLInputElement).value).toBe('K7QM2Z');
});

test('the other refusals each get their own sentence', async () => {
  mocks.me.mockResolvedValue({ ...meInLobby([]), club: null });
  render(<App />);
  const code = await screen.findByLabelText(/Join code/);
  const button = screen.getByRole('button', { name: 'Join league' });

  for (const [error, expected] of [
    ['league_started', /already started its season/],
    ['league_full', /is full/],
    ['already_joined', /already in that league/],
  ] as const) {
    mocks.joinLeague.mockRejectedValueOnce(new ApiError(409, { error }));
    fireEvent.change(code, { target: { value: 'K7QM2X' } });
    fireEvent.click(button);
    expect(await screen.findByText(expected)).toBeTruthy();
  }
});
