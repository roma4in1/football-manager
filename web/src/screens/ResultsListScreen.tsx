/**
 * season → results: revealed matchweeks, newest first; tap a score line for
 * match detail. Post-reveal only — the endpoint's SQL embargo is the gate.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Me, type ResultsView } from '../api.ts';

export function ResultsListScreen({ me }: { me: Me }) {
  const [view, setView] = useState<ResultsView | null>(null);

  useEffect(() => {
    void api.results().then(setView);
  }, []);

  if (!view) return <p className="muted">Loading…</p>;
  const weeks = view.matchweeks.filter((w) => w.fixtures.length > 0);
  if (weeks.length === 0) return <p className="muted">No results revealed yet — the first week is still playing.</p>;
  const name = (id: string) => view.clubNames[id] ?? '?';

  return (
    <div>
      {weeks.map((w) => (
        <div className="card tight" key={w.number}>
          <h3>{w.kind === 'playoff' ? `Playoffs — week ${w.number}` : `Matchweek ${w.number}`}</h3>
          <ul className="status-list">
            {w.fixtures.map((f) => {
              const mine = f.home === me.club.id || f.away === me.club.id;
              return (
                <li key={f.fixtureId}>
                  <Link className={`result-line${mine ? ' mine' : ''}`} to={`/season/match/${f.fixtureId}`}>
                    <span className="result-club home">{name(f.home)}</span>
                    <span className="result-score">{f.score[0]}–{f.score[1]}</span>
                    <span className="result-club">{name(f.away)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
