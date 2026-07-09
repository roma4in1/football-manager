/**
 * squad — the player hub (DESIGN-SPEC): two-pane. List left (name, position
 * hue, fitness + sharpness bars, status badges); detail right — 26 attributes
 * grouped technical/physical/mental(+gk), contract, status, own season stats,
 * and the growth trajectory from attribute_audit (the multi-season delight).
 * Single-player stats only — ranked leaderboards are season-2.
 */

import { useEffect, useState } from 'react';
import type { Attributes } from '@fm/engine/types';
import { api, type PlayerDetailView, type SquadPlayerView } from '../api.ts';
import { FitnessBars } from '../lineup/FitnessBars.tsx';
import { PosChip } from '../shell/Section.tsx';

const GROUPS: Array<{ label: string; keys: Array<keyof Attributes> }> = [
  { label: 'Technical', keys: ['passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing', 'tackling', 'marking', 'setPieceDelivery'] },
  { label: 'Physical', keys: ['pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility'] },
  { label: 'Mental', keys: ['decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'aggression'] },
  { label: 'Goalkeeping', keys: ['gkReflexes', 'gkPositioning', 'gkDistribution'] },
];

const label = (k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase();
const tone = (v: number) => (v >= 15 ? 'attr-high' : v >= 11 ? 'attr-mid' : 'attr-low');

export function SquadScreen() {
  const [squad, setSquad] = useState<SquadPlayerView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlayerDetailView | null>(null);

  useEffect(() => {
    api.squad().then((r) => {
      setSquad(r.players);
      if (r.players.length) setSelectedId((cur) => cur ?? r.players[0].playerId);
    }, () => {});
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDetail(null);
    api.playerDetail(selectedId).then(setDetail, () => {});
  }, [selectedId]);

  const p = squad.find((x) => x.playerId === selectedId) ?? null;
  if (squad.length === 0) return <p className="muted">No contracted players yet.</p>;

  const growthLines = (detail?.growth ?? []).map((g) => {
    const deltas = Object.keys(g.after)
      .map((k) => ({ k, d: (g.after[k] ?? 0) - (g.before[k] ?? 0) }))
      .filter((x) => Math.abs(x.d) >= 0.05)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
      .slice(0, 5);
    return { season: g.seasonNumber, deltas };
  });

  return (
    <div className="screen">
      {/* the roster list — scrolls in-box */}
      <div className="pane pane-scroll" style={{ flex: '1 1 0' }}>
        <ul className="player-list">
          {squad.map((row) => (
            <li
              key={row.playerId}
              className={`player-row clickable${row.playerId === selectedId ? ' selected' : ''}`}
              onClick={() => setSelectedId(row.playerId)}
            >
              <span className="player-name">{row.fullName}</span>
              <span className="player-meta">
                <PosChip position={row.position} />
                <FitnessBars fatigue={row.fatigue} sharpness={row.sharpness} />
                {row.injuryWeeksLeft > 0 && <span className="badge badge-inj">INJ {row.injuryWeeksLeft}w</span>}
                {row.suspendedNext && <span className="badge badge-sus">SUS</span>}
                {row.justReturned && <span className="badge badge-ret">RET</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* the detail pane — scrolls in-box */}
      <div className="pane pane-scroll" style={{ flex: '1.4 1 0' }}>
        {p && (
          <div className="card">
            <div className="hub-head">
              <h2 style={{ margin: 0 }}>{p.fullName}</h2>
              <PosChip position={p.position} />
              <FitnessBars fatigue={p.fatigue} sharpness={p.sharpness} />
            </div>
            <p className="muted" style={{ margin: '0.25rem 0 0.5rem' }}>
              {detail?.contract
                ? <>wage {detail.contract.wage.toLocaleString()}/wk · {Math.max(0, detail.contract.seasonsRemaining)} season{detail.contract.seasonsRemaining === 1 ? '' : 's'} left</>
                : '…'}
              {p.injuryWeeksLeft > 0 && <> · <span className="error">injured {p.injuryWeeksLeft}w</span></>}
              {p.suspendedNext && <> · <span style={{ color: 'var(--warn)' }}>suspended next</span></>}
            </p>

            {detail && (
              <p className="hub-stats">
                <span><strong>{detail.seasonStats.apps}</strong> apps</span>
                <span><strong>{detail.seasonStats.goals}</strong> goals</span>
                <span><strong>{detail.seasonStats.avgRating ?? '—'}</strong> avg rating</span>
                <span><strong>{Math.round(detail.seasonStats.minutes)}</strong> mins</span>
              </p>
            )}

            {GROUPS.filter((g) => g.label !== 'Goalkeeping' || p.position.startsWith('GK')).map((g) => (
              <div key={g.label}>
                <h3>{g.label}</h3>
                <div className="attr-grid">
                  {g.keys.map((k) => (
                    <span key={k} className="attr">
                      <span className="attr-name">{label(k)}</span>
                      <span className={`attr-val ${tone(p.attributes[k])}`}>{Math.round(p.attributes[k] * 10) / 10}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}

            {growthLines.length > 0 && (
              <div>
                <h3>Growth</h3>
                {growthLines.map((g) => (
                  <p key={g.season} className="muted" style={{ margin: '0.15rem 0' }}>
                    <strong>S{g.season}</strong>{' '}
                    {g.deltas.length
                      ? g.deltas.map((d) => `${label(d.k)} ${d.d > 0 ? '+' : ''}${Math.round(d.d * 10) / 10}`).join(' · ')
                      : 'held steady'}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
