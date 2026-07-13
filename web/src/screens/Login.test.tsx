/**
 * Login interactions (vitest + testing-library, jsdom): sign in, sign-up
 * toggle, forgot-password, and error surfacing — api mocked. Covers the auth
 * entry point of the accounts arc (LOBBY-DESIGN-SPEC §3).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { ToastProvider } from '../ui.tsx';
import { Login } from './Login.tsx';

const mocks = vi.hoisted(() => ({ login: vi.fn(), signup: vi.fn(), forgotPassword: vi.fn() }));
vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mocks.login.mockResolvedValue({ ok: true });
  mocks.signup.mockResolvedValue({ ok: true });
  mocks.forgotPassword.mockResolvedValue(undefined);
});

const renderLogin = (onAuthed = vi.fn()) => {
  render(<ToastProvider><Login onAuthed={onAuthed} /></ToastProvider>);
  return onAuthed;
};
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

test('sign in: fills credentials, calls api.login, then onAuthed', async () => {
  const onAuthed = renderLogin();
  const cta = screen.getByRole('button', { name: 'Sign in' });
  expect(cta).toHaveProperty('disabled', true); // until a valid email + 8-char password

  type(/email/i, 'boss@club.io');
  type(/password/i, 'password123');
  expect(cta).toHaveProperty('disabled', false);

  fireEvent.click(cta);
  await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('boss@club.io', 'password123'));
  await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
});

test('sign-up toggle: switches mode and calls api.signup', async () => {
  const onAuthed = renderLogin();
  fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
  type(/email/i, 'new@club.io');
  type(/password/i, 'password123');
  fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
  await waitFor(() => expect(mocks.signup).toHaveBeenCalledWith('new@club.io', 'password123'));
  await waitFor(() => expect(onAuthed).toHaveBeenCalled());
});

test('forgot-password: emails a link and shows the confirmation', async () => {
  renderLogin();
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  type(/email/i, 'boss@club.io');
  fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }));
  await waitFor(() => expect(mocks.forgotPassword).toHaveBeenCalledWith('boss@club.io'));
  expect(await screen.findByText('Check your inbox')).toBeTruthy();
});

test('bad credentials surface a readable error, onAuthed not called', async () => {
  mocks.login.mockRejectedValue(new ApiError(401, { error: 'invalid_credentials' }));
  const onAuthed = renderLogin();
  type(/email/i, 'boss@club.io');
  type(/password/i, 'wrongpass1');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Wrong email or password.')).toBeTruthy();
  expect(onAuthed).not.toHaveBeenCalled();
});
