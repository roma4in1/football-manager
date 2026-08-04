/**
 * LeaguesHub — the account's leagues, and the switch between them.
 * Accounts arc phase 3 step 4 (LOBBY-DESIGN-SPEC §4/§5).
 *
 * IT RENDERS OUTSIDE `.app`, DELIBERATELY. styles.css hides `.app` on a
 * portrait phone behind the rotate overlay, and an account with NO leagues has
 * this as its only screen — inside `.app` it would be the exact dead end
 * AccountLanding was. It is also a chooser you pass THROUGH on the way into the
 * game, the same category as the create-club screen and the landing page, not
 * one of the always-landscape two-pane screens.
 *
 * NOT STYLED AHEAD OF THE DESIGN PASS. DESIGN-BRIEF.md says the pass styles the
 * app's final screens in one coherent go; this is functional plumbing in the
 * existing visual language (the auth frame, `.card`, the standard buttons) and
 * adds no new visual vocabulary.
 *
 * Creating and joining leagues is PHASE 4 — the empty state says so plainly
 * rather than offering a button that does not exist.
 */

import { useState } from 'react';
import { api, type Me } from '../api.ts';
import { ClubBadge } from '../data.tsx';
import { useToast } from '../ui.tsx';

export function LeaguesHub({ me, onSwitched, onLogout }: {
  me: Me;
  onSwitched: () => void;
  onLogout?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const choose = async (leagueId: string): Promise<void> => {
    if (leagueId === me.selectedLeagueId) { onSwitched(); return; }
    setBusy(leagueId);
    setError(null);
    try {
      await api.selectLeague(leagueId);
      toast('League switched', 'success');
      onSwitched(); // App re-fetches /me; club, season and every screen follow
    } catch {
      setError('Could not switch league, try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="narrow auth leagues-hub">
      <h1 className="auth-brand"><a href="/">FM League</a></h1>

      <div className="card">
        <h2>Your leagues</h2>
        {me.leagues.length === 0 ? (
          <p className="muted">
            You aren't in a league yet. Creating one and joining by code arrives in the next
            update — your club <strong>{me.clubIdentity?.name ?? 'is ready'}</strong> is set up and waiting.
          </p>
        ) : (
          <ul className="league-list">
            {me.leagues.map((l) => {
              const selected = l.id === me.selectedLeagueId;
              return (
                <li key={l.id}>
                  <button
                    className={`league-row${selected ? ' selected' : ''}`}
                    onClick={() => void choose(l.id)}
                    disabled={busy !== null}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <ClubBadge name={l.clubName} identity={me.clubIdentity} size={30} />
                    <span className="league-row-text">
                      <span className="league-name">{l.name}</span>
                      <span className="league-meta muted">{l.clubName} · {l.status}</span>
                    </span>
                    <span className="league-row-cta">
                      {busy === l.id ? '…' : selected ? 'Open' : 'Switch'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      {onLogout && (
        <div className="auth-switch">
          <button className="ghost" onClick={onLogout}>Sign out</button>
        </div>
      )}
    </main>
  );
}
