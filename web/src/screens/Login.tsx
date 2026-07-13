/**
 * Login — email + password accounts (LOBBY-DESIGN-SPEC §3). One card, three
 * modes: sign in, create account, forgot-password. Uses the design-system
 * primitives from the polish pass (ActionButton pending→success, toasts). On a
 * successful login/signup it calls onAuthed so App re-fetches /me and swaps in
 * the app (or the account placeholder for a brand-new, clubless account).
 */

import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { ActionButton, useToast } from '../ui.tsx';

type Mode = 'login' | 'signup' | 'forgot';
const MIN_PW = 8;

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.body.error) {
      case 'invalid_credentials': return 'Wrong email or password.';
      case 'email_taken': return 'That email already has an account — sign in instead.';
      case 'invalid_email': return 'Enter a valid email address.';
      case 'weak_password': return `Use at least ${MIN_PW} characters.`;
      case 'rate_limited': return 'Too many attempts — wait a few minutes.';
    }
  }
  return 'Something went wrong, try again.';
}

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { toast } = useToast();

  const go = (next: Mode) => { setMode(next); setError(null); };

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      if (mode === 'login') {
        await api.login(email.trim(), password);
        toast('Signed in', 'success');
        onAuthed();
      } else if (mode === 'signup') {
        await api.signup(email.trim(), password);
        toast('Account created', 'success');
        onAuthed();
      } else {
        await api.forgotPassword(email.trim());
        setSent(true);
      }
    } catch (err) {
      setError(messageFor(err));
      throw err; // let ActionButton fall back to idle
    }
  };

  if (mode === 'forgot' && sent) {
    return (
      <main className="narrow auth">
        <h1 className="auth-brand">FM League</h1>
        <div className="card">
          <h2>Check your inbox</h2>
          <p className="muted">
            If an account exists for <strong>{email.trim()}</strong>, a reset link is on its way.
            It expires in an hour.
          </p>
          <button onClick={() => { setSent(false); go('login'); }}>Back to sign in</button>
        </div>
      </main>
    );
  }

  const title = mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create your account' : 'Reset your password';
  const cta = mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Sign up' : 'Email me a reset link';
  const canSubmit = /\S+@\S+\.\S+/.test(email.trim()) && (mode === 'forgot' || password.length >= MIN_PW);

  return (
    <main className="narrow auth">
      <h1 className="auth-brand">FM League</h1>
      <form className="card auth-card" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit().catch(() => {}); }}>
        <h2>{title}</h2>
        <label className="field">
          Email
          <input
            type="email" autoComplete="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
          />
        </label>
        {mode !== 'forgot' && (
          <label className="field">
            Password
            <input
              type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? `at least ${MIN_PW} characters` : ''}
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <ActionButton className="primary auth-cta" onAct={submit} disabled={!canSubmit}>{cta}</ActionButton>
      </form>

      <div className="auth-switch">
        {mode === 'login' && <>
          <button className="ghost" onClick={() => go('signup')}>Create an account</button>
          <button className="ghost" onClick={() => go('forgot')}>Forgot password?</button>
        </>}
        {mode === 'signup' && <button className="ghost" onClick={() => go('login')}>I already have an account</button>}
        {mode === 'forgot' && <button className="ghost" onClick={() => go('login')}>Back to sign in</button>}
      </div>
    </main>
  );
}
