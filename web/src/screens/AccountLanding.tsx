/**
 * AccountLanding — where a logged-in account with NO club lands. Phase 1 of the
 * accounts arc has no club/league creation yet (Phases 2–4), so a brand-new
 * account sees this instead of the game. Seeded/claimed accounts have a club
 * and go straight to the app. Keeps "logged in" a visible, non-broken state.
 */

export function AccountLanding({ email, onLogout }: { email: string; onLogout: () => void }) {
  return (
    <div className="app">
      <main className="narrow auth">
        <h1 className="auth-brand">FM League</h1>
        <div className="card">
          <h2>You're signed in</h2>
          <p className="muted">
            Signed in as <strong>{email}</strong>. Creating a club and joining a league arrives in the next
            update — your account is ready for it.
          </p>
          <button onClick={onLogout}>Sign out</button>
        </div>
      </main>
    </div>
  );
}
