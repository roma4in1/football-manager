import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Me, type MatchweekView } from '../api.ts';
import { Countdown } from '../components.tsx';

/** Waiting states poll every 30s (no websockets in v0 — DECISIONS.md). */
const POLL_MS = 30_000;

export function Home({ me }: { me: Me }) {
  const [view, setView] = useState<MatchweekView | null>(null);
  const inAuction = me.season.phase === 'auction';

  const load = useCallback(async () => {
    setView(await api.matchweekCurrent());
  }, []);

  useEffect(() => {
    if (!inAuction) void load();
  }, [load, inAuction]);

  const fx = view?.fixture ?? null;
  const waiting =
    !!fx && (fx.state === 'scheduled' || fx.state === 'awaiting_ht' || (fx.state === 'final' && !view?.matchweek.revealedAt));

  useEffect(() => {
    if (!waiting) return;
    const iv = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(iv);
  }, [waiting, load]);

  if (inAuction) {
    return (
      <main>
        <h1>Season auction in progress</h1>
        <p>Build your squad before the season can start.</p>
        <Link className="button primary" to="/auction">Enter the auction room</Link>
      </main>
    );
  }

  if (!view) return <p className="muted">Loading…</p>;
  const mw = view.matchweek;

  return (
    <main>
      <h1>Matchweek {mw.number}{mw.kind === 'transfer' ? ' — transfer window' : ''}</h1>
      <p className="muted">
        Deadline <Countdown until={mw.deadlineAt} /> {mw.revealedAt ? '· results revealed' : ''}
      </p>

      {!fx && <p>No fixture for you this week{mw.kind === 'transfer' ? ' — recovery week' : ''}.</p>}

      {fx && (
        <section className="card">
          <h2>
            {fx.home.name} vs {fx.away.name}
          </h2>
          <p className="muted">state: {fx.state}</p>
          <ul className="status-list">
            <li>Your lineup: {fx.submissions.you.half1 ? '✓ submitted' : '— not submitted'}</li>
            <li>Opponent lineup: {fx.submissions.opponent.half1 ? '✓ submitted' : '— not submitted'}</li>
            {fx.state !== 'scheduled' && (
              <>
                <li>Your HT changes: {fx.submissions.you.half2 ? '✓ submitted' : '— carry half 1'}</li>
                <li>Opponent HT changes: {fx.submissions.opponent.half2 ? '✓ submitted' : '— carry half 1'}</li>
              </>
            )}
          </ul>

          {fx.state === 'scheduled' && (
            <Link className="button primary" to={`/lineup/${fx.id}`}>
              {fx.submissions.you.half1 ? 'Edit lineup' : 'Submit lineup'}
            </Link>
          )}
          {fx.state === 'awaiting_ht' && (
            <>
              {fx.htDeadline && (
                <p>
                  Half-time — second half sims in <Countdown until={fx.htDeadline} />
                </p>
              )}
              <Link className="button primary" to={`/ht/${fx.id}`}>Half-time decisions</Link>
            </>
          )}
          {fx.state === 'final' && !mw.revealedAt && (
            <>
              <p>Full time. Results are embargoed until the week closes.</p>
              <Link className="button" to={`/result/${fx.id}`}>View your result</Link>
            </>
          )}
          {fx.state === 'final' && mw.revealedAt && (
            <Link className="button primary" to={`/result/${fx.id}`}>View result</Link>
          )}
        </section>
      )}

      <p className="muted">Signed in as {me.manager.displayName} — {me.club.name}</p>
    </main>
  );
}
