/**
 * home — triage (DESIGN-SPEC, 3 states: action-needed / waiting / reveal-day).
 * Two-column: the HERO fixture card never scrolls (opponent, deadline
 * countdown, submission status, the one primary action, basic opponent
 * scout); the secondary column scrolls in-box — "needs attention" surfaces
 * EXISTING state only (no generated advice), then "last week revealed".
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type FacilitiesView,
  type MatchweekView,
  type Me,
  type ResultsView,
  type SquadPlayerView,
  type StandingsRow,
  type TrainingView,
} from '../api.ts';
import { Countdown } from '../components.tsx';

const POLL_MS = 30_000;

export function Home({ me }: { me: Me }) {
  const [view, setView] = useState<MatchweekView | null>(null);
  const [squad, setSquad] = useState<SquadPlayerView[]>([]);
  const [facilities, setFacilities] = useState<FacilitiesView | null>(null);
  const [training, setTraining] = useState<TrainingView | null>(null);
  const [table, setTable] = useState<StandingsRow[]>([]);
  const [results, setResults] = useState<ResultsView | null>(null);
  const [scouting, setScouting] = useState(false);
  const inAuction = me.season.phase === 'auction';

  const load = useCallback(async () => {
    setView(await api.matchweekCurrent());
  }, []);

  useEffect(() => {
    if (inAuction) return;
    void load();
    api.squad().then((r) => setSquad(r.players), () => {});
    api.facilities().then(setFacilities, () => {});
    api.training().then(setTraining, () => {});
    api.standings().then((r) => setTable(r.table), () => {});
    api.results().then(setResults, () => {});
  }, [load, inAuction]);

  const fx = view?.fixture ?? null;
  const mw = view?.matchweek ?? null;
  const revealDay = !!mw?.revealedAt;
  const waiting =
    !!fx && (fx.state === 'awaiting_ht' || (fx.state === 'final' && !revealDay) || (fx.state === 'scheduled' && fx.submissions.you.half1));

  useEffect(() => {
    if (!waiting) return;
    const iv = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(iv);
  }, [waiting, load]);

  if (inAuction) {
    return (
      <div className="section">
        <div className="section-head"><h1>home</h1></div>
        <div className="card accent">
          <h2>The season auction is live</h2>
          <p className="muted">Build your squad before the season can start.</p>
          <Link className="button primary" to="/market/auction">Enter the auction room</Link>
        </div>
      </div>
    );
  }
  if (!view || !mw) return <p className="muted center">Loading…</p>;

  // ── hero pieces ────────────────────────────────────────────────────────────
  const opponentId = fx ? (fx.home.clubId === me.club.id ? fx.away.clubId : fx.home.clubId) : null;
  const opponentName = fx ? (fx.home.clubId === me.club.id ? fx.away.name : fx.home.name) : null;
  const venue = fx ? (fx.home.clubId === me.club.id ? 'home' : 'away') : null;
  const deadlineSoon = new Date(mw.deadlineAt).getTime() - Date.now() < 12 * 3_600_000;

  const oppRank = table.findIndex((r) => r.clubId === opponentId) + 1;
  const oppLast = (results?.matchweeks ?? [])
    .flatMap((w) => w.fixtures)
    .filter((f) => f.home === opponentId || f.away === opponentId)
    .slice(0, 3);

  // ── attention pieces (existing state only — never advice) ────────────────
  const suspended = squad.filter((p) => p.suspendedNext);
  const injured = squad.filter((p) => p.injuryWeeksLeft > 0);
  const affordable =
    facilities?.investmentOpen &&
    ((facilities.training.nextCost !== null && facilities.training.nextCost <= facilities.budgetRemaining) ||
      (facilities.medical.nextCost !== null && facilities.medical.nextCost <= facilities.budgetRemaining));

  const lastRevealed = (results?.matchweeks ?? []).find((w) => w.fixtures.length > 0);
  const myLastResult = lastRevealed?.fixtures.find((f) => f.home === me.club.id || f.away === me.club.id) ?? null;
  const myRank = table.findIndex((r) => r.clubId === me.club.id) + 1;

  const fixtureAction = () => {
    if (!fx) return null;
    if (fx.state === 'scheduled') {
      return (
        <Link className="button primary" to={`/lineup/${fx.id}`}>
          {fx.submissions.you.half1 ? 'Edit lineup' : 'Set your lineup'}
        </Link>
      );
    }
    if (fx.state === 'awaiting_ht') {
      return (
        <>
          {fx.htDeadline && <p>Half-time — second half sims in <Countdown until={fx.htDeadline} /></p>}
          <Link className="button primary" to={`/ht/${fx.id}`}>Half-time decisions</Link>
        </>
      );
    }
    if (fx.state === 'final' && !revealDay) {
      return (
        <>
          <p className="muted">Full time — results are embargoed until the week closes.</p>
          <Link className="button" to={`/season/match/${fx.id}`}>View your match</Link>
        </>
      );
    }
    return <Link className="button primary" to={`/season/match/${fx.id}`}>View your match</Link>;
  };

  return (
    <div className="section">
      <div className="section-head">
        <h1>home</h1>
        <span className="muted">
          {mw.kind === 'transfer' ? 'Transfer window' : mw.kind === 'playoff' ? 'Playoffs' : `Matchweek ${mw.number}`}
          {' · '}deadline <Countdown until={mw.deadlineAt} />
        </span>
      </div>

      <div className="section-body fixed">
        <div className="screen">
          {/* HERO — never scrolls */}
          <div className="pane pane-hero" style={{ flex: '1.2 1 0' }}>
            {revealDay && myLastResult === null && lastRevealed && (
              <div className="card accent">
                <h2>Results are out</h2>
                <p className="muted">Matchweek {lastRevealed.number} revealed — see how the league moved.</p>
                <Link className="button primary" to="/season/results">This week's results</Link>
              </div>
            )}
            {fx ? (
              <div className={`card fixture-hero${deadlineSoon && fx.state === 'scheduled' && !fx.submissions.you.half1 ? ' urgent' : ''}`}>
                <h3>{venue === 'home' ? 'Home' : 'Away'} vs</h3>
                <h2 className="fixture-opp">{opponentName}</h2>
                <ul className="status-list">
                  <li>You: {fx.submissions.you.half1 ? '✓ lineup in' : '— no lineup yet'}</li>
                  <li>Opponent: {fx.submissions.opponent.half1 ? '✓ lineup in' : '— not yet submitted'}</li>
                </ul>
                {fixtureAction()}
                <p style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                  <button onClick={() => setScouting((s) => !s)}>
                    {scouting ? 'Hide scout' : 'Scout opponent'}
                  </button>
                </p>
                {scouting && (
                  <div className="scout">
                    <p className="muted">
                      {opponentName} sit <strong>{oppRank > 0 ? `P${oppRank}` : '—'}</strong> in the table.
                    </p>
                    {oppLast.length > 0 ? (
                      <ul className="status-list">
                        {oppLast.map((f) => (
                          <li key={f.fixtureId} className="muted">
                            {results!.clubNames[f.home]} {f.score[0]}–{f.score[1]} {results!.clubNames[f.away]}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">No revealed results yet.</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="card">
                <h2>{mw.kind === 'transfer' ? 'Transfer window — recovery week' : 'No fixture this week'}</h2>
                {mw.kind === 'transfer' && (
                  <Link className="button primary" to="/market/transfers">Open the market</Link>
                )}
                {mw.kind === 'playoff' && (
                  <p className="muted">Your season is done — follow the <Link to="/season/bracket">bracket</Link>.</p>
                )}
              </div>
            )}
          </div>

          {/* secondary column — scrolls in-box */}
          <div className="pane pane-scroll" style={{ flex: '1 1 0' }}>
            <div className="card tight">
              <h3>Needs attention</h3>
              <ul className="status-list">
                {suspended.map((p) => (
                  <li key={p.playerId}><span className="badge badge-sus">SUS</span> {p.fullName} misses this week</li>
                ))}
                {injured.map((p) => (
                  <li key={p.playerId}><span className="badge badge-inj">INJ</span> {p.fullName} — {p.injuryWeeksLeft}w</li>
                ))}
                {affordable && (
                  <li>💰 A facility level is affordable — <Link to="/market/facilities">facilities</Link></li>
                )}
                {training && (
                  <li className="muted">Training set: {training.focus} · intensity {training.intensity.toFixed(2)}</li>
                )}
                {suspended.length === 0 && injured.length === 0 && !affordable && (
                  <li className="muted">All quiet.</li>
                )}
              </ul>
            </div>

            {myLastResult && (
              <div className="card tight">
                <h3>Last week revealed</h3>
                <Link className="result-line mine" to={`/season/match/${myLastResult.fixtureId}`}>
                  <span className="result-club home">{results!.clubNames[myLastResult.home]}</span>
                  <span className="result-score">{myLastResult.score[0]}–{myLastResult.score[1]}</span>
                  <span className="result-club">{results!.clubNames[myLastResult.away]}</span>
                </Link>
                <p className="muted" style={{ margin: '0.3rem 0 0' }}>
                  You sit <strong>P{myRank > 0 ? myRank : '—'}</strong> — <Link to="/season/standings">table</Link>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
