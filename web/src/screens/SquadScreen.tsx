/**
 * squad — the player hub (DESIGN-SPEC): two-pane. List left, each row scannable
 * at a glance (name, position hue, fitness, status + a headline key-attribute
 * rating); detail right — 26 attributes grouped technical/physical/mental(+gk),
 * contract, status, own season stats as stat tiles, and the growth trajectory
 * from attribute_audit. Single-player stats only — leaderboards are season-2.
 */

import { useEffect, useState } from 'react';
import { HeartPulse, Users } from 'lucide-react';
import type { Attributes } from '@fm/engine/types';
import { api, type PlayerDetailView, type SquadPlayerView } from '../api.ts';
import { FitnessBars } from '../lineup/FitnessBars.tsx';
import { PosChip } from '../shell/Section.tsx';
import { Attr, EmptyState, PositionRating, StatTile, StatusBadges } from '../data.tsx';
import { fmtInt } from '../format.ts';

const GROUPS: Array<{ label: string; keys: Array<keyof Attributes> }> = [
  { label: 'Technical', keys: ['passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing', 'tackling', 'marking', 'setPieceDelivery'] },
  { label: 'Physical', keys: ['pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility'] },
  { label: 'Mental', keys: ['decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'aggression'] },
  { label: 'Goalkeeping', keys: ['gkReflexes', 'gkPositioning', 'gkDistribution'] },
];

const label = (k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase();

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
  if (squad.length === 0) {
    return <EmptyState icon={Users} title="No players yet" hint="Your squad fills up once the auction runs." />;
  }

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
              className={`player-row squad-row clickable${row.playerId === selectedId ? ' selected' : ''}`}
              onClick={() => setSelectedId(row.playerId)}
            >
              <span className="squad-name">{row.fullName}</span>
              <span className="squad-row-side">
                <PositionRating attributes={row.attributes} position={row.position} />
              </span>
              <span className="squad-row-meta">
                <PosChip position={row.position} />
                <FitnessBars fatigue={row.fatigue} sharpness={row.sharpness} />
                <StatusBadges injuryWeeksLeft={row.injuryWeeksLeft} suspendedNext={row.suspendedNext} justReturned={row.justReturned} />
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
              <PositionRating attributes={p.attributes} position={p.position} />
              <span style={{ marginLeft: 'auto' }}>
                <FitnessBars fatigue={p.fatigue} sharpness={p.sharpness} />
              </span>
            </div>
            <p className="muted" style={{ margin: '0.3rem 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
              {detail?.contract
                ? <>wage {fmtInt(detail.contract.wage)}/wk · {Math.max(0, detail.contract.seasonsRemaining)} season{detail.contract.seasonsRemaining === 1 ? '' : 's'} left</>
                : '…'}
              <StatusBadges injuryWeeksLeft={p.injuryWeeksLeft} suspendedNext={p.suspendedNext} justReturned={p.justReturned} />
            </p>

            {detail && (
              <div className="stat-tiles">
                <StatTile label="Apps" value={detail.seasonStats.apps} />
                <StatTile label="Goals" value={detail.seasonStats.goals} />
                <StatTile label="Avg rating" value={detail.seasonStats.avgRating ?? '—'} />
                <StatTile label="Minutes" value={fmtInt(detail.seasonStats.minutes)} />
              </div>
            )}

            {GROUPS.filter((g) => g.label !== 'Goalkeeping' || p.position.startsWith('GK')).map((g) => (
              <div key={g.label}>
                <h3>{g.label}</h3>
                <div className="attr-grid">
                  {g.keys.map((k) => <Attr key={k} name={label(k)} value={p.attributes[k]} />)}
                </div>
              </div>
            ))}

            {growthLines.length > 0 && (
              <div>
                <h3><HeartPulse size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />Growth</h3>
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
