/**
 * Match detail (DESIGN-SPEC): score header always visible; three tabs —
 * timeline (lands first: minute/icon/line rows, "watch" jump-buttons on
 * goals), replay (the canvas viewer, cued 6s before a tapped moment), stats
 * (team-level per half). Embargo-gated by the SAME endpoints as ever:
 * /result 404s until allowed; the replay tab degrades gracefully when
 * frames are pruned. Individual player stats live in the squad hub, not here.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { MatchEvent } from '@fm/engine/types';
import { api, type Me, type ReplayView, type ResultView } from '../api.ts';
import { Ratings, StatsTable } from '../components.tsx';
import { eventLabel, minuteOf } from '../format.ts';
import { ReplayViewer } from '../replay/ReplayViewer.tsx';

type Tab = 'timeline' | 'replay' | 'stats';

const TIMELINE_TYPES = new Set(['goal', 'card', 'injury', 'sub']);
const ICON: Record<string, string> = { goal: '⚽', card: '🟨', injury: '✚', sub: '⇄' };

export function MatchDetailScreen({ me }: { me: Me }) {
  const { fixtureId } = useParams<{ fixtureId: string }>();
  const [view, setView] = useState<ResultView | null>(null);
  const [replay, setReplay] = useState<ReplayView | 'unavailable' | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('timeline');
  const [cueT, setCueT] = useState<number | null>(null);

  useEffect(() => {
    if (!fixtureId) return;
    api.result(fixtureId).then(setView, () => setError(true));
    api.replay(fixtureId).then(setReplay, () => setReplay('unavailable'));
  }, [fixtureId]);

  if (error) return <main><p className="error">Match not available (embargoed or unknown fixture).</p></main>;
  if (!view) return <main><p className="muted">Loading…</p></main>;

  const weAreHome = view.home === me.club.id;
  const weParticipate = weAreHome || view.away === me.club.id;
  const homeName = weParticipate ? (weAreHome ? me.club.name : 'Opponent') : 'Home';
  const awayName = weParticipate ? (weAreHome ? 'Opponent' : me.club.name) : 'Away';
  const allEvents = view.halves.flatMap((h) => h.events);
  const rows = allEvents.filter((e) => TIMELINE_TYPES.has(e.type));

  const watch = (e: MatchEvent) => {
    setTab('replay');
    setCueT(e.t);
  };

  return (
    <main className="match-detail">
      {/* the hero: never scrolls */}
      <div className="match-head">
        <span className="replay-team home">{homeName}</span>
        <span className="replay-score">{view.finalScore[0]}–{view.finalScore[1]}</span>
        <span className="replay-team away">{awayName}</span>
        <span className="muted">FT</span>
        <div className="tabs" style={{ marginLeft: 'auto' }}>
          {(['timeline', 'replay', 'stats'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>

      <div className="match-body">
        {tab === 'timeline' && (
          <ul className="timeline">
            {rows.map((e, i) => (
              <li key={`${e.t}-${i}`} className="timeline-row">
                <span className="timeline-min">{minuteOf(e.t)}'</span>
                <span className="timeline-icon">{e.type === 'card' && e.meta?.card === 'red' ? '🟥' : ICON[e.type] ?? '·'}</span>
                <span className="grow">{eventLabel(e, view.players)}</span>
                {e.type === 'goal' && replay !== 'unavailable' && (
                  <button className="watch" onClick={() => watch(e)}>▶ watch</button>
                )}
              </li>
            ))}
            {rows.length === 0 && <li className="muted">A quiet one — no goals, cards or injuries.</li>}
          </ul>
        )}

        {tab === 'replay' && (
          replay && replay !== 'unavailable' ? (
            <ReplayViewer
              halves={replay.halves}
              events={allEvents}
              statsByHalf={Object.fromEntries(view.halves.map((h) => [h.half, h.stats]))}
              names={view.players}
              homePlayerIds={replay.homePlayers}
              homeName={homeName}
              awayName={awayName}
              cueT={cueT}
            />
          ) : (
            <p className="muted">Replay unavailable (frames pruned after four matchweeks).</p>
          )
        )}

        {tab === 'stats' && (
          <div>
            {view.halves.map((h) => (
              <div className="card tight" key={h.half}>
                <h3>Half {h.half}</h3>
                <StatsTable stats={h.stats} homeName={homeName} awayName={awayName} />
                <details>
                  <summary>Ratings</summary>
                  <Ratings ratings={h.stats.playerRatings} names={view.players} />
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
