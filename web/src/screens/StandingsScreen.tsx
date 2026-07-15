/**
 * season → standings: the league table, read like a real one — rank, club
 * crest, played/W/D/L, goal difference, points. Tabular figures align down
 * every column; your row is highlighted; revealed matchweeks only.
 */

import { useEffect, useState } from 'react';
import { ListOrdered, Trophy } from 'lucide-react';
import { api, type MeWithClub, type StandingsRow } from '../api.ts';
import { ClubBadge, EmptyState } from '../data.tsx';
import { fmtSigned } from '../format.ts';

export function StandingsScreen({ me }: { me: MeWithClub }) {
  const [table, setTable] = useState<StandingsRow[] | null>(null);

  useEffect(() => {
    void api.standings().then((r) => setTable(r.table), () => setTable([]));
  }, []);

  if (!table) return <EmptyState icon={ListOrdered} title="Loading the table…" />;
  if (table.length === 0) {
    return (
      <EmptyState
        icon={ListOrdered}
        title="No table yet"
        hint="The standings fill in as each matchweek is revealed."
      />
    );
  }

  return (
    <div>
      <p className="muted" style={{ margin: '0 0 0.5rem' }}>Revealed matchweeks only.</p>
      <table className="league-table">
        <thead>
          <tr>
            <th className="lt-rank">#</th>
            <th className="lt-club">Club</th>
            <th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>
          </tr>
        </thead>
        <tbody>
          {table.map((row, i) => {
            const gd = row.goalsFor - row.goalsAgainst;
            return (
              <tr key={row.clubId} className={row.clubId === me.club.id ? 'you' : ''}>
                <td className="lt-rank">
                  {i === 0 ? <Trophy className="lt-rank-trophy" size={14} aria-label="1st" /> : i + 1}
                </td>
                <td className="lt-club">
                  <span className="lt-club-cell">
                    <ClubBadge name={row.name} size={22} />
                    <span className="lt-club-name">{row.name}</span>
                  </span>
                </td>
                <td>{row.played}</td>
                <td>{row.wins}</td>
                <td>{row.draws}</td>
                <td>{row.losses}</td>
                <td className={`lt-gd${gd > 0 ? ' pos' : ''}`}>{fmtSigned(gd)}</td>
                <td className="lt-pts">{row.points}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
