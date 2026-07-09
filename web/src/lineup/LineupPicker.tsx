/**
 * List-based lineup picker: squad grouped by position, Start/Bench toggles,
 * availability badges, live eligibility issues via the shared validator.
 * Pure component (all data via props) — the unit under test.
 */

import { useMemo, useState } from 'react';
import { groupOf, type Group } from '@fm/engine/eligibility';
import { LEAGUE_CFG } from '@fm/engine/config';
import type { SquadPlayerView } from '../api.ts';
import { PosChip } from '../shell/Section.tsx';
import { FitnessBars } from './FitnessBars.tsx';
import { issuesFor, type Selection } from './build.ts';

const GROUP_ORDER: Group[] = ['GK', 'DF', 'MF', 'FW'];
const GROUP_LABEL: Record<Group, string> = { GK: 'Goalkeepers', DF: 'Defenders', MF: 'Midfielders', FW: 'Forwards' };

export const ISSUE_TEXT: Record<string, string> = {
  wrong_starter_count: 'Select exactly 11 starters',
  bench_too_large: `Bench is limited to ${LEAGUE_CFG.benchMax}`,
  duplicate_player: 'Duplicate player in lineup',
  not_in_squad: 'Player not in squad',
  player_unavailable: 'Unavailable player selected',
  no_goalkeeper: 'Starting XI needs a goalkeeper',
};

export interface LineupPickerProps {
  squad: SquadPlayerView[];
  initial?: Selection;
  onChange: (selection: Selection, valid: boolean) => void;
}

export function LineupPicker({ squad, initial, onChange }: LineupPickerProps) {
  const [selection, setSelection] = useState<Selection>(initial ?? { starters: [], bench: [] });

  const issues = useMemo(() => issuesFor(selection, squad), [selection, squad]);

  const update = (next: Selection): void => {
    setSelection(next);
    onChange(next, issuesFor(next, squad).length === 0);
  };

  const roleOf = (id: string): 'start' | 'bench' | 'out' =>
    selection.starters.includes(id) ? 'start' : selection.bench.includes(id) ? 'bench' : 'out';

  const toggle = (id: string, role: 'start' | 'bench'): void => {
    const without: Selection = {
      starters: selection.starters.filter((x) => x !== id),
      bench: selection.bench.filter((x) => x !== id),
    };
    if (roleOf(id) === role) return update(without); // toggle off
    if (role === 'start') {
      if (without.starters.length >= LEAGUE_CFG.startersRequired) return; // XI full — deselect someone first
      return update({ ...without, starters: [...without.starters, id] });
    }
    if (without.bench.length >= LEAGUE_CFG.benchMax) return; // bench full
    return update({ ...without, bench: [...without.bench, id] });
  };

  return (
    <div className="lineup-picker">
      <div className="picker-counts" role="status">
        <span data-testid="starter-count">Starters: {selection.starters.length}/{LEAGUE_CFG.startersRequired}</span>
        <span data-testid="bench-count">Bench: {selection.bench.length}/{LEAGUE_CFG.benchMax}</span>
      </div>

      {GROUP_ORDER.map((group) => {
        const players = squad.filter((p) => groupOf(p.position) === group);
        if (players.length === 0) return null;
        return (
          <section key={group}>
            <h3>{GROUP_LABEL[group]}</h3>
            <ul className="player-list">
              {players.map((p) => {
                const role = roleOf(p.playerId);
                return (
                  <li key={p.playerId} className={`player-row role-${role}`}>
                    <span className="player-name">{p.fullName}</span>
                    <span className="player-meta">
                      <PosChip position={p.position} /> <FitnessBars fatigue={p.fatigue} sharpness={p.sharpness} />
                      {p.injuryWeeksLeft > 0 && <span className="badge badge-inj">INJ {p.injuryWeeksLeft}w</span>}
                      {p.suspendedNext && <span className="badge badge-sus">SUSPENDED</span>}
                      {p.justReturned && <span className="badge badge-ret">RETURNING</span>}
                    </span>
                    <span className="player-actions">
                      <button
                        type="button"
                        aria-pressed={role === 'start'}
                        onClick={() => toggle(p.playerId, 'start')}
                      >
                        Start
                      </button>
                      <button
                        type="button"
                        aria-pressed={role === 'bench'}
                        onClick={() => toggle(p.playerId, 'bench')}
                      >
                        Bench
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {issues.length > 0 && (
        <ul className="issues" data-testid="issues">
          {[...new Set(issues.map((i) => ISSUE_TEXT[i.code] ?? i.code))].map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
