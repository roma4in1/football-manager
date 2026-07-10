import { describe, expect, it } from 'vitest';
import type { MatchEvent, ReplayFrame } from '@fm/engine/types';
import { ballAt, CARRY_RADIUS_M, carrierAt, clockLabel, initials, interpolate, keyEvents, scoreAt, stitchFrames } from './playback.ts';

const frame = (t: number, px: number, py = 30, ball = { x: px, y: py, flight: 'ground' as const }): ReplayFrame => ({
  t,
  ball,
  players: { p1: { x: px, y: py }, p2: { x: 100 - px, y: 60 } },
});

describe('interpolate', () => {
  it('lerps player and ball positions between surrounding frames', () => {
    const frames = [frame(0, 10), frame(6, 22)];
    const snap = interpolate(frames, 3);
    expect(snap.players.p1.x).toBeCloseTo(16);
    expect(snap.ball.x).toBeCloseTo(16);
  });

  it('clamps before the first and after the last frame', () => {
    const frames = [frame(6, 10), frame(12, 20)];
    expect(interpolate(frames, 0).players.p1.x).toBe(10);
    expect(interpolate(frames, 99).players.p1.x).toBe(20);
  });

  it('snaps across the halftime gap instead of lerping through it', () => {
    const frames = [frame(2694, 10), frame(2700, 90)]; // wait — same-half 6s gap lerps
    expect(interpolate(frames, 2697).players.p1.x).toBeCloseTo(50);
    const gap = [frame(2694, 10), frame(2760, 90)]; // 66 s apart = the HT boundary
    expect(interpolate(gap, 2727).players.p1.x).toBe(90); // snap to half-2 start
  });

  it('snaps players present in only one frame (halftime subs)', () => {
    const a: ReplayFrame = { t: 0, ball: { x: 50, y: 34, flight: 'ground' }, players: { p1: { x: 10, y: 10 } } };
    const b: ReplayFrame = { t: 6, ball: { x: 50, y: 34, flight: 'ground' }, players: { p1: { x: 20, y: 10 }, sub9: { x: 70, y: 40 } } };
    const snap = interpolate([a, b], 3);
    expect(snap.players.p1.x).toBeCloseTo(15);
    expect(snap.players.sub9).toEqual({ x: 70, y: 40 });
  });
});

describe('interpolate — spline motion', () => {
  it('curves through direction changes instead of snapping (Catmull-Rom)', () => {
    // p1 runs out and back: 0 → 10 → 10 → 0. Linear would sit exactly at 10
    // across the middle segment; the spline arcs through it.
    const frames = [frame(0, 0), frame(6, 10), frame(12, 10), frame(18, 0)];
    const mid = interpolate(frames, 9).players.p1.x;
    expect(mid).toBeGreaterThan(10); // continues the run's momentum
    expect(mid).toBeLessThan(11.5); // …but stays a curve, not a fling
  });

  it('is deterministic', () => {
    const frames = [frame(0, 0), frame(6, 10), frame(12, 4), frame(18, 20)];
    expect(interpolate(frames, 7.7)).toEqual(interpolate(frames, 7.7));
  });

  it('flies the ball STRAIGHT when a segment endpoint is airborne', () => {
    const a: ReplayFrame = { t: 0, ball: { x: 10, y: 10, flight: 'ground' }, players: { p1: { x: 0, y: 0 } } };
    const b: ReplayFrame = { t: 6, ball: { x: 30, y: 30, flight: 'lofted' }, players: { p1: { x: 0, y: 0 } } };
    const c: ReplayFrame = { t: 12, ball: { x: 50, y: 10, flight: 'ground' }, players: { p1: { x: 0, y: 0 } } };
    const snap = interpolate([a, b, c], 3);
    expect(snap.players.p1.x).toBe(0);
    expect(snap.ball.x).toBeCloseTo(20); // exact midpoint of the straight line
    expect(snap.ball.y).toBeCloseTo(20);
  });

  it('reports flight from the nearer endpoint', () => {
    const a: ReplayFrame = { t: 0, ball: { x: 10, y: 10, flight: 'lofted' }, players: {} };
    const b: ReplayFrame = { t: 6, ball: { x: 30, y: 30, flight: 'ground' }, players: {} };
    expect(interpolate([a, b], 1).ball.flight).toBe('lofted');
    expect(interpolate([a, b], 5).ball.flight).toBe('ground');
  });
});

describe('carrierAt', () => {
  const snapFor = (ballX: number, flight = 'ground') => ({
    ball: { x: ballX, y: 30, flight },
    players: { near: { x: 10, y: 30 }, far: { x: 60, y: 30 } },
  });

  it('names the nearest player within the carry radius of an on-ground ball', () => {
    expect(carrierAt(snapFor(11))?.id).toBe('near');
  });

  it('nobody carries an airborne ball', () => {
    expect(carrierAt(snapFor(11, 'lofted'))).toBeNull();
  });

  it('nobody carries a ball beyond the radius (loose ball)', () => {
    expect(carrierAt(snapFor(10 + CARRY_RADIUS_M + 0.1))).toBeNull();
  });

  it('picks the nearest of two candidates', () => {
    const snap = {
      ball: { x: 35.4, y: 30, flight: 'ground' },
      players: { a: { x: 34, y: 30 }, b: { x: 36, y: 30 } },
    };
    expect(carrierAt(snap)?.id).toBe('b');
  });
});

describe('interpolate — engine-emitted carrier', () => {
  const withCarrier = (t: number, px: number, carrier: string | null): ReplayFrame => ({
    t,
    ball: { x: px + 0.4, y: 30, flight: 'ground' },
    carrier,
    players: { p1: { x: px, y: 30 }, p2: { x: 80, y: 50 } },
  });

  it('same carrier both ends → ball glued to his interpolated dot', () => {
    const frames = [withCarrier(0, 10, 'p1'), withCarrier(6, 20, 'p1')];
    const snap = interpolate(frames, 3);
    expect(snap.carrier).toBe('p1');
    expect(snap.ball.x).toBeCloseTo(snap.players.p1.x);
    expect(snap.ball.y).toBeCloseTo(snap.players.p1.y);
  });

  it('carrier change → ball travels between the two moving players, in-transit', () => {
    const a = withCarrier(0, 10, 'p1');
    const b: ReplayFrame = {
      t: 6,
      ball: { x: 80, y: 50, flight: 'ground' },
      carrier: 'p2',
      players: { p1: { x: 10, y: 30 }, p2: { x: 80, y: 50 } },
    };
    const snap = interpolate([a, b], 3);
    expect(snap.carrier).toBeNull();
    expect(snap.ball.x).toBeCloseTo((snap.players.p1.x + snap.players.p2.x) / 2);
  });

  it('pre-carrier frames leave possession undefined (viewer infers)', () => {
    const frames = [frame(0, 10), frame(6, 22)];
    expect(interpolate(frames, 3).carrier).toBeUndefined();
  });

  it('released mid-gap: carrier reads from the nearer endpoint', () => {
    const frames = [withCarrier(0, 10, 'p1'), withCarrier(6, 20, null)];
    expect(interpolate(frames, 1).carrier).toBe('p1');
    expect(interpolate(frames, 5).carrier).toBeNull();
  });
});

describe('ballAt', () => {
  it('matches the full interpolation', () => {
    const frames = [frame(0, 10), frame(6, 22), frame(12, 30)];
    expect(ballAt(frames, 4)).toEqual(interpolate(frames, 4).ball);
  });
});

describe('stitchFrames', () => {
  it('orders halves and concatenates their frames', () => {
    const stitched = stitchFrames([
      { half: 2, frames: [frame(2700, 5)] },
      { half: 1, frames: [frame(0, 1), frame(6, 2)] },
    ]);
    expect(stitched.map((f) => f.t)).toEqual([0, 6, 2700]);
  });
});

describe('scoreAt', () => {
  const events: MatchEvent[] = [
    { t: 100, type: 'goal', playerId: 'h1' },
    { t: 3000, type: 'goal', playerId: 'a1' },
    { t: 5000, type: 'goal', playerId: 'h2' },
  ];
  const isHome = (id: string) => id.startsWith('h');

  it('counts only goals at or before t, split by side', () => {
    expect(scoreAt(events, 0, isHome)).toEqual([0, 0]);
    expect(scoreAt(events, 100, isHome)).toEqual([1, 0]);
    expect(scoreAt(events, 4000, isHome)).toEqual([1, 1]);
    expect(scoreAt(events, 5400, isHome)).toEqual([2, 1]);
  });
});

describe('labels', () => {
  it('clockLabel formats sim seconds as MM:SS and clamps', () => {
    expect(clockLabel(0)).toBe('00:00');
    expect(clockLabel(2700)).toBe('45:00');
    expect(clockLabel(5399)).toBe('89:59');
    expect(clockLabel(99999)).toBe('90:00');
  });

  it('initials handles full names, mononyms, and missing names', () => {
    expect(initials('Bukayo Saka')).toBe('BS');
    expect(initials('Pedri')).toBe('PE');
    expect(initials('Virgil van Dijk')).toBe('VD');
    expect(initials(undefined)).toBe('·');
  });
});

describe('keyEvents', () => {
  it('keeps timeline-worthy types in time order', () => {
    const events: MatchEvent[] = [
      { t: 300, type: 'shot', playerId: 'x' },
      { t: 100, type: 'goal', playerId: 'x' },
      { t: 200, type: 'kickoff' },
      { t: 150, type: 'card', playerId: 'y', meta: { card: 'yellow' } },
      { t: 400, type: 'pass', playerId: 'z' },
    ];
    expect(keyEvents(events).map((e) => e.type)).toEqual(['goal', 'card', 'shot']);
  });
});
