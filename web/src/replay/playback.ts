/**
 * playback.ts — pure replay-playback logic (no canvas, no React).
 *
 * Frames arrive per half (t is continuous across halves: 0..2700, 2700..5400)
 * at one frame per ~6 sim-seconds. interpolate() runs a Catmull-Rom spline
 * through the surrounding four keyframes, so players move in continuous
 * curves instead of straight segments that snap direction at every keyframe
 * (the old linear lerp — the "wave-like/rigid" look). The ball flies STRAIGHT
 * whenever a segment endpoint is airborne (a kicked ball doesn't curve), and
 * splines only across carried, on-ground segments.
 *
 * Possession is INFERRED (carrierAt): frames carry no carrierId — the
 * nearest player within CARRY_RADIUS_M of an on-ground ball is presented as
 * the carrier. If inference ever proves flickery, the honest fix is the
 * engine emitting ball.carrierId per frame (one field in agent-engine's
 * frame()) — deliberately NOT done in this viewer-only pass.
 *
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

/** Uniform Catmull-Rom through p1→p2 (p0/p3 are the neighbor keyframes). */
function catmullRom(p0: number, p1: number, p2: number, p3: number, k: number): number {
  const k2 = k * k;
  const k3 = k2 * k;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * k +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * k2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * k3
  );
}

const PLAYABLE_GAP_S = 30; // wider gaps (halftime) snap instead of interpolating

/**
 * Interpolated world state at sim-time t. Players move on a Catmull-Rom
 * curve through the two neighbor keyframes (duplicated at ends/halftime, so
 * a two-frame segment degenerates to a smooth Hermite whose midpoint equals
 * the old lerp). Players present in only one of the surrounding frames
 * (halftime substitutions) snap instead of interpolating.
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
  if (span <= 0 || span > PLAYABLE_GAP_S) return frameSnapshot(b);
  const k = (t - a.t) / span;

  // neighbor keyframes for the spline — only across playable gaps
  const prev = lo > 0 && a.t - frames[lo - 1].t <= PLAYABLE_GAP_S ? frames[lo - 1] : a;
  const next = hi < frames.length - 1 && frames[hi + 1].t - b.t <= PLAYABLE_GAP_S ? frames[hi + 1] : b;

  const players: Record<string, Vec2> = {};
  for (const [id, pa] of Object.entries(a.players)) {
    const pb = b.players[id];
    if (!pb) {
      players[id] = { ...pa }; // sub going off mid-gap: hold
      continue;
    }
    const p0 = prev.players[id] ?? pa;
    const p3 = next.players[id] ?? pb;
    players[id] = {
      x: catmullRom(p0.x, pa.x, pb.x, p3.x, k),
      y: catmullRom(p0.y, pa.y, pb.y, p3.y, k),
    };
  }
  for (const [id, pb] of Object.entries(b.players)) {
    if (!players[id]) players[id] = { ...pb }; // sub coming on mid-gap
  }

  // the ball: spline only while carried on the ground at BOTH ends — a
  // kicked ball (either endpoint airborne) flies straight, it doesn't curve
  const grounded = a.ball.flight === 'ground' && b.ball.flight === 'ground';
  const b0 = grounded && prev.ball.flight === 'ground' ? prev.ball : a.ball;
  const b3 = grounded && next.ball.flight === 'ground' ? next.ball : b.ball;
  const ball = grounded
    ? { x: catmullRom(b0.x, a.ball.x, b.ball.x, b3.x, k), y: catmullRom(b0.y, a.ball.y, b.ball.y, b3.y, k) }
    : { x: lerp(a.ball.x, b.ball.x, k), y: lerp(a.ball.y, b.ball.y, k) };

  return {
    // flight from the NEARER endpoint — a landed pass reads as landed
    ball: { ...ball, flight: k < 0.5 ? a.ball.flight : b.ball.flight },
    players,
  };
}

/** Ball position at t (trail sampling) — full interpolate is cheap enough. */
export function ballAt(frames: ReplayFrame[], t: number): { x: number; y: number; flight: string } {
  return interpolate(frames, t).ball;
}

/** Nearest player counts as the carrier only this close to an on-ground ball. */
export const CARRY_RADIUS_M = 2.2;

/**
 * Possession inference (frames carry no carrierId): the nearest player to an
 * on-ground ball, within CARRY_RADIUS_M. Airborne ball → nobody has it.
 * The viewer adds hysteresis on top so possession doesn't flicker between
 * two close players.
 */
export function carrierAt(snap: Snapshot): { id: string; dist: number } | null {
  if (snap.ball.flight !== 'ground') return null;
  let best: { id: string; dist: number } | null = null;
  for (const [id, p] of Object.entries(snap.players)) {
    const d = Math.hypot(p.x - snap.ball.x, p.y - snap.ball.y);
    if (!best || d < best.dist) best = { id, dist: d };
  }
  return best && best.dist <= CARRY_RADIUS_M ? best : null;
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
