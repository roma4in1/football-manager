import { useEffect, useState } from 'react';
import { api, type StandingsRow } from '../api.ts';

export function StandingsScreen() {
  const [table, setTable] = useState<StandingsRow[] | null>(null);

  useEffect(() => {
    void api.standings().then((r) => setTable(r.table));
  }, []);

  if (!table) return <p className="muted">Loading…</p>;

  return (
    <div>
      <p className="muted">Revealed matchweeks only.</p>
      <table className="standings">
        <thead>
          <tr>
            <th>#</th><th>Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Pts</th>
          </tr>
        </thead>
        <tbody>
          {table.map((row, i) => (
            <tr key={row.clubId}>
              <td>{i + 1}</td>
              <td className="stat-label">{row.name}</td>
              <td>{row.played}</td>
              <td>{row.wins}</td>
              <td>{row.draws}</td>
              <td>{row.losses}</td>
              <td>{row.goalsFor}</td>
              <td>{row.goalsAgainst}</td>
              <td><strong>{row.points}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
