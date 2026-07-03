import { useEffect, useState } from 'react';
import type { HalfStats } from '@shared/engine-types.ts';
import { fmtRemaining } from './format.ts';

export function Countdown({ until }: { until: string }) {
  const target = new Date(until);
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const passed = target.getTime() <= Date.now();
  return <span className="countdown">{passed ? 'passed' : `in ${fmtRemaining(target)}`}</span>;
}

const STAT_ROWS: Array<{ key: keyof HalfStats; label: string; fmt?: (x: number) => string }> = [
  { key: 'possession', label: 'Possession', fmt: (x) => `${x.toFixed(1)}%` },
  { key: 'shots', label: 'Shots' },
  { key: 'shotsOnTarget', label: 'On target' },
  { key: 'xg', label: 'xG', fmt: (x) => x.toFixed(2) },
  { key: 'passAccuracy', label: 'Pass accuracy', fmt: (x) => `${x.toFixed(1)}%` },
];

export function StatsTable({ stats, homeName, awayName }: { stats: HalfStats; homeName: string; awayName: string }) {
  return (
    <table className="stats">
      <thead>
        <tr>
          <th>{homeName}</th>
          <th />
          <th>{awayName}</th>
        </tr>
      </thead>
      <tbody>
        {STAT_ROWS.map(({ key, label, fmt }) => {
          const [h, a] = stats[key] as [number, number];
          const f = fmt ?? ((x: number) => String(x));
          return (
            <tr key={label}>
              <td>{f(h)}</td>
              <td className="stat-label">{label}</td>
              <td>{f(a)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Ratings({ ratings, names }: { ratings: Record<string, number>; names: Record<string, string> }) {
  const rows = Object.entries(ratings).sort((a, b) => b[1] - a[1]);
  return (
    <table className="stats">
      <tbody>
        {rows.map(([id, rating]) => (
          <tr key={id}>
            <td className="stat-label">{names[id] ?? id}</td>
            <td>{rating.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
