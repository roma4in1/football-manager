/**
 * ResetPassword — the /reset?token=… landing (LOBBY-DESIGN-SPEC §3). Reached
 * from the emailed link; renders for a logged-OUT visitor. /reset is an SPA
 * route, so the service-worker /api/* navigation denylist is unaffected (the
 * reset POST goes to /api/auth/reset-password, which is not a navigation).
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { ActionButton, useToast } from '../ui.tsx';

const MIN_PW = 8;

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { toast } = useToast();

  if (!token) {
    return (
      <main className="narrow auth">
        <h1 className="auth-brand">FM League</h1>
        <div className="card">
          <h2>Invalid link</h2>
          <p className="muted">This reset link is missing its token. Request a new one from the sign-in page.</p>
          <a className="button" href="/">Back to sign in</a>
        </div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="narrow auth">
        <h1 className="auth-brand">FM League</h1>
        <div className="card">
          <h2>Password updated</h2>
          <p className="muted">Sign in with your new password.</p>
          <a className="button primary" href="/">Sign in</a>
        </div>
      </main>
    );
  }

  const mismatch = !!password && !!confirm && password !== confirm;
  const canSubmit = password.length >= MIN_PW && password === confirm;

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api.resetPassword(token, password);
      toast('Password updated', 'success');
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.body.error === 'invalid_or_expired_token'
          ? 'This link has expired or was already used. Request a new one.'
          : err instanceof ApiError && err.body.error === 'weak_password'
            ? `Use at least ${MIN_PW} characters.`
            : 'Could not reset your password, try again.',
      );
      throw err;
    }
  };

  return (
    <main className="narrow auth">
      <h1 className="auth-brand">FM League</h1>
      <form className="card auth-card" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit().catch(() => {}); }}>
        <h2>Choose a new password</h2>
        <label className="field">
          New password
          <input
            type="password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder={`at least ${MIN_PW} characters`}
          />
        </label>
        <label className="field">
          Confirm password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {mismatch && <p className="error">Passwords don't match.</p>}
        {error && <p className="error">{error}</p>}
        <ActionButton className="primary auth-cta" onAct={submit} disabled={!canSubmit}>Set new password</ActionButton>
      </form>
    </main>
  );
}
