import { useState } from 'react';
import { api, ApiError } from '../api.ts';

export function Login() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sent' | 'rate_limited' | 'error'>('idle');

  const request = async (): Promise<void> => {
    try {
      await api.requestLink(email.trim());
      setState('sent');
    } catch (err) {
      setState(err instanceof ApiError && err.status === 429 ? 'rate_limited' : 'error');
    }
  };

  return (
    <main className="narrow">
      <h1>FM League</h1>
      {state === 'sent' ? (
        <p>
          Link sent. Check your email — or the server console, while real delivery is pending.
          Opening the link signs you in here.
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void request();
          }}
        >
          <label>
            Manager email
            <input
              type="email" required value={email} autoComplete="email"
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
            />
          </label>
          <button type="submit" className="primary">Send login link</button>
          {state === 'rate_limited' && <p className="error">Too many requests — wait a few minutes.</p>}
          {state === 'error' && <p className="error">Something went wrong, try again.</p>}
        </form>
      )}
    </main>
  );
}
