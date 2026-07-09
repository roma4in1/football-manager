import { useEffect, useState } from 'react';
import { api, type PlayoffTieView, type PlayoffsView } from '../api.ts';

const ROUND_LABEL: Record<PlayoffTieView['round'], string> = {
  semi1: 'Semifinal — 1 v 4',
  semi2: 'Semifinal — 2 v 3',
  final: 'Final (neutral venue)',
};

export function BracketScreen() {
  const [view, setView] = useState<PlayoffsView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api.playoffs().then(setView, () => setMissing(true));
  }, []);

  if (missing) {
    return (
      <main>
        <h1>Playoffs</h1>
        <p className="muted">The top-4 bracket appears once the regular season completes.</p>
      </main>
    );
  }
  if (!view) return <main><p className="muted">Loading…</p></main>;

  const name = (id: string | null) => (id ? view.clubNames[id] ?? '?' : '—');

  const tieCard = (tie: PlayoffTieView) => {
    // leg 1 hosted by the LOW seed, leg 2 (decisive) by the HIGH seed; the
    // final is one neutral match under leg 1
    const homeOf = (i: number) => (tie.round === 'final' || i === 1 ? tie.highSeedClubId : tie.lowSeedClubId);
    const awayOf = (i: number) => (homeOf(i) === tie.highSeedClubId ? tie.lowSeedClubId : tie.highSeedClubId);
    const agg: Record<string, number> = { [tie.highSeedClubId]: 0, [tie.lowSeedClubId]: 0 };
    for (const [i, leg] of tie.legs.entries()) {
      if (leg.score) {
        agg[homeOf(i)] += leg.score[0];
        agg[awayOf(i)] += leg.score[1];
      }
    }
    return (
      <div className="card" key={tie.round}>
        <h2>{ROUND_LABEL[tie.round]}</h2>
        <p>
          <strong>({tie.highSeed}) {name(tie.highSeedClubId)}</strong> vs{' '}
          <strong>({tie.lowSeed}) {name(tie.lowSeedClubId)}</strong>
          {tie.round !== 'final' && tie.legs.every((l) => l.score) && (
            <> — aggregate {agg[tie.highSeedClubId]}–{agg[tie.lowSeedClubId]}</>
          )}
        </p>
        {tie.legs.map((leg, i) => (
          <p key={leg.fixtureId} className="muted">
            {tie.round === 'final' ? 'Match' : `Leg ${i + 1}`}: {name(homeOf(i))}{' '}
            {leg.score ? `${leg.score[0]}–${leg.score[1]}` : 'v'} {name(awayOf(i))}
          </p>
        ))}
        {tie.shootout && (
          <details>
            <summary>
              Penalties: {tie.shootout.score[0]}–{tie.shootout.score[1]}
              {tie.shootout.suddenDeath ? ' (sudden death)' : ''} — {name(tie.shootout.winnerClubId)} win
            </summary>
            <ol className="status-list">
              {tie.shootout.kicks.map((k) => (
                <li key={k.n}>
                  {view.playerNames[k.playerId] ?? k.playerId}: {k.scored ? 'scored' : 'MISSED'}
                </li>
              ))}
            </ol>
          </details>
        )}
        {tie.winnerClubId && <p><strong>{name(tie.winnerClubId)}</strong> advance</p>}
      </div>
    );
  };

  const order: PlayoffTieView['round'][] = ['semi1', 'semi2', 'final'];
  return (
    <main>
      <h1>Playoffs</h1>
      {view.champion && (
        <p className="champion">🏆 <strong>{name(view.champion)}</strong> are the champions</p>
      )}
      {order.map((r) => view.ties.find((t) => t.round === r)).filter((t): t is PlayoffTieView => !!t).map(tieCard)}
    </main>
  );
}
