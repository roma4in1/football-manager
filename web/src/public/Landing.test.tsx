/**
 * The public shell (vitest + testing-library, jsdom). Two things worth pinning:
 * the landing page's two doors point at the two auth routes, and App's anon
 * route table wires "/" → landing, "/signup" → the create-account card, with
 * NO rotate gate on a public page (the always-landscape overlay belongs to the
 * authenticated app only).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { App } from '../App.tsx';
import { Landing } from './Landing.tsx';

const mocks = vi.hoisted(() => ({ me: vi.fn() }));
vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mocks.me.mockRejectedValue(new ApiError(401, { error: 'unauthorized' })); // a visitor with no account
});

/** every link matching `name` — the doors are repeated (header + hero + closing) */
const hrefs = (name: RegExp) =>
  screen.getAllByRole('link', { name }).map((a) => a.getAttribute('href'));

test('landing: says what the game is, and offers both doors', () => {
  render(<MemoryRouter><Landing /></MemoryRouter>);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBeTruthy();
  for (const to of [/^sign up$/i, /create an account/i]) {
    const found = hrefs(to);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((h) => h === '/signup')).toBe(true);
  }
  for (const to of [/^log in$/i, /i already have one/i]) {
    const found = hrefs(to);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((h) => h === '/login')).toBe(true);
  }
});

test('landing: describes the season without inventing a claim about it', () => {
  render(<MemoryRouter><Landing /></MemoryRouter>);
  expect(screen.getByText(/how a season goes/i)).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
});

test('anon at "/" gets the landing page, not the sign-in card, and no rotate gate', async () => {
  window.history.pushState({}, '', '/');
  const { container } = render(<App />);
  expect(await screen.findByText(/how a season goes/i)).toBeTruthy();
  expect(screen.queryByLabelText(/password/i)).toBeNull();
  // portrait phones must not be told to rotate a public page
  expect(container.querySelector('.rotate-overlay')).toBeNull();
});

test('anon at "/signup" gets the create-account card directly', async () => {
  window.history.pushState({}, '', '/signup');
  render(<App />);
  expect(await screen.findByText('Create your account')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sign up' })).toBeTruthy();
});

test('anon at "/login" gets the sign-in card', async () => {
  window.history.pushState({}, '', '/login');
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
});

test('anon deep-linking into the app lands on the pitch, not a dead end', async () => {
  window.history.pushState({}, '', '/squad');
  render(<App />);
  await waitFor(() => expect(screen.getByText(/how a season goes/i)).toBeTruthy());
});

test('a visitor who is already signed in is sent to the app, not the pitch', async () => {
  mocks.me.mockResolvedValue({
    manager: { id: 'm1', email: 'boss@club.io', displayName: 'Boss' },
    club: null, // clubless account → the account placeholder, still not the landing page
    season: null,
  });
  window.history.pushState({}, '', '/');
  const { container } = render(<App />);
  expect(await screen.findByText("You're signed in")).toBeTruthy();
  expect(screen.queryByText(/how a season goes/i)).toBeNull();
  // and the always-landscape gate follows the authenticated app, as it always did
  expect(container.querySelector('.rotate-overlay')).not.toBeNull();
});
