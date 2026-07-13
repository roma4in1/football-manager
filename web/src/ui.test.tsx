/**
 * Interaction primitives (vitest + testing-library, jsdom): the shared feel
 * layer wired into every submit/bid/save. Toasts confirm without blocking;
 * ActionButton owns the pending → success feel; ConfirmDialog gates the
 * irreversible actions and cancels on Escape / backdrop.
 */

import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, expect, test, vi } from 'vitest';
import { ActionButton, ConfirmDialog, ToastProvider, useToast } from './ui.tsx';

afterEach(cleanup);

/** A tiny consumer that fires a toast on click. */
function ToastProbe() {
  const { toast } = useToast();
  return <button onClick={() => toast('Bid placed', 'success')}>fire</button>;
}

test('toast: a fired toast appears, is announced politely, and dismisses on tap', () => {
  render(
    <ToastProvider>
      <ToastProbe />
    </ToastProvider>,
  );
  expect(screen.queryByText('Bid placed')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'fire' }));
  const toast = screen.getByText('Bid placed');
  expect(toast).toBeTruthy();
  expect(toast.closest('.toast-host')?.getAttribute('aria-live')).toBe('polite');

  // tapping starts the leave animation
  fireEvent.click(toast);
  expect(toast.className).toContain('leaving');
});

test('useToast outside a provider is a safe no-op (unit-test friendly)', () => {
  // no provider — must not throw when the consumer fires a toast
  render(<ToastProbe />);
  expect(() => fireEvent.click(screen.getByRole('button', { name: 'fire' }))).not.toThrow();
});

test('ActionButton: idle → pending (busy, disabled) → success flash → idle', async () => {
  let resolve!: () => void;
  const onAct = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
  render(<ActionButton className="primary" onAct={onAct}>Bid</ActionButton>);

  const btn = screen.getByRole('button', { name: 'Bid' });
  expect(btn.getAttribute('aria-busy')).toBe('false');

  fireEvent.click(btn);
  expect(onAct).toHaveBeenCalledTimes(1);
  expect(btn.getAttribute('aria-busy')).toBe('true');
  expect(btn).toHaveProperty('disabled', true);

  await act(async () => { resolve(); });
  await waitFor(() => expect(btn.className).toContain('is-success'));
  // name stays stable throughout (spinner/tick are decorative)
  expect(screen.getByRole('button', { name: 'Bid' })).toBeTruthy();
});

test('ActionButton: a rejected action returns to idle so the caller can report it', async () => {
  const onAct = vi.fn(() => Promise.reject(new Error('nope')));
  render(<ActionButton onAct={onAct}>Save</ActionButton>);
  const btn = screen.getByRole('button', { name: 'Save' });

  await act(async () => { fireEvent.click(btn); });
  await waitFor(() => expect(btn.getAttribute('aria-busy')).toBe('false'));
  expect(btn.className).not.toContain('is-success');
  expect(btn).toHaveProperty('disabled', false);
});

/** Stateful harness around ConfirmDialog. */
function ConfirmHarness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>delete</button>
      <ConfirmDialog
        open={open}
        title="Delete this preset?"
        body="This can't be undone."
        confirmLabel="Delete preset"
        tone="danger"
        onCancel={() => setOpen(false)}
        onConfirm={() => { onConfirm(); setOpen(false); }}
      />
    </>
  );
}

test('ConfirmDialog: hidden until opened; Confirm runs the action', () => {
  const onConfirm = vi.fn();
  render(<ConfirmHarness onConfirm={onConfirm} />);
  expect(screen.queryByRole('alertdialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'delete' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('ConfirmDialog: Escape and backdrop cancel without running the action', () => {
  const onConfirm = vi.fn();
  render(<ConfirmHarness onConfirm={onConfirm} />);

  fireEvent.click(screen.getByRole('button', { name: 'delete' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();

  // reopen, cancel via the backdrop
  fireEvent.click(screen.getByRole('button', { name: 'delete' }));
  fireEvent.click(document.querySelector('.modal-backdrop')!);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});
