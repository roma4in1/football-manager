/**
 * ReplayViewer — one Canvas 2D component: top-down pitch, 22 interpolated
 * dots + ball, play/pause/scrub/speed, event timeline, score clock, stat
 * strip. Mobile-first (canvas fills the column, controls are thumb-sized).
 * Deliberately NOT broadcast-grade: no sprites, no camera, no commentary.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { HalfStats, MatchEvent } from '@fm/engine/types';
import { eventLabel } from '../format.ts';
import {
  ballAt,
  CARRY_RADIUS_M,
  carrierAt,
  clockLabel,
  initials,
  interpolate,
  keyEvents,
  scoreAt,
  SIM_PER_REAL,
  SPEEDS,
  stitchFrames,
  type ReplayHalf,
} from './playback.ts';

const PITCH_L = 105;
const PITCH_W = 68;

export interface ReplayViewerProps {
  halves: ReplayHalf[];
  events: MatchEvent[]; // both halves, t continuous
  statsByHalf: Record<number, HalfStats>;
  names: Record<string, string>;
  homePlayerIds: string[];
  homeName: string;
  awayName: string;
  /** cue playback ~6s before this sim-second (match detail's "watch" jump) */
  cueT?: number | null;
}

export function ReplayViewer({ halves, events, statsByHalf, names, homePlayerIds, homeName, awayName, cueT }: ReplayViewerProps) {
  const frames = useMemo(() => stitchFrames(halves), [halves]);
  const markers = useMemo(() => keyEvents(events), [events]);
  const homeSet = useMemo(() => new Set(homePlayerIds), [homePlayerIds]);
  const tMin = frames[0]?.t ?? 0;
  const tMax = frames[frames.length - 1]?.t ?? 5400;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carrierRef = useRef<string | null>(null); // possession hysteresis across draw frames
  const simT = useRef(tMin);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const [, forceUi] = useState(0); // clock/score/scrub re-render at ~10 Hz
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const setPlay = (p: boolean) => {
    playingRef.current = p;
    setPlaying(p);
  };
  const seek = (t: number) => {
    simT.current = Math.max(tMin, Math.min(tMax, t));
    forceUi((n) => n + 1);
  };

  // "watch" jump from the match-detail timeline: cue 6s before, roll
  useEffect(() => {
    if (cueT === null || cueT === undefined) return;
    simT.current = Math.max(tMin, Math.min(tMax, cueT - 6));
    playingRef.current = true;
    setPlaying(true);
    forceUi((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueT]);

  // playback + draw loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let uiAccum = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playingRef.current) {
        simT.current = Math.min(tMax, simT.current + dt * SIM_PER_REAL * speedRef.current);
        if (simT.current >= tMax) setPlay(false);
      }
      const canvas = canvasRef.current;
      if (canvas) {
        const snap = interpolate(frames, simT.current);
        // hysteresis: the last carrier keeps the ball while still plausibly
        // on it (radius + slack), so possession doesn't flicker between two
        // players closing on the same ball
        if (snap.carrier !== undefined) {
          carrierRef.current = snap.carrier; // engine truth — no inference needed
        } else {
          const prev = carrierRef.current;
          const prevPos = prev ? snap.players[prev] : undefined;
          const prevHolds =
            prevPos && snap.ball.flight === 'ground' &&
            Math.hypot(prevPos.x - snap.ball.x, prevPos.y - snap.ball.y) <= CARRY_RADIUS_M + 0.8;
          carrierRef.current = prevHolds ? prev : carrierAt(snap)?.id ?? null;
        }
        // short trail behind a moving ball — passes/shots/loose balls read
        // as the BALL travelling, not a glitch
        const trail = [
          ballAt(frames, simT.current - 0.35),
          ballAt(frames, simT.current - 0.7),
        ];
        draw(canvas, snap, homeSet, names, carrierRef.current, trail);
      }
      uiAccum += dt;
      if (uiAccum > 0.1) {
        uiAccum = 0;
        forceUi((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [frames, homeSet, names, tMax]);

  const t = simT.current;
  const [gh, ga] = scoreAt(events, t, (id) => homeSet.has(id));
  const half = t < 2700 ? 1 : 2;
  const stats = statsByHalf[half];
  // a goal owns the screen for a few seconds — the moment is unmissable and
  // the kickoff reset that follows reads as "after the goal", not a glitch
  const goalFlash = markers.find((e) => e.type === 'goal' && t >= e.t && t <= e.t + 6);

  return (
    <div className="replay">
      <div className="replay-head">
        <span className="replay-team home">{homeName} ▸</span>
        <span className="replay-score">{gh}–{ga}</span>
        <span className="replay-team away">◂ {awayName}</span>
        <span className="replay-clock">{clockLabel(t)}</span>
      </div>

      <div className="replay-canvas-wrap">
        <canvas ref={canvasRef} className="replay-canvas" />
        {goalFlash && (
          <div className="replay-goal-flash" role="status">
            <span className="replay-goal-word">GOAL</span>
            <span className="replay-goal-detail">
              {goalFlash.playerId ? names[goalFlash.playerId] ?? '' : ''} · {Math.max(1, Math.ceil(goalFlash.t / 60))}&#x2032; · {gh}–{ga}
            </span>
          </div>
        )}
      </div>

      <div className="replay-scrub">
        <div className="replay-markers">
          {markers.map((e, i) => (
            <button
              key={`${e.t}-${i}`}
              className={`replay-marker replay-marker-${e.type}${e.type === 'card' ? `-${String(e.meta?.card ?? 'yellow')}` : ''}`}
              style={{ left: `${((e.t - tMin) / (tMax - tMin)) * 100}%` }}
              title={eventLabel(e, names)}
              onClick={() => seek(e.t - 6)}
              aria-label={`jump to ${eventLabel(e, names)}`}
            />
          ))}
        </div>
        <input
          type="range"
          min={tMin}
          max={tMax}
          step={1}
          value={t}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          aria-label="scrub replay"
        />
      </div>

      <div className="replay-controls">
        <button className="replay-play" onClick={() => setPlay(!playing)}>
          {playing ? '❚❚' : '▶'}
        </button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={s === speed ? 'replay-speed active' : 'replay-speed'}
            onClick={() => {
              speedRef.current = s;
              setSpeed(s);
            }}
          >
            {s}x
          </button>
        ))}
        <span className="muted replay-halflabel">H{half}</span>
      </div>

      {stats && (
        <div className="replay-stats muted">
          <span>H{half} possession {stats.possession[0]}–{stats.possession[1]}</span>
          <span>shots {stats.shots[0]}–{stats.shots[1]}</span>
          <span>xG {stats.xg[0].toFixed(1)}–{stats.xg[1].toFixed(1)}</span>
        </div>
      )}

      <ul className="replay-events">
        {markers.map((e, i) => (
          <li key={`${e.t}-list-${i}`}>
            <button className="linklike" onClick={() => seek(e.t - 6)}>
              {clockLabel(e.t)} · {eventLabel(e, names)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── canvas drawing ───────────────────────────────────────────────────────────

const COLORS = {
  pitch: '#173225',
  line: 'rgba(232, 237, 242, 0.35)',
  home: '#3fae6a',
  away: '#d9a038',
  gkRing: '#e8edf2',
  ball: '#f2f2f2',
  label: '#0d1114',
};

function draw(
  canvas: HTMLCanvasElement,
  snap: ReturnType<typeof interpolate>,
  homeSet: Set<string>,
  names: Record<string, string>,
  carrierId: string | null,
  trail: Array<{ x: number; y: number }>,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = (cssW * PITCH_W) / PITCH_L;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || cssW === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = cssW / PITCH_L;
  const sy = cssH / PITCH_W;
  const X = (x: number) => x * sx;
  const Y = (y: number) => y * sy;

  // pitch
  ctx.fillStyle = COLORS.pitch;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(X(1), Y(1), X(103) - X(1), Y(67) - Y(1));
  ctx.beginPath();
  ctx.moveTo(X(52.5), Y(1));
  ctx.lineTo(X(52.5), Y(67));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(52.5), Y(34), X(9.15) - X(0), 0, Math.PI * 2);
  ctx.stroke();
  for (const gx of [0, 105 - 16.5]) {
    ctx.strokeRect(X(gx === 0 ? 1 : gx), Y(34 - 20.16), X(16.5) - (gx === 0 ? X(1) - X(0) : 0), Y(34 + 20.16) - Y(34 - 20.16));
  }
  for (const px of [11, 94]) {
    ctx.beginPath();
    ctx.arc(X(px), Y(34), 2, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.line;
    ctx.fill();
  }

  // players
  const r = Math.max(7, cssW / 46);
  ctx.font = `600 ${Math.max(7, r * 0.82)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [id, p] of Object.entries(snap.players)) {
    const home = homeSet.has(id);
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2);
    ctx.fillStyle = home ? COLORS.home : COLORS.away;
    ctx.fill();
    ctx.fillStyle = COLORS.label;
    ctx.fillText(initials(names[id]), X(p.x), Y(p.y) + 0.5);
  }

  // possession: a bright ring on the (inferred) carrier — dribbling reads as
  // ball + ring moving together; a pass is the ring vanishing while the ball
  // travels, then lighting up on the receiver
  const carrier = carrierId ? snap.players[carrierId] : undefined;
  if (carrier) {
    ctx.beginPath();
    ctx.arc(X(carrier.x), Y(carrier.y), r + 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.ball;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // trail while the ball travels (in flight OR fast on the ground) — a free
  // ball visibly MOVES, it doesn't look like a rendering bug
  const lofted = snap.ball.flight === 'lofted' || snap.ball.flight === 'high';
  const speed = trail.length > 0 ? Math.hypot(snap.ball.x - trail[0].x, snap.ball.y - trail[0].y) / 0.35 : 0;
  if (!carrier && (lofted || snap.ball.flight === 'driven' || speed > 4)) {
    trail.forEach((pos, i) => {
      ctx.beginPath();
      ctx.arc(X(pos.x), Y(pos.y), r * (0.32 - i * 0.1), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(242, 242, 242, ${0.35 - i * 0.15})`;
      ctx.fill();
    });
  }

  // the ball — lofted/high keeps its flight ring; a loose on-ground ball
  // (nobody within carry radius) gets a soft dashed halo so "no possession"
  // is a deliberate state, not a glitch
  ctx.beginPath();
  ctx.arc(X(snap.ball.x), Y(snap.ball.y), lofted ? r * 0.55 : r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.ball;
  ctx.fill();
  if (lofted) {
    ctx.beginPath();
    ctx.arc(X(snap.ball.x), Y(snap.ball.y), r * 0.95, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.ball;
    ctx.stroke();
  } else if (!carrier) {
    ctx.beginPath();
    ctx.arc(X(snap.ball.x), Y(snap.ball.y), r * 0.8, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(242, 242, 242, 0.45)';
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
