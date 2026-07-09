/**
 * tactics — deploy (DESIGN-SPEC): the pitch editor (6 phase tabs, gravity
 * anchors, zones, per-player sliders), the lineup (slot assignment with
 * inherit-on-swap), team instructions (their own surface), and presets.
 *
 * The draft edits the club's DEFAULT tactics (the standing plan every
 * fixture auto-fills from); this week's one-off submission stays in the
 * home → lineup flow. Player-to-role: the config belongs to the SLOT — when
 * the lineup swaps player B in for A, B inherits A's phase anchors, sliders
 * and zones, then can be tweaked (rotation stays non-tedious).
 *
 * Presets are device-local (localStorage): named full-tactic plans and
 * single-phase player configs. Server-side named presets would need a new
 * table — parked for season 2 per the scope rule; default_tactics remains
 * the one server-saved plan.
 */

import { useEffect, useMemo, useState } from 'react';
import type { InstructionZone, Phase, PlayerInstructions, Tactics, Vec2 } from '@fm/engine/types';
import { api, ApiError, type SquadPlayerView } from '../api.ts';
import { buildTactics, defaultTeamInstructions, type Selection } from '../lineup/build.ts';
import { LineupPicker } from '../lineup/LineupPicker.tsx';
import { PitchEditor, type PitchPlayer } from './PitchEditor.tsx';

const PHASES: Phase[] = ['buildUp', 'progression', 'finalThird', 'defensiveBlock', 'counterPress', 'counterAttack'];
const PHASE_LABEL: Record<Phase, string> = {
  buildUp: 'build-up', progression: 'progression', finalThird: 'final third',
  defensiveBlock: 'block', counterPress: 'counter-press', counterAttack: 'counter',
};
const SLIDERS: Array<{ key: keyof PlayerInstructions; label: string }> = [
  { key: 'riskAppetite', label: 'risk' },
  { key: 'holdPosition', label: 'hold' },
  { key: 'pressingIntensity', label: 'press' },
  { key: 'shootingBias', label: 'shoot' },
  { key: 'dribbleBias', label: 'dribble' },
  { key: 'crossBias', label: 'cross' },
];
const TEAM_SLIDERS: Array<{ key: keyof Tactics['team']; label: string; min?: number; max?: number; step?: number }> = [
  { key: 'lineHeight', label: 'line height' },
  { key: 'width', label: 'width' },
  { key: 'compactness', label: 'compactness' },
  { key: 'pressTrigger', label: 'press trigger' },
  { key: 'counterPressDuration', label: 'counter-press (s)', min: 2, max: 12, step: 1 },
  { key: 'tempo', label: 'tempo' },
];

type Tab = 'editor' | 'lineup' | 'team' | 'presets';
const FULL_KEY = 'fm.presets.tactic';
const PHASE_KEY = 'fm.presets.phase';

const readStore = <T,>(key: string): Record<string, T> => {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, T>; } catch { return {}; }
};
const writeStore = <T,>(key: string, v: Record<string, T>) => localStorage.setItem(key, JSON.stringify(v));

export function TacticsSection() {
  const [squad, setSquad] = useState<SquadPlayerView[]>([]);
  const [draft, setDraft] = useState<Tactics | null>(null);
  const [tab, setTab] = useState<Tab>('editor');
  const [phase, setPhase] = useState<Phase>('buildUp');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');

  useEffect(() => {
    void (async () => {
      const { players } = await api.squad();
      setSquad(players);
      try {
        const { payload } = await api.defaultTactics();
        setDraft(payload);
        setSelectedId(payload.players[0]?.playerId ?? null);
      } catch {
        // no saved plan yet — synthesize from the first eligible XI
        const starters = players.filter((p) => p.injuryWeeksLeft === 0 && !p.suspendedNext).slice(0, 11).map((p) => p.playerId);
        const synthesized = buildTactics({ starters, bench: [] }, players, {}, defaultTeamInstructions);
        setDraft(synthesized);
        setSelectedId(starters[0] ?? null);
      }
    })();
  }, []);

  const nameOf = useMemo(() => new Map(squad.map((p) => [p.playerId, p.fullName])), [squad]);
  const posOf = useMemo(() => new Map(squad.map((p) => [p.playerId, p.position])), [squad]);

  if (!draft) return <p className="muted">Loading…</p>;

  const pitchPlayers: PitchPlayer[] = draft.players.map((t) => ({
    tactic: t,
    name: nameOf.get(t.playerId) ?? '?',
    position: posOf.get(t.playerId) ?? 'MF',
  }));
  const selected = draft.players.find((t) => t.playerId === selectedId) ?? null;

  const patchPlayer = (playerId: string, patch: (t: Tactics['players'][number]) => Tactics['players'][number]) =>
    setDraft((d) => d && { ...d, players: d.players.map((t) => (t.playerId === playerId ? patch(t) : t)) });

  const moveAnchor = (playerId: string, at: Vec2) =>
    patchPlayer(playerId, (t) => ({ ...t, anchors: { ...t.anchors, [phase]: { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 } } }));

  const moveZone = (playerId: string, zoneIndex: number, at: Vec2) =>
    patchPlayer(playerId, (t) => {
      const zones = [...(t.zones[phase] ?? [])];
      const z = zones[zoneIndex];
      const cx = z.polygon.reduce((s, v) => s + v.x, 0) / z.polygon.length;
      const cy = z.polygon.reduce((s, v) => s + v.y, 0) / z.polygon.length;
      zones[zoneIndex] = { ...z, polygon: z.polygon.map((v) => ({ x: v.x + at.x - cx, y: v.y + at.y - cy })) };
      return { ...t, zones: { ...t.zones, [phase]: zones } };
    });

  const addZone = (zoneType: InstructionZone['zoneType']) => {
    if (!selected) return;
    const a = selected.anchors[phase];
    const zone: InstructionZone = {
      zoneType,
      weight: 0.7,
      polygon: [
        { x: a.x - 7, y: a.y - 5 }, { x: a.x + 7, y: a.y - 5 },
        { x: a.x + 7, y: a.y + 5 }, { x: a.x - 7, y: a.y + 5 },
      ],
    };
    patchPlayer(selected.playerId, (t) => ({ ...t, zones: { ...t.zones, [phase]: [...(t.zones[phase] ?? []), zone] } }));
  };

  const save = async () => {
    setNotice(null);
    try {
      await api.saveDefaultTactics(draft);
      setNotice('Saved as your standing plan.');
    } catch (err) {
      setNotice(err instanceof ApiError && err.status === 422
        ? `Rejected: ${(err.body.issues ?? []).map((i) => i.code).join(', ')}`
        : 'Save failed.');
    }
  };

  /** inherit-on-swap: the config belongs to slot i; only playerIds change */
  const remapLineup = (sel: Selection) =>
    setDraft((d) => {
      if (!d) return d;
      const players = sel.starters.map((id, i) => {
        const slotConfig = d.players[i] ?? buildTactics({ starters: [id], bench: [] }, squad, {}, d.team).players[0];
        return { ...slotConfig, playerId: id };
      });
      return { ...d, players, bench: sel.bench };
    });

  const zones = selected?.zones[phase] ?? [];

  return (
    <div className="section">
      <div className="section-head">
        <h1>tactics</h1>
        <div className="tabs">
          {(['editor', 'lineup', 'team', 'presets'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <span className="grow" />
        <button className="primary" onClick={() => void save()}>Save plan</button>
      </div>
      {notice && <p className={notice.startsWith('Saved') ? 'muted' : 'error'} style={{ margin: '0 0 0.4rem' }}>{notice}</p>}

      <div className="section-body fixed">
        {tab === 'editor' && (
          <div className="screen">
            <div className="pane pane-hero editor-left">
              <div className="tabs phase-tabs">
                {PHASES.map((ph) => (
                  <button key={ph} className={phase === ph ? 'active' : ''} onClick={() => setPhase(ph)}>
                    {PHASE_LABEL[ph]}
                  </button>
                ))}
              </div>
              <div className="pitch-wrap">
                <PitchEditor
                  players={pitchPlayers}
                  phase={phase}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onMoveAnchor={moveAnchor}
                  onMoveZone={moveZone}
                />
              </div>
              <p className="muted editor-hint">
                The halo is a center of gravity — he tends here, drifts with play, returns. Drag to move; tap a faded dot to edit that player.
              </p>
            </div>

            <div className="pane pane-scroll editor-right">
              {selected && (
                <div className="card tight">
                  <h2 style={{ marginBottom: '0.15rem' }}>{nameOf.get(selected.playerId)}</h2>
                  <p className="muted" style={{ margin: '0 0 0.4rem' }}>{PHASE_LABEL[phase]} · sliders bias, never command</p>
                  {SLIDERS.map(({ key, label }) => (
                    <label key={key} className="slider">
                      {label}: {selected.instructions[key].toFixed(2)}
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={selected.instructions[key]}
                        onChange={(e) =>
                          patchPlayer(selected.playerId, (t) => ({ ...t, instructions: { ...t.instructions, [key]: Number(e.target.value) } }))}
                      />
                    </label>
                  ))}
                  <h3>Zones — {PHASE_LABEL[phase]}</h3>
                  {zones.map((z, i) => (
                    <div key={i} className="zone-row">
                      <span className="muted">{z.zoneType}</span>
                      <input
                        type="range" min={0.1} max={1} step={0.1} value={z.weight}
                        onChange={(e) =>
                          patchPlayer(selected.playerId, (t) => {
                            const zs = [...(t.zones[phase] ?? [])];
                            zs[i] = { ...zs[i], weight: Number(e.target.value) };
                            return { ...t, zones: { ...t.zones, [phase]: zs } };
                          })}
                      />
                      <span>{z.weight.toFixed(1)}</span>
                      <button onClick={() =>
                        patchPlayer(selected.playerId, (t) => ({
                          ...t, zones: { ...t.zones, [phase]: (t.zones[phase] ?? []).filter((_, j) => j !== i) },
                        }))}>✕</button>
                    </div>
                  ))}
                  <p className="zone-add">
                    {(['runTarget', 'operating', 'pressing'] as const).map((zt) => (
                      <button key={zt} onClick={() => addZone(zt)}>+ {zt === 'runTarget' ? 'run target' : zt}</button>
                    ))}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'lineup' && (
          <div className="pane pane-scroll" style={{ height: '100%' }}>
            <p className="muted" style={{ marginTop: 0 }}>
              A swapped-in player inherits the slot's phase anchors, sliders and zones.
            </p>
            <LineupPicker
              key={draft.players.map((p) => p.playerId).join(',')}
              squad={squad}
              initial={{ starters: draft.players.map((p) => p.playerId), bench: draft.bench }}
              onChange={(sel) => remapLineup(sel)}
            />
          </div>
        )}

        {tab === 'team' && (
          <div className="card" style={{ maxWidth: 460 }}>
            <p className="muted" style={{ marginTop: 0 }}>Team-wide shape — separate from the per-player editor.</p>
            {TEAM_SLIDERS.map(({ key, label, min = 0, max = 1, step = 0.05 }) => (
              <label key={key} className="slider">
                {label}: {key === 'counterPressDuration' ? `${draft.team[key]}s` : (draft.team[key] as number).toFixed(2)}
                <input
                  type="range" min={min} max={max} step={step}
                  value={draft.team[key] as number}
                  onChange={(e) => setDraft({ ...draft, team: { ...draft.team, [key]: Number(e.target.value) } })}
                />
              </label>
            ))}
          </div>
        )}

        {tab === 'presets' && (
          <div className="pane pane-scroll" style={{ height: '100%', maxWidth: 520 }}>
            <div className="card tight">
              <h3>Full-tactic presets (this device)</h3>
              <p>
                <input type="text" placeholder="preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} style={{ width: '12rem' }} />{' '}
                <button disabled={!presetName.trim()} onClick={() => {
                  writeStore(FULL_KEY, { ...readStore<Tactics>(FULL_KEY), [presetName.trim()]: draft });
                  setPresetName('');
                  setDraft((d) => d && { ...d }); // re-render the list
                }}>Save current plan</button>
              </p>
              {Object.entries(readStore<Tactics>(FULL_KEY)).map(([name, t]) => (
                <p key={name} className="zone-row">
                  <strong className="grow">{name}</strong>
                  <button onClick={() => { setDraft(t); setSelectedId(t.players[0]?.playerId ?? null); }}>Load</button>
                  <button onClick={() => {
                    const all = readStore<Tactics>(FULL_KEY);
                    delete all[name];
                    writeStore(FULL_KEY, all);
                    setDraft((d) => d && { ...d }); // re-render
                  }}>✕</button>
                </p>
              ))}
            </div>
            <div className="card tight">
              <h3>Phase presets — {selected ? nameOf.get(selected.playerId) : '—'} · {PHASE_LABEL[phase]}</h3>
              <p className="muted">Save one phase's anchor + sliders; apply it to any player's same phase.</p>
              <p>
                <button disabled={!selected} onClick={() => {
                  if (!selected) return;
                  const name = `${PHASE_LABEL[phase]} · ${new Date().toLocaleDateString()}`;
                  writeStore(PHASE_KEY, {
                    ...readStore<{ anchor: Vec2; instructions: PlayerInstructions }>(PHASE_KEY),
                    [name]: { anchor: selected.anchors[phase], instructions: selected.instructions },
                  });
                  setDraft((d) => d && { ...d });
                }}>Save this phase</button>
              </p>
              {Object.entries(readStore<{ anchor: Vec2; instructions: PlayerInstructions }>(PHASE_KEY)).map(([name, p]) => (
                <p key={name} className="zone-row">
                  <span className="grow">{name}</span>
                  <button disabled={!selected} onClick={() => selected && patchPlayer(selected.playerId, (t) => ({
                    ...t, anchors: { ...t.anchors, [phase]: p.anchor }, instructions: p.instructions,
                  }))}>Apply</button>
                  <button onClick={() => {
                    const all = readStore<{ anchor: Vec2; instructions: PlayerInstructions }>(PHASE_KEY);
                    delete all[name];
                    writeStore(PHASE_KEY, all);
                    setDraft((d) => d && { ...d });
                  }}>✕</button>
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
