import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Me, type ReplayView, type ResultView } from '../api.ts';
import { ReplayViewer } from '../replay/ReplayViewer.tsx';

export function ReplayScreen({ me }: { me: Me }) {
  const { fixtureId } = useParams<{ fixtureId: string }>();
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [result, setResult] = useState<ResultView | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!fixtureId) return;
    Promise.all([api.replay(fixtureId), api.result(fixtureId)])
      .then(([rp, rs]) => {
        setReplay(rp);
        setResult(rs);
      })
      .catch(() => setError(true));
  }, [fixtureId]);

  if (error) {
    return (
      <main>
        <p className="error">Replay not available (embargoed, pruned, or unknown fixture).</p>
      </main>
    );
  }
  if (!replay || !result) return <main><p className="muted">Loading…</p></main>;

  const weAreHome = replay.home === me.club.id;
  const weParticipate = weAreHome || replay.away === me.club.id;
  const homeName = weParticipate ? (weAreHome ? me.club.name : 'Opponent') : 'Home';
  const awayName = weParticipate ? (weAreHome ? 'Opponent' : me.club.name) : 'Away';

  return (
    <main>
      <h1>Replay</h1>
      <ReplayViewer
        halves={replay.halves}
        events={result.halves.flatMap((h) => h.events)}
        statsByHalf={Object.fromEntries(result.halves.map((h) => [h.half, h.stats]))}
        names={result.players}
        homePlayerIds={replay.homePlayers}
        homeName={homeName}
        awayName={awayName}
      />
      <p>
        <Link to={`/result/${fixtureId}`}>← Full result</Link>
      </p>
    </main>
  );
}
