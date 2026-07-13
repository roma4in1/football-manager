/**
 * Shared interaction primitives — the reusable feel layer the whole app (and
 * the upcoming lobby/account screens) inherits. In-memory / React-state only,
 * no browser storage. Three pieces:
 *   • toasts       — small, non-blocking confirmations ("Bid placed") that
 *                    stack bottom-center and auto-dismiss.
 *   • ActionButton — a button that owns the pending → success feel of an async
 *                    action so every submit/bid/save reads the same way.
 *   • ConfirmDialog — a blocking modal reserved for the irreversible actions
 *                    (an irretractable bid, the final lineup, deleting a preset).
 * Fast (~110–170ms), never bouncy; motion is honored/neutralized in styles.css.
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react';

/* ── toasts ─────────────────────────────────────────────────────────────── */

export type ToastTone = 'default' | 'success' | 'danger' | 'accent';
interface Toast { id: number; message: string; tone: ToastTone; leaving: boolean }

interface ToastApi { toast: (message: string, tone?: ToastTone) => void }

/** A working no-op default so a component can call useToast() outside a
 *  provider (e.g. in unit tests) without crashing. */
const ToastContext = createContext<ToastApi>({ toast: () => {} });

export const useToast = (): ToastApi => useContext(ToastContext);

const TOAST_MS = 2600;
const TOAST_LEAVE_MS = 180;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const t = setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), TOAST_LEAVE_MS);
    timers.current.set(-id, t);
  }, []);

  const toast = useCallback<ToastApi['toast']>((message, tone = 'default') => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, message, tone, leaving: false }]);
    const t = setTimeout(() => remove(id), TOAST_MS);
    timers.current.set(id, t);
  }, [remove]);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.tone}${t.leaving ? ' leaving' : ''}`}
            onClick={() => remove(t.id)}
          >
            <span className="toast-dot" aria-hidden="true" />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ── ActionButton ───────────────────────────────────────────────────────── */

type ActionStatus = 'idle' | 'pending' | 'success';

export interface ActionButtonProps {
  onAct: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  /** brief success flash before returning to idle (ms) */
  successMs?: number;
  /** label swapped in during the success flash (children stay if omitted) */
  successLabel?: ReactNode;
}

/**
 * Owns the pending → success feel for one async action. The accessible name
 * stays the button's label throughout (spinner/tick are decorative), so tests
 * and screen readers keep finding it. On rejection it falls back to idle and
 * lets the caller surface the error.
 */
export function ActionButton({
  onAct, children, className = '', disabled, type = 'button', title, successMs = 1100, successLabel,
}: ActionButtonProps) {
  const [status, setStatus] = useState<ActionStatus>('idle');
  const alive = useRef(true);
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { alive.current = false; if (flash.current) clearTimeout(flash.current); }, []);

  const run = async () => {
    if (status === 'pending') return;
    setStatus('pending');
    try {
      await onAct();
      if (!alive.current) return;
      setStatus('success');
      flash.current = setTimeout(() => { if (alive.current) setStatus('idle'); }, successMs);
    } catch {
      if (alive.current) setStatus('idle'); // caller reports the failure
    }
  };

  const cls = `${className} ${status === 'pending' ? 'is-pending' : status === 'success' ? 'is-success' : ''}`.trim();
  return (
    <button
      type={type}
      className={cls}
      title={title}
      disabled={disabled || status === 'pending'}
      aria-busy={status === 'pending'}
      onClick={type === 'submit' ? undefined : () => void run()}
    >
      {status === 'pending' && <span className="btn-spinner" aria-hidden="true" />}
      {status === 'success' && <span aria-hidden="true">✓</span>}
      {status === 'success' && successLabel ? successLabel : children}
    </button>
  );
}

/* ── ConfirmDialog ──────────────────────────────────────────────────────── */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Blocking confirmation for irreversible actions only. Escape and backdrop
 * cancel; the confirm button takes focus on open. Not for routine or
 * reversible actions — those stay one tap away.
 */
export function ConfirmDialog({
  open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', busy, onConfirm, onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={() => { if (!busy) onCancel(); }}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? 'danger solid' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <span className="btn-spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
