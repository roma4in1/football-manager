import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Me, type ResultView } from '../api.ts';
import { Ratings, StatsTable } from '../components.tsx';
import { eventLines } from '../format.ts';

export function ResultScreen({ me }: { me: Me }) {
  const { fixtureId } = useParams<{ fixtureId: string }>();
  const [view, setView] = useState<ResultView | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!fixtureId) return;
    api.result(fixtureId).then(setView, () => setError(true));
  }, [fixtureId]);

  if (error) return <main><p className="error">Result not available (embargoed or unknown fixture).</p></main>;
  if (!view) return <main><p className="muted">Loading…</p></main>;

  const weAreHome = view.home === me.club.id;
  const weParticipate = weAreHome || view.away === me.club.id;
  const homeName = weParticipate ? (weAreHome ? me.club.name : 'Opponent') : 'Home';
  const awayName = weParticipate ? (weAreHome ? 'Opponent' : me.club.name) : 'Away';
  const allEvents = view.halves.flatMap((h) => h.events);

  return (
    <main>
      <h1>
        Full time · {view.finalScore[0]}–{view.finalScore[1]}
      </h1>

      <section>
        <h3>Timeline</h3>
        <ul className="timeline">
          {eventLines(allEvents, view.players).map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}
        </ul>
      </section>

      {view.halves.map((h) => (
        <details key={h.half} open={h.half === 2}>
          <summary>Half {h.half} stats</summary>
          <StatsTable stats={h.stats} homeName={homeName} awayName={awayName} />
          <h4>Ratings</h4>
          <Ratings ratings={h.stats.playerRatings} names={view.players} />
        </details>
      ))}
    </main>
  );
}
