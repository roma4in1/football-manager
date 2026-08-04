/**
 * Club identity (accounts-arc phase 2). Two things worth pinning: the editor
 * saves a well-formed identity and refuses a malformed one, and App routes an
 * account with NO identity to this screen — outside `.app`, so a brand-new
 * signup on a portrait phone is not the dead end AccountLanding was.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { App } from '../App.tsx';
import { ToastProvider } from '../ui.tsx';
import { CreateClub } from './CreateClub.tsx';

const mocks = vi.hoisted(() => ({ me: vi.fn(), saveClubIdentity: vi.fn() }));
vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mocks.saveClubIdentity.mockImplementation(async (i: unknown) => i);
  mocks.me.mockRejectedValue(new ApiError(401, { error: 'unauthorized' }));
});

const IDENTITY = {
  name: 'Real Coteaux', badgeShape: 'shield' as const, badgeEmblem: 'lion' as const,
  primaryColor: '#534ab7', secondaryColor: '#1e3a8a',
};

const authed = (clubIdentity: unknown) => ({
  manager: { id: 'm1', email: 'boss@club.io', displayName: 'Boss' },
  club: null, clubIdentity, season: null,
  leagues: [], selectedLeagueId: null,
});

test('creating a club: name + crest choices save as one identity', async () => {
  const onSaved = vi.fn();
  render(<ToastProvider><CreateClub existing={null} onSaved={onSaved} /></ToastProvider>);

  const cta = screen.getByRole('button', { name: 'Create club' });
  expect(cta).toHaveProperty('disabled', true); // no name yet

  fireEvent.change(screen.getByLabelText(/club name/i), { target: { value: 'Real Coteaux' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lion' }));
  expect(cta).toHaveProperty('disabled', false);

  fireEvent.click(cta);
  await waitFor(() => expect(mocks.saveClubIdentity).toHaveBeenCalledTimes(1));
  const sent = mocks.saveClubIdentity.mock.calls[0][0];
  expect(sent.name).toBe('Real Coteaux');
  expect(sent.badgeEmblem).toBe('lion');
  expect(sent.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
  expect(sent.secondaryColor).toMatch(/^#[0-9a-f]{6}$/);
  // the identity carries NO league or club reference — that is the whole point
  expect(Object.keys(sent).sort()).toEqual(
    ['badgeEmblem', 'badgeShape', 'name', 'primaryColor', 'secondaryColor'],
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test('a one-character name cannot be saved', () => {
  render(<ToastProvider><CreateClub existing={null} onSaved={vi.fn()} /></ToastProvider>);
  fireEvent.change(screen.getByLabelText(/club name/i), { target: { value: 'R' } });
  expect(screen.getByRole('button', { name: 'Create club' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/at least 2 characters/i)).toBeTruthy();
  expect(mocks.saveClubIdentity).not.toHaveBeenCalled();
});

test('editing an existing identity is the same screen, pre-filled', () => {
  render(<ToastProvider><CreateClub existing={IDENTITY} onSaved={vi.fn()} /></ToastProvider>);
  expect(screen.getByRole('heading', { name: 'Your club' })).toBeTruthy();
  expect(screen.getByLabelText(/club name/i)).toHaveProperty('value', 'Real Coteaux');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
});

test('an account with NO identity lands on create-club, with no rotate gate', async () => {
  mocks.me.mockResolvedValue(authed(null));
  window.history.pushState({}, '', '/');
  const { container } = render(<App />);

  expect(await screen.findByRole('heading', { name: 'Name your club' })).toBeTruthy();
  // the dead-end fix: AccountLanding sat inside .app, which portrait phones hide
  expect(container.querySelector('.rotate-overlay')).toBeNull();
  expect(container.querySelector('.app')).toBeNull();
  expect(screen.queryByText("You're signed in")).toBeNull();
});

test('an account WITH an identity is past create-club (the gate does not re-fire)', async () => {
  mocks.me.mockResolvedValue(authed(IDENTITY));
  window.history.pushState({}, '', '/');
  const { container } = render(<App />);

  // an identity but no league → the Leagues Hub, and the create-club gate does
  // NOT re-fire. AccountLanding (and its portrait dead end) is gone for good.
  await waitFor(() => expect(screen.getByText('Your leagues')).toBeTruthy());
  expect(screen.queryByRole('heading', { name: 'Name your club' })).toBeNull();
  expect(container.querySelector('.rotate-overlay')).toBeNull();
});
