/**
 * LineupPicker + instruction sliders + submit. Used for half-1 submissions
 * (/lineup/:fixtureId) and HT resubmission (embedded in the HT screen), where
 * bench swaps are capped at LEAGUE_CFG.htSubsMax vs the half-1 XI
 * (client-enforced for now — the engine has no sub model yet).
 */

import { useEffect, useMemo, useState } from 'react';
import type { PlayerInstructions, TeamInstructions } from '@fm/engine/types';
import { LEAGUE_CFG } from '@fm/engine/config';
import { api, ApiError, type SquadPlayerView } from '../api.ts';
import { buildTactics, defaultTeamInstructions, type Selection } from './build.ts';
import { LineupPicker } from './LineupPicker.tsx';

const PLAYER_SLIDERS: Array<{ key: keyof PlayerInstructions; label: string }> = [
  { key: 'riskAppetite', label: 'Risk appetite' },
  { key: 'shootingBias', label: 'Shooting bias' },
  { key: 'dribbleBias', label: 'Dribble bias' },
  { key: 'pressingIntensity', label: 'Pressing intensity' },
  { key: 'holdPosition', label: 'Hold position' },
  { key: 'crossBias', label: 'Cross bias' },
];

const TEAM_SLIDERS: Array<{ key: 'lineHeight' | 'width' | 'compactness' | 'pressTrigger' | 'tempo'; label: string }> = [
  { key: 'lineHeight', label: 'Line height' },
  { key: 'width', label: 'Width' },
  { key: 'compactness', label: 'Compactness' },
  { key: 'pressTrigger', label: 'Press trigger' },
  { key: 'tempo', label: 'Tempo' },
];

const DEFAULT_PLAYER_INSTRUCTIONS: PlayerInstructions = {
  riskAppetite: 0.5, shootingBias: 0.4, dribbleBias: 0.4, pressingIntensity: 0.5, holdPosition: 0.5, crossBias: 0.4,
};

export interface LineupEditorProps {
  fixtureId: string;
  half: 1 | 2;
  onSubmitted: () => void;
}

export function LineupEditor({ fixtureId, half, onSubmitted }: LineupEditorProps) {
  const [squad, setSquad] = useState<SquadPlayerView[] | null>(null);
  const [initial, setInitial] = useState<Selection | undefined>();
  const [h1Starters, setH1Starters] = useState<string[] | null>(null); // HT subs baseline
  const [selection, setSelection] = useState<Selection>({ starters: [], bench: [] });
  const [selectionValid, setSelectionValid] = useState(false);
  const [instructions, setInstructions] = useState<Record<string, PlayerInstructions>>({});
  const [team, setTeam] = useState<TeamInstructions>(defaultTeamInstructions);
  const [alsoDefault, setAlsoDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { players } = await api.squad();
      setSquad(players);
      // seed from the half-1 submission when re-entering at HT (or editing h1)
      try {
        const own = await api.ownTactics(fixtureId, 1);
        const starters = own.payload.players.map((p) => p.playerId);
        const seeded = { starters, bench: own.payload.bench };
        setInitial(seeded);
        setSelection(seeded);
        setSelectionValid(true);
        setInstructions(Object.fromEntries(own.payload.players.map((p) => [p.playerId, p.instructions])));
        setTeam(own.payload.team);
        if (half === 2) setH1Starters(starters);
      } catch {
        /* nothing submitted yet — start from an empty sheet */
      }
    })();
  }, [fixtureId, half]);

  const swaps = useMemo(() => {
    if (half !== 2 || !h1Starters) return 0;
    return h1Starters.filter((id) => !selection.starters.includes(id)).length;
  }, [half, h1Starters, selection]);
  const swapsExceeded = half === 2 && swaps > LEAGUE_CFG.htSubsMax;

  if (!squad) return <p className="muted">Loading squad…</p>;

  const byId = new Map(squad.map((p) => [p.playerId, p]));
  const instructionsOf = (id: string): PlayerInstructions => instructions[id] ?? DEFAULT_PLAYER_INSTRUCTIONS;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const tactics = buildTactics(selection, squad, instructions, team);
      await api.submitTactics(fixtureId, half, tactics);
      if (alsoDefault) await api.saveDefaultTactics(tactics);
      onSubmitted();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setError(`Rejected: ${(err.body.issues ?? []).map((i) => i.code).join(', ')}`);
      } else if (err instanceof ApiError && err.status === 409) {
        setError('Too late — the fixture has moved on.');
      } else {
        setError('Submission failed, try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lineup-editor">
      <LineupPicker
        key={initial ? 'seeded' : 'empty'}
        squad={squad}
        initial={initial}
        onChange={(sel, valid) => {
          setSelection(sel);
          setSelectionValid(valid);
        }}
      />

      {half === 2 && h1Starters && (
        <p className={swapsExceeded ? 'error' : 'muted'}>
          Substitutions: {swaps}/{LEAGUE_CFG.htSubsMax}
        </p>
      )}

      <section>
        <h3>Player instructions</h3>
        {selection.starters.map((id) => (
          <details key={id}>
            <summary>{byId.get(id)?.fullName ?? id}</summary>
            {PLAYER_SLIDERS.map(({ key, label }) => (
              <label key={key} className="slider">
                {label}: {instructionsOf(id)[key].toFixed(2)}
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={instructionsOf(id)[key]}
                  onChange={(e) =>
                    setInstructions({ ...instructions, [id]: { ...instructionsOf(id), [key]: Number(e.target.value) } })
                  }
                />
              </label>
            ))}
          </details>
        ))}
      </section>

      <section>
        <h3>Team instructions</h3>
        {TEAM_SLIDERS.map(({ key, label }) => (
          <label key={key} className="slider">
            {label}: {team[key].toFixed(2)}
            <input
              type="range" min={0} max={1} step={0.05}
              value={team[key]}
              onChange={(e) => setTeam({ ...team, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
        <label className="slider">
          Counter-press duration: {team.counterPressDuration}s
          <input
            type="range" min={2} max={12} step={1}
            value={team.counterPressDuration}
            onChange={(e) => setTeam({ ...team, counterPressDuration: Number(e.target.value) })}
          />
        </label>
      </section>

      {half === 1 && (
        <label className="checkbox">
          <input type="checkbox" checked={alsoDefault} onChange={(e) => setAlsoDefault(e.target.checked)} />
          Also save as my default tactics
        </label>
      )}

      {error && <p className="error">{error}</p>}
      <button
        type="button"
        className="primary"
        disabled={!selectionValid || swapsExceeded || busy}
        onClick={() => void submit()}
      >
        {busy ? 'Submitting…' : half === 1 ? 'Submit lineup' : 'Submit half-time changes'}
      </button>
    </div>
  );
}
