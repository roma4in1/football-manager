import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type HtView, type MeWithClub } from '../api.ts';
import { Countdown, Ratings, StatsTable } from '../components.tsx';
import { eventLines } from '../format.ts';
import { LineupEditor } from '../lineup/LineupEditor.tsx';

export function HalfTimeScreen({ me }: { me: MeWithClub }) {
  const { fixtureId } = useParams<{ fixtureId: string }>();
  const navigate = useNavigate();
  const [view, setView] = useState<HtView | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!fixtureId) return;
    api.ht(fixtureId).then(setView, () => setError(true));
  }, [fixtureId]);

  if (!fixtureId) return null;
  if (error) return <main><p className="error">Half-time report unavailable.</p></main>;
  if (!view) return <main><p className="muted">Loading…</p></main>;

  const weAreHome = view.home === me.club.id;
  const names = { home: weAreHome ? me.club.name : 'Opponent', away: weAreHome ? 'Opponent' : me.club.name };

  return (
    <main>
      <h1>
        Half-time · {view.score[0]}–{view.score[1]}
      </h1>
      {view.htDeadline && view.state === 'awaiting_ht' && (
        <p className="muted">
          Second half sims <Countdown until={view.htDeadline} />
        </p>
      )}

      <StatsTable stats={view.stats} homeName={names.home} awayName={names.away} />

      <section>
        <h3>First-half events</h3>
        <ul className="timeline">
          {eventLines(view.events, view.players).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>

      <details>
        <summary>Player ratings</summary>
        <Ratings ratings={view.stats.playerRatings} names={view.players} />
      </details>

      {view.state === 'awaiting_ht' && (
        <section>
          <h2>Second-half changes</h2>
          <LineupEditor fixtureId={fixtureId} half={2} onSubmitted={() => void navigate('/')} />
        </section>
      )}
    </main>
  );
}
