/**
 * Account — the signed-in surface reachable from inside the game.
 *
 * IT RENDERS OUTSIDE `.app`, like the Leagues Hub and create-club. styles.css
 * hides `.app` on a portrait phone behind the rotate overlay, and SIGNING OUT IS
 * EXACTLY THE ACTION THAT MUST NOT REQUIRE ROTATING THE PHONE — a manager who
 * wants out should not have to hold their phone a particular way to get out.
 *
 * ONLY WHAT EXISTS TODAY. Every row here is backed by something already shipped:
 * the account's email (/me), the club identity (phase 2, with an editor that was
 * built and then unreachable — see below), the selected league (phase 3), and
 * the logout route (phase 1). No profile screen, no settings screen: nothing
 * real backs either yet, and an empty screen is worse than an absent one.
 *
 * NOT STYLED AHEAD OF THE DESIGN PASS — `.card`, the standard button and the
 * existing tokens only, no new primitives.
 */

import { Link } from 'react-router-dom';
import type { Me } from '../api.ts';
import { ClubBadge } from '../data.tsx';

export function Account({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const league = me.leagues.find((l) => l.id === me.selectedLeagueId) ?? null;

  return (
    <main className="narrow auth account">
      <h1 className="auth-brand"><a href="/">FM League</a></h1>

      <div className="card">
        <h2>Account</h2>
        <p className="muted account-email">
          Signed in as <strong>{me.manager.email}</strong>
        </p>

        <h3>Your club</h3>
        {me.clubIdentity ? (
          <div className="account-row">
            <ClubBadge name={me.clubIdentity.name} identity={me.clubIdentity} size={34} />
            <span className="account-row-text">
              <span className="account-row-title">{me.clubIdentity.name}</span>
              <span className="muted account-row-meta">travels with you into every league</span>
            </span>
            {/* the editor has existed since phase 2 and nothing routed to it */}
            <Link className="button" to="/account/club">Edit</Link>
          </div>
        ) : (
          <p className="muted">No club yet.</p>
        )}

        <h3>League</h3>
        {league ? (
          <div className="account-row">
            <span className="account-row-text">
              <span className="account-row-title">{league.name}</span>
              <span className="muted account-row-meta">{league.clubName} · {league.status}</span>
            </span>
            {me.leagues.length > 1 && <Link className="button" to="/leagues">Switch</Link>}
          </div>
        ) : (
          <p className="muted">You aren't in a league yet.</p>
        )}
      </div>

      <div className="card">
        <h3>Sign out</h3>
        <p className="muted account-signout-note">
          Ends this session on this device. Your club and leagues are untouched.
        </p>
        <button className="danger account-signout" onClick={onLogout}>Sign out</button>
      </div>

      <div className="auth-switch">
        {me.club && me.season && <Link className="button ghost" to="/">Back to the game</Link>}
      </div>
    </main>
  );
}
