/**
 * playback.ts — pure replay-playback logic (no canvas, no React).
 *
 * Frames arrive per half (t is continuous across halves: 0..2700, 2700..5400)
 * at one frame per ~6 sim-seconds. interpolate() lerps between the two
 * surrounding frames so 4 Hz sampling doesn't look like teleportation.
 * Playback speed: 1x plays SIM_PER_REAL sim-seconds per wall second — a half
 * in ~3¾ minutes; 0.5x–4x scales that ("real-ish", not literal 45 minutes).
 */

import type { MatchEvent, ReplayFrame, Vec2 } from '@fm/engine/types';

/** sim-seconds advanced per wall-clock second at 1x speed */
export const SIM_PER_REAL = 12;
export const SPEEDS = [0.5, 1, 2, 4] as const;

export interface ReplayHalf {
  half: number;
  frames: ReplayFrame[];
}

export function stitchFrames(halves: ReplayHalf[]): ReplayFrame[] {
  return halves
    .slice()
    .sort((a, b) => a.half - b.half)
    .flatMap((h) => h.frames);
}

export interface Snapshot {
  ball: { x: number; y: number; flight: string };
  players: Record<string, Vec2>;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/**
 * Interpolated world state at sim-time t. Players present in only one of the
 * surrounding frames (halftime substitutions) snap instead of lerping.
 */
export function interpolate(frames: ReplayFrame[], t: number): Snapshot {
  if (frames.length === 0) return { ball: { x: 52.5, y: 34, flight: 'ground' }, players: {} };
  if (t <= frames[0].t) return frameSnapshot(frames[0]);
  if (t >= frames[frames.length - 1].t) return frameSnapshot(frames[frames.length - 1]);

  // binary search for the last frame with frame.t <= t
  let lo = 0;
  let hi = frames.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const span = b.t - a.t;
  // the halftime gap is not playable time — snap to the next half's start
  if (span <= 0 || span > 30) return frameSnapshot(b);
  const k = (t - a.t) / span;

  const players: Record<string, Vec2> = {};
  for (const [id, pa] of Object.entries(a.players)) {
    const pb = b.players[id];
    players[id] = pb ? { x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k) } : { ...pa };
  }
  for (const [id, pb] of Object.entries(b.players)) {
    if (!players[id]) players[id] = { ...pb }; // sub coming on mid-gap
  }
  return {
    ball: { x: lerp(a.ball.x, b.ball.x, k), y: lerp(a.ball.y, b.ball.y, k), flight: b.ball.flight },
    players,
  };
}

function frameSnapshot(f: ReplayFrame): Snapshot {
  return {
    ball: { x: f.ball.x, y: f.ball.y, flight: f.ball.flight },
    players: Object.fromEntries(Object.entries(f.players).map(([id, p]) => [id, { ...p }])),
  };
}

/** Score at sim-time t: goals by home-side players vs the rest. */
export function scoreAt(events: MatchEvent[], t: number, isHome: (playerId: string) => boolean): [number, number] {
  let home = 0;
  let away = 0;
  for (const e of events) {
    if (e.type !== 'goal' || e.t > t) continue;
    if (e.playerId && isHome(e.playerId)) home++;
    else away++;
  }
  return [home, away];
}

/** "MM:SS" sim clock (t in sim-seconds, 0..5400). */
export function clockLabel(t: number): string {
  const clamped = Math.max(0, Math.min(5400, t));
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Initials for the dot labels: "Bukayo Saka" → "BS", "Pedri" → "PE". */
export function initials(name: string | undefined): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export const TIMELINE_TYPES = new Set(['goal', 'shot', 'card', 'sub', 'setPiece', 'injury']);

/** Events worth a timeline marker, in playback order. */
export function keyEvents(events: MatchEvent[]): MatchEvent[] {
  return events
    .filter((e) => TIMELINE_TYPES.has(e.type))
    .slice()
    .sort((a, b) => a.t - b.t);
}
