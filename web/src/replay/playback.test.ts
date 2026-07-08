import { describe, expect, it } from 'vitest';
import type { MatchEvent, ReplayFrame } from '@fm/engine/types';
import { clockLabel, initials, interpolate, keyEvents, scoreAt, stitchFrames } from './playback.ts';

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
