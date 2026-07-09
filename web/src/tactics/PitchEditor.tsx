/**
 * The pitch editor's canvas (DESIGN-BRIEF: the load-bearing screen).
 *
 * An anchor is a CENTER OF GRAVITY, not a pin: the selected player renders as
 * a dot inside a soft radial halo — "tends here, drifts toward ball and
 * space, returns here". Instructions influence (~60–80%, attribute-gated);
 * they never fully control, and the halo is what sets that expectation.
 *
 * Exactly one player is detailed at a time: the other ten are plain faded
 * dots at their current-phase anchor (no halos, no zones) — tap one to
 * promote it. Zones render with visible weight ("run target · 0.7"); the
 * whole team's shape morphs when the phase changes (the parent swaps the
 * anchors it passes).
 */

import { useRef } from 'react';
import type { InstructionZone, Phase, PlayerTactic, Vec2 } from '@fm/engine/types';

const W = 105;
const H = 68;

export interface PitchPlayer {
  tactic: PlayerTactic;
  name: string;
  position: string;
}

const GROUP_VAR: Record<string, string> = { G: 'var(--pos-gk)', D: 'var(--pos-df)', M: 'var(--pos-mf)', F: 'var(--pos-fw)' };
const hueOf = (position: string) => GROUP_VAR[position[0]] ?? 'var(--pos-mf)';
const initials = (name: string) =>
  name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

const ZONE_LABEL: Record<InstructionZone['zoneType'], string> = {
  runTarget: 'run target', operating: 'operating', pressing: 'pressing',
};

export function PitchEditor({ players, phase, selectedId, onSelect, onMoveAnchor, onMoveZone }: {
  players: PitchPlayer[];
  phase: Phase;
  selectedId: string | null;
  onSelect: (playerId: string) => void;
  onMoveAnchor: (playerId: string, at: Vec2) => void;
  onMoveZone: (playerId: string, zoneIndex: number, at: Vec2) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: 'anchor' | 'zone'; zoneIndex?: number } | null>(null);

  const toPitch = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(W, ((e.clientX - rect.left) / rect.width) * W)),
      y: Math.max(0, Math.min(H, ((e.clientY - rect.top) / rect.height) * H)),
    };
  };

  const selected = players.find((p) => p.tactic.playerId === selectedId) ?? null;
  const zones = selected?.tactic.zones[phase] ?? [];

  const centroid = (poly: Vec2[]): Vec2 => ({
    x: poly.reduce((s, v) => s + v.x, 0) / poly.length,
    y: poly.reduce((s, v) => s + v.y, 0) / poly.length,
  });

  return (
    <svg
      ref={svgRef}
      className="pitch"
      viewBox={`0 0 ${W} ${H}`}
      onPointerMove={(e) => {
        if (!drag.current || !selected) return;
        const at = toPitch(e);
        if (drag.current.kind === 'anchor') onMoveAnchor(selected.tactic.playerId, at);
        else onMoveZone(selected.tactic.playerId, drag.current.zoneIndex!, at);
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerLeave={() => { drag.current = null; }}
    >
      <defs>
        <radialGradient id="halo">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="65%" stopColor="var(--accent)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* the pitch */}
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

      {/* selected player's zones — visible weight, draggable by centroid */}
      {selected && zones.map((z, i) => {
        const c = centroid(z.polygon);
        return (
          <g key={i}>
            <polygon
              points={z.polygon.map((v) => `${v.x},${v.y}`).join(' ')}
              fill="var(--accent)" fillOpacity={0.08 + 0.18 * z.weight}
              stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="0.3" strokeDasharray="1.2 0.9"
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => { e.stopPropagation(); drag.current = { kind: 'zone', zoneIndex: i }; }}
            />
            <text x={c.x} y={c.y} fontSize="2.4" fill="var(--accent-deep)" textAnchor="middle">
              {ZONE_LABEL[z.zoneType]} · {z.weight.toFixed(1)}
            </text>
          </g>
        );
      })}

      {/* the other ten: plain faded dots — tap to promote */}
      {players.filter((p) => p.tactic.playerId !== selectedId).map((p) => {
        const at = p.tactic.anchors[phase];
        return (
          <g key={p.tactic.playerId} opacity="0.3" style={{ cursor: 'pointer' }}
             onPointerDown={() => onSelect(p.tactic.playerId)}>
            <circle cx={at.x} cy={at.y} r="2.4" fill={hueOf(p.position)} />
            <text x={at.x} y={at.y + 0.75} fontSize="1.9" fill="#fff" textAnchor="middle" fontWeight="700">
              {initials(p.name)}
            </text>
          </g>
        );
      })}

      {/* the selected player: gravity halo + draggable anchor */}
      {selected && (() => {
        const at = selected.tactic.anchors[phase];
        return (
          <g style={{ cursor: 'grab' }}
             onPointerDown={(e) => { e.stopPropagation(); drag.current = { kind: 'anchor' }; onMoveAnchor(selected.tactic.playerId, toPitch(e)); }}>
            <circle cx={at.x} cy={at.y} r="10" fill="url(#halo)" />
            <circle cx={at.x} cy={at.y} r="7" fill="none" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="0.25" strokeDasharray="0.9 0.9" />
            <circle cx={at.x} cy={at.y} r="2.8" fill={hueOf(selected.position)} stroke="var(--accent-deep)" strokeWidth="0.45" />
            <text x={at.x} y={at.y + 0.8} fontSize="2.1" fill="#fff" textAnchor="middle" fontWeight="700">
              {initials(selected.name)}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}
