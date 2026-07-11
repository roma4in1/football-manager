/**
 * Lineup-as-pitch: the FIFA-style lineup screen (SEASON-2-PARKING → queued
 * follow-up). The XI renders ON a pitch at their role-slot progression anchors
 * (name + position hue + the two-bar condition/sharpness), the bench sits
 * underneath, the rest of the squad in the side pane. Drag a player onto
 * another to swap them — or tap one, then tap his replacement; occupants
 * exchange places (pitch-swap.ts), and the parent remaps the starters onto
 * the slot configs, so a swapped-in player INHERITS the slot's phase
 * anchors, sliders and zones.
 *
 * Controlled + pure (all data via props) — the unit under test. Drag is
 * pointer-events with elementFromPoint drop resolution so HTML bench chips
 * and SVG pitch slots are the same kind of target ([data-loc]).
 */

import { useEffect, useRef, useState } from 'react';
import type { PlayerTactic } from '@fm/engine/types';
import { LEAGUE_CFG } from '@fm/engine/config';
import type { SquadPlayerView } from '../api.ts';
import { PosChip } from '../shell/Section.tsx';
import { issuesFor, type Selection } from './build.ts';
import { FitnessBars } from './FitnessBars.tsx';
import { ISSUE_TEXT } from './LineupPicker.tsx';
import { applyMove, dataToLoc, locToData, type Loc } from './pitch-swap.ts';

const W = 105;
const H = 68;
const DRAG_THRESHOLD_PX = 7;

const GROUP_VAR: Record<string, string> = { G: 'var(--pos-gk)', D: 'var(--pos-df)', M: 'var(--pos-mf)', F: 'var(--pos-fw)' };
const hueOf = (position: string) => GROUP_VAR[position[0]] ?? 'var(--pos-mf)';
const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const shortName = (name: string) => {
  const last = name.split(' ').at(-1) ?? name;
  return last.length > 11 ? `${last.slice(0, 10)}…` : last;
};
const tone = (v: number) => (v >= 0.7 ? 'var(--ok)' : v >= 0.45 ? 'var(--warn)' : 'var(--danger)');

interface Drag {
  playerId: string;
  x: number;
  y: number;
  active: boolean; // becomes true past the movement threshold; below it, it's a tap
}

export interface LineupPitchProps {
  squad: SquadPlayerView[];
  /** slot i's tactical config, playerId = current occupant (draft.players) */
  slots: PlayerTactic[];
  bench: string[];
  onChange: (sel: Selection) => void;
  /** reopen the presets-first chooser (rendered as a small side-pane button) */
  onOpenPresets?: () => void;
}

export function LineupPitch({ squad, slots, bench, onChange, onOpenPresets }: LineupPitchProps) {
  const sel: Selection = { starters: slots.map((s) => s.playerId), bench };
  const byId = new Map(squad.map((p) => [p.playerId, p]));
  const inLineup = new Set([...sel.starters, ...sel.bench]);
  const reserves = squad.filter((p) => !inLineup.has(p.playerId));
  const issues = issuesFor(sel, squad);

  const [picked, setPicked] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null); // data-loc under the pointer mid-drag
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const move = (playerId: string, target: Loc): void => {
    const next = applyMove(sel, playerId, target);
    if (next) onChange(next);
  };

  /** tap-to-swap: first tap picks a player, second taps where he goes */
  const tap = (target: Loc, occupantId?: string): void => {
    if (suppressClick.current) return;
    if (!picked) {
      if (occupantId) setPicked(occupantId);
      return;
    }
    if (occupantId === picked) return setPicked(null);
    move(picked, target);
    setPicked(null);
  };

  const dragStart = (playerId: string) => (e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
    setDrag({ playerId, x: e.clientX, y: e.clientY, active: false });
  };

  useEffect(() => {
    if (!drag) return;
    const locAt = (x: number, y: number): string | null =>
      document.elementFromPoint(x, y)?.closest('[data-loc]')?.getAttribute('data-loc') ?? null;
    const onMove = (e: PointerEvent): void => {
      const s = start.current;
      const active = drag.active || (!!s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > DRAG_THRESHOLD_PX);
      setDrag({ ...drag, x: e.clientX, y: e.clientY, active });
      setHover(active ? locAt(e.clientX, e.clientY) : null);
    };
    const onUp = (e: PointerEvent): void => {
      if (drag.active) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        const data = locAt(e.clientX, e.clientY);
        const target = data ? dataToLoc(data) : null;
        if (target) move(drag.playerId, target);
        setPicked(null);
      }
      setDrag(null);
      setHover(null);
    };
    const onCancel = (): void => { setDrag(null); setHover(null); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  });

  const grabbed = drag?.active ? drag.playerId : null;
  const highlightOf = (id: string | null, loc: Loc): string =>
    (id && (id === picked || id === grabbed)) ? ' sel' : hover === locToData(loc) ? ' hover' : '';

  const badgeFor = (p: SquadPlayerView) =>
    p.injuryWeeksLeft > 0 ? <span className="badge badge-inj">INJ {p.injuryWeeksLeft}w</span>
    : p.suspendedNext ? <span className="badge badge-sus">SUS</span>
    : null;

  return (
    <div className="screen lineup-pitch-screen">
      <div className="pane pane-hero editor-left lineup-hero">
        <div className="pitch-wrap">
          <svg className="pitch lineup-pitch" viewBox={`0 0 ${W} ${H}`}>
            <rect x="0" y="0" width={W} height={H} fill="#f0f6f1" />
            <g stroke="#c9dccd" strokeWidth="0.35" fill="none">
              <rect x="0.3" y="0.3" width={W - 0.6} height={H - 0.6} />
              <line x1={W / 2} y1="0.3" x2={W / 2} y2={H - 0.3} />
              <circle cx={W / 2} cy={H / 2} r="9.15" />
              <rect x="0.3" y={H / 2 - 20.16} width="16.5" height="40.32" />
              <rect x={W - 16.8} y={H / 2 - 20.16} width="16.5" height="40.32" />
              <rect x="0.3" y={H / 2 - 9.16} width="5.5" height="18.32" />
              <rect x={W - 5.8} y={H / 2 - 9.16} width="5.5" height="18.32" />
            </g>
            <text x={W - 2} y={H / 2} fontSize="2.6" fill="#9db7a2" textAnchor="end">attack →</text>

            {slots.map((slot, i) => {
              const p = byId.get(slot.playerId);
              const at = slot.anchors.progression; // the mid-attack shape spreads the XI — reads as "the formation"
              const x = Math.max(5, Math.min(W - 5, at.x));
              const y = Math.max(4.5, Math.min(H - 9.5, at.y));
              if (!p) {
                // a loaded preset can name a player who left the squad — keep
                // the slot visible and swappable so the hole can be filled
                const loc: Loc = { kind: 'slot', index: i };
                return (
                  <g key={`gone-${i}`} className="pitch-slot" data-loc={locToData(loc)} data-testid={`slot-${i}`}
                     style={{ cursor: 'pointer' }} onClick={() => tap(loc, slot.playerId)}>
                    <circle cx={x} cy={y} r="6.2" fill="transparent" />
                    {hover === locToData(loc) && <circle cx={x} cy={y} r="4" fill="none" stroke="var(--accent)" strokeWidth="0.5" strokeDasharray="1 0.8" />}
                    <circle cx={x} cy={y} r="2.7" fill="none" stroke="var(--faint)" strokeWidth="0.4" strokeDasharray="1 0.7" />
                    <text x={x} y={y + 0.8} fontSize="2.2" fill="var(--faint)" textAnchor="middle" fontWeight="700">?</text>
                    <text x={x} y={y + 5.6} fontSize="2.2" fontWeight="600" textAnchor="middle" fill="var(--muted)"
                          stroke="#f0f6f1" strokeWidth="0.55" style={{ paintOrder: 'stroke' }}>left squad</text>
                  </g>
                );
              }
              const unavailable = p.injuryWeeksLeft > 0 || p.suspendedNext;
              const condition = Math.max(0, Math.min(1, 1 - p.fatigue));
              const sharp = Math.max(0, Math.min(1, p.sharpness));
              const hl = highlightOf(p.playerId, { kind: 'slot', index: i });
              return (
                <g
                  key={p.playerId}
                  className={`pitch-slot${hl}`}
                  data-loc={locToData({ kind: 'slot', index: i })}
                  data-testid={`slot-${i}`}
                  style={{ cursor: 'grab' }}
                  onClick={() => tap({ kind: 'slot', index: i }, p.playerId)}
                  onPointerDown={dragStart(p.playerId)}
                >
                  <circle cx={x} cy={y} r="6.2" fill="transparent" />
                  {hl && <circle cx={x} cy={y} r="4" fill="none" stroke="var(--accent)" strokeWidth="0.5" strokeDasharray={hl === ' hover' ? '1 0.8' : undefined} />}
                  {unavailable && (
                    <circle cx={x} cy={y} r="3.5" fill="none" strokeWidth="0.45"
                            stroke={p.injuryWeeksLeft > 0 ? 'var(--danger)' : 'var(--warn)'} strokeDasharray="1 0.7" />
                  )}
                  <circle cx={x} cy={y} r="2.7" fill={hueOf(p.position)} stroke="#fff" strokeWidth="0.35"
                          opacity={unavailable ? 0.55 : 1} />
                  <text x={x} y={y + 0.8} fontSize="2" fill="#fff" textAnchor="middle" fontWeight="700" opacity={unavailable ? 0.7 : 1}>
                    {initials(p.fullName)}
                  </text>
                  {unavailable && (
                    <text x={x} y={y - 4.4} fontSize="1.9" fontWeight="800" textAnchor="middle"
                          fill={p.injuryWeeksLeft > 0 ? 'var(--danger)' : 'var(--warn)'}>
                      {p.injuryWeeksLeft > 0 ? `INJ ${p.injuryWeeksLeft}w` : 'SUS'}
                    </text>
                  )}
                  <text x={x} y={y + 5.6} fontSize="2.2" fontWeight="600" textAnchor="middle" fill="#1c2030"
                        stroke="#f0f6f1" strokeWidth="0.55" style={{ paintOrder: 'stroke' }}>
                    {shortName(p.fullName)}
                  </text>
                  {/* the two-bar fitness: condition over sharpness */}
                  <rect x={x - 4} y={y + 6.5} width="8" height="0.85" rx="0.4" fill="var(--line)" />
                  <rect x={x - 4} y={y + 6.5} width={8 * condition} height="0.85" rx="0.4" fill={tone(condition)} />
                  <rect x={x - 4} y={y + 7.75} width="8" height="0.85" rx="0.4" fill="var(--line)" />
                  <rect x={x - 4} y={y + 7.75} width={8 * sharp} height="0.85" rx="0.4"
                        fill={sharp >= 0.45 ? '#6172f3' : tone(sharp)} />
                </g>
              );
            })}
          </svg>
        </div>

        {/* the bench, FIFA-style, underneath — scrolls sideways in its box */}
        <div className="bench-strip" data-testid="bench-strip">
          <span className="bench-label">bench<br />{bench.length}/{LEAGUE_CFG.benchMax}</span>
          {Array.from({ length: LEAGUE_CFG.benchMax }, (_, i) => {
            const p = i < bench.length ? byId.get(bench[i]) : undefined;
            const loc: Loc = { kind: 'bench', index: i };
            if (!p) {
              return (
                <button
                  key={`empty-${i}`}
                  type="button"
                  className={`bench-chip empty${hover === locToData(loc) ? ' hover' : ''}`}
                  data-loc={locToData(loc)}
                  aria-label={`empty bench spot ${i + 1}`}
                  onClick={() => tap(loc)}
                >+</button>
              );
            }
            return (
              <button
                key={p.playerId}
                type="button"
                className={`bench-chip${highlightOf(p.playerId, loc)}`}
                data-loc={locToData(loc)}
                onClick={() => tap(loc, p.playerId)}
                onPointerDown={dragStart(p.playerId)}
              >
                <span className="chip-name">{shortName(p.fullName)}</span>
                <span className="chip-meta">
                  <PosChip position={p.position} />
                  <FitnessBars fatigue={p.fatigue} sharpness={p.sharpness} />
                </span>
                {badgeFor(p)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="pane pane-scroll editor-right lineup-side">
        {issues.length > 0 && (
          <ul className="issues" data-testid="issues">
            {[...new Set(issues.map((i) => ISSUE_TEXT[i.code] ?? i.code))].map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
        {onOpenPresets && (
          <p style={{ margin: '0 0 0.4rem' }}>
            <button type="button" onClick={onOpenPresets}>Start from a preset…</button>
          </p>
        )}
        <p className="muted lineup-hint">
          {picked
            ? `Moving ${shortName(byId.get(picked)?.fullName ?? '')} — tap who he replaces.`
            : 'Drag a player onto another to swap — or tap him, then tap his replacement. A swapped-in player inherits the slot’s phase anchors, sliders and zones.'}
        </p>
        <h3>Reserves</h3>
        <ul
          className="player-list reserves"
          data-loc="reserve:"
          data-testid="reserves"
          onClick={() => tap({ kind: 'reserve', playerId: null })}
        >
          {reserves.map((p) => (
            <li
              key={p.playerId}
              className={`player-row clickable${highlightOf(p.playerId, { kind: 'reserve', playerId: p.playerId })}`}
              data-loc={locToData({ kind: 'reserve', playerId: p.playerId })}
              onClick={(e) => { e.stopPropagation(); tap({ kind: 'reserve', playerId: p.playerId }, p.playerId); }}
              onPointerDown={dragStart(p.playerId)}
            >
              <span className="player-name">{p.fullName}</span>
              <span className="player-meta">
                <PosChip position={p.position} />
                <FitnessBars fatigue={p.fatigue} sharpness={p.sharpness} />
                {badgeFor(p)}
                {p.justReturned && <span className="badge badge-ret">RETURNING</span>}
              </span>
            </li>
          ))}
          {reserves.length === 0 && <li className="player-row muted">Everyone is in the matchday squad.</li>}
        </ul>
      </div>

      {drag?.active && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          {shortName(byId.get(drag.playerId)?.fullName ?? '')}
        </div>
      )}
    </div>
  );
}
