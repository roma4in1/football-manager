/**
 * LeaguesHub — the account's leagues, the switch between them, and the two acts
 * that make one exist: CREATE and JOIN BY CODE.
 * Accounts arc phase 3 step 4 + phase 4 (LOBBY-DESIGN-SPEC §4/§5).
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
 * A LEAGUE IN `lobby` OPENS ITS LOBBY RATHER THAN THE GAME, because it has no
 * season to open — selecting it and landing back here would be a loop.
 *
 * AND A POOL THAT COPIED NOTHING IS SAID AT CREATION. `copyPoolInto` can
 * honestly return `none` on a database with no templates and no other league;
 * such a league cannot run an auction, and it must fail loudly when it is made
 * rather than when the auction opens.
 */

import { useState } from 'react';
import { api, ApiError, type Me } from '../api.ts';
import { ClubBadge } from '../data.tsx';
import { useToast } from '../ui.tsx';
import { LeagueLobby } from './LeagueLobby.tsx';

/** Why a join failed, in the words of the person who typed the code. A typo is
 *  the common case and a raw 404 is the worst possible answer to it. */
function joinMessage(code: string | null | undefined, typed: string): string {
  switch (code) {
    case 'not_found':
      return `No league has the code ${typed.trim().toUpperCase()}. Codes are 6 characters — check it with whoever sent it.`;
    case 'league_started': return 'That league has already started its season, so it is closed to new clubs.';
    case 'already_joined': return "You're already in that league — it's in your list above.";
    case 'league_full': return 'That league is full.';
    case 'club_name_taken': return 'A club in that league already has that name. Try another.';
    case 'code_required': return 'Enter the code you were given.';
    case 'club_name_required': return 'Give your club a name first.';
    default: return 'Could not join, try again.';
  }
}

export function LeaguesHub({ me, onSwitched, onLogout }: {
  me: Me;
  onSwitched: () => void;
  onLogout?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState(8);
  const [clubName, setClubName] = useState(me.clubIdentity?.name ?? '');
  const [code, setCode] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** set when the pool copied NOTHING — the league exists and cannot start */
  const [poolWarning, setPoolWarning] = useState<string | null>(null);
  /** null = follow the selection; an id = that lobby; 'list' = back out of one */
  const [open, setOpen] = useState<string | 'list' | null>(null);

  // THE LOBBY OPENS FOR A LEAGUE THAT IS IN ONE, and for no other. Reading the
  // status from /me rather than from `open` is what closes it again the moment
  // the host starts: the league turns 'active' there, and the screen follows.
  const target = open === 'list' ? null
    : me.leagues.find((l) => l.id === (open ?? me.selectedLeagueId)) ?? null;
  const lobbyId = target?.status === 'lobby' ? target.id : null;

  const choose = async (leagueId: string): Promise<void> => {
    setOpen(null);
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

  const create = async (): Promise<void> => {
    setBusy('create');
    setCreateError(null);
    setPoolWarning(null);
    try {
      const made = await api.createLeague(name.trim(), capacity, clubName.trim() || undefined);
      await api.selectLeague(made.leagueId);
      if (made.pool.source === 'none') {
        // THE RULING: a league that cannot run is said HERE. It also HOLDS THIS
        // SCREEN — walking straight into the lobby would unmount the sentence in
        // the same tick that produced it, and "shown at creation" would be true
        // of the code and false of the experience. The lobby says it again and
        // blocks the start; this is the sentence that arrives first.
        setPoolWarning(
          `${name.trim()} was created, but no players could be copied into it — it cannot run an auction. `
          + 'The player pool needs to be restored before a league can start.',
        );
        setOpen('list');
      } else {
        toast(`${made.pool.copied} players copied into ${name.trim()}`, 'success');
        setOpen(made.leagueId);
      }
      setName('');
      onSwitched();
    } catch (err) {
      const c = err instanceof ApiError ? err.body.error : null;
      setCreateError(
        c === 'name_required' ? 'Give the league a name.'
          : c === 'club_name_taken' ? 'You already have a club with that name here. Try another.'
          : c === 'club_name_required' ? 'Give your club a name.'
          // the host is identified by ACCOUNT — a session without one could never
          // start what it created, so the server refuses to create it
          : c === 'no_account' ? "This sign-in isn't linked to an account yet — sign out and sign in again."
            : 'Could not create the league, try again.',
      );
    } finally {
      setBusy(null);
    }
  };

  const join = async (): Promise<void> => {
    setBusy('join');
    setJoinError(null);
    try {
      const joined = await api.joinLeague(code, clubName.trim() || undefined);
      await api.selectLeague(joined.leagueId);
      toast(`Joined ${joined.name}`, 'success');
      setCode('');
      setOpen(joined.leagueId);
      onSwitched();
    } catch (err) {
      setJoinError(joinMessage(err instanceof ApiError ? err.body.error : null, code));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="narrow auth leagues-hub">
      <h1 className="auth-brand"><a href="/">FM League</a></h1>

      {lobbyId ? (
        <LeagueLobby
          leagueId={lobbyId}
          me={me}
          onStarted={onSwitched}
          // always offered, even from a single league: the list behind it is
          // also where create and join live, and a lobby you cannot leave is a
          // manager who cannot start a second league while waiting on the first
          onBack={() => setOpen('list')}
        />
      ) : (
        <>
          <div className="card">
            <h2>Your leagues</h2>
            {me.leagues.length === 0 ? (
              <p className="muted">
                You aren't in a league yet. Create one and share its code, or join with a
                code someone sent you.
              </p>
            ) : (
              <ul className="league-list">
                {me.leagues.map((l) => {
                  const isSelected = l.id === me.selectedLeagueId;
                  return (
                    <li key={l.id}>
                      <button
                        className={`league-row${isSelected ? ' selected' : ''}`}
                        onClick={() => void choose(l.id)}
                        disabled={busy !== null}
                        aria-current={isSelected ? 'true' : undefined}
                      >
                        <ClubBadge name={l.clubName} identity={me.clubIdentity} size={30} />
                        <span className="league-row-text">
                          <span className="league-name">{l.name}</span>
                          <span className="league-meta muted">{l.clubName} · {l.status}</span>
                        </span>
                        <span className="league-row-cta">
                          {busy === l.id ? '…'
                            : l.status === 'lobby' ? 'Lobby'
                              : isSelected ? 'Open' : 'Switch'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && <p className="error">{error}</p>}
          </div>

          <div className="card">
            <h2>Start a league</h2>
            <label>
              League name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="Sunday League"
              />
            </label>
            <label>
              Clubs
              <select value={capacity} onChange={(e) => setCapacity(Number(e.target.value))}>
                {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              You can start as soon as two clubs have joined — the number above is the most
              it will hold, not the number you have to wait for.
            </p>
            <button
              className="primary"
              onClick={() => void create()}
              disabled={busy !== null || !name.trim()}
            >
              {busy === 'create' ? 'Creating…' : 'Create league'}
            </button>
            {createError && <p className="error">{createError}</p>}
            {poolWarning && <p className="error">{poolWarning}</p>}
          </div>

          <div className="card">
            <h2>Join with a code</h2>
            <label>
              Join code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={8}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="ABC123"
              />
            </label>
            <button
              className="primary"
              onClick={() => void join()}
              disabled={busy !== null || !code.trim()}
            >
              {busy === 'join' ? 'Joining…' : 'Join league'}
            </button>
            {joinError && <p className="error">{joinError}</p>}
          </div>

          <div className="card">
            <h2>The club you'll enter with</h2>
            <label>
              Club name
              <input
                value={clubName}
                onChange={(e) => setClubName(e.target.value)}
                maxLength={40}
                placeholder="Your club"
              />
            </label>
            <p className="muted">
              The name your club takes into the league you create or join above. Each league
              holds its own club, so a name already taken in one is free in another.
            </p>
          </div>
        </>
      )}

      {onLogout && (
        <div className="auth-switch">
          <button className="ghost" onClick={onLogout}>Sign out</button>
        </div>
      )}
    </main>
  );
}
