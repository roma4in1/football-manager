/**
 * LeagueLobby — who has joined, the code you hand to them, and the host's start.
 * Accounts arc phase 4 (LOBBY-DESIGN-SPEC §4/§5).
 *
 * IT RENDERS INSIDE LeaguesHub'S FRAME, which is outside `.app` — a lobby is a
 * screen you pass THROUGH on the way into the game, in the same category as the
 * chooser that owns it, and an account whose only league is a lobby would hit
 * the same portrait dead end otherwise.
 *
 * NOT STYLED AHEAD OF THE DESIGN PASS — the auth frame, `.card` and the standard
 * buttons, no new visual vocabulary.
 *
 * TWO RULINGS ARE VISIBLE HERE AND NEITHER IS COSMETIC:
 *  · CAPACITY IS A CEILING, NOT A QUORUM. The start unlocks at TWO clubs, which
 *    is setupSeason's own floor; the count reads "3 of 8 joined" so the ceiling
 *    is still legible. A league that waits for a tenth manager who never arrives
 *    is worse than a four-club league that plays.
 *  · AN EMPTY POOL BLOCKS THE START, and says so here rather than at the
 *    auction. `poolCount` is recomputed on every read, so this is the league's
 *    live supply and not a flag written once at creation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type LobbyView, type Me } from '../api.ts';
import { ClubBadge } from '../data.tsx';
import { useToast } from '../ui.tsx';

/** The code is the ONE string a human reads out to another human. */
function JoinCode({ code }: { code: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast('Join code copied', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard is refused on an insecure origin and in some embedded
      // browsers — the code is selectable text either way, so say that
      // instead of failing silently.
      toast('Copy blocked by the browser — select the code and copy it', 'danger');
    }
  };
  return (
    <p className="join-code-line">
      <code className="join-code">{code}</code>
      <button className="ghost" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
    </p>
  );
}

export function LeagueLobby({ leagueId, me, onStarted, onBack }: {
  leagueId: string;
  me: Me;
  onStarted: () => void;
  onBack?: () => void;
}) {
  const [view, setView] = useState<LobbyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { toast } = useToast();

  // THE OTHER MANAGERS ARE IN HERE WHEN THE HOST STARTS IT, and a lobby that
  // outlives its league is the one way this screen can strand someone. The poll
  // below sees the status leave 'lobby' and walks them into the season — once,
  // because the reload it triggers would otherwise fire on every tick.
  const left = useRef(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.leagueLobby(leagueId);
      setView(next);
      setError(null);
      if (next.status !== 'lobby' && !left.current) { left.current = true; onStarted(); }
    } catch {
      setError('Could not load the lobby, try again.');
    }
  }, [leagueId, onStarted]);

  // Managers join while the host watches, so the list has to move without a
  // reload. Ten seconds is slow enough to be free and fast enough that a code
  // read out loud is confirmed before the sentence ends.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      await api.startLeague(leagueId);
      await api.selectLeague(leagueId);
      toast('Season started — the auction is open', 'success');
      onStarted();
    } catch (err) {
      const code = err instanceof ApiError ? err.body.error : null;
      setError(
        code === 'need_two_clubs' ? 'A league needs at least two clubs to start.'
          : code === 'empty_pool' ? 'This league has no players, so it cannot run an auction.'
            : code === 'pool_insufficient' ? 'There are not enough players in this league for every club that has joined to fill a squad.'
              : code === 'already_started' ? 'This league has already started.'
                : code === 'not_host' ? 'Only the host can start the season.'
                  : 'Could not start the season, try again.',
      );
      void load();
    } finally {
      setStarting(false);
    }
  };

  if (!view) {
    return (
      <div className="card">
        <h2>Lobby</h2>
        <p className="muted">{error ?? 'Loading…'}</p>
        {onBack && <button className="ghost" onClick={onBack}>Back to your leagues</button>}
      </div>
    );
  }

  const full = view.clubs.length >= view.capacity;
  const blocker = view.poolCount === 0
    ? 'This league has no players, so it cannot run an auction. Nothing can start it — create another league, or ask for the player pool to be restored.'
    : view.clubs.length < 2
      ? 'Waiting for one more manager — a season needs at least two clubs.'
      : null;

  return (
    <div className="card">
      <h2>{view.name}</h2>
      <p className="muted">
        {view.clubs.length} of {view.capacity} joined
        {full ? ' — the league is full' : ''}
      </p>

      {view.joinCode && (
        <>
          <p className="muted">Anyone with this code can join until you start the season.</p>
          <JoinCode code={view.joinCode} />
        </>
      )}

      <ul className="league-list">
        {view.clubs.map((c) => (
          <li key={c.clubId}>
            <div className="league-row">
              <ClubBadge
                name={c.clubName}
                identity={c.managerId === me.manager.id ? me.clubIdentity : null}
                size={30}
              />
              <span className="league-row-text">
                <span className="league-name">{c.clubName}</span>
                <span className="league-meta muted">
                  {c.displayName}
                  {view.isHost && c.managerId === me.manager.id ? ' · host' : ''}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>

      {view.isHost ? (
        <>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={starting || blocker !== null}
          >
            {starting ? 'Starting…' : 'Start the season'}
          </button>
          {blocker && <p className="muted">{blocker}</p>}
        </>
      ) : (
        <p className="muted">The host starts the season when everyone is in.</p>
      )}

      {error && <p className="error">{error}</p>}
      {onBack && <button className="ghost" onClick={onBack}>Back to your leagues</button>}
    </div>
  );
}
