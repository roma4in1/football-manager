/**
 * App.tsx — the workbench instrument (spec §4): scenario loader, live/stored
 * source toggle, transport (play/pause, scrub, slow-mo, single-tick step),
 * toggleable overlays, selected-body inspector. Behavioral judging happens
 * at slow speed — the controls are the point, not chrome.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DT, type Frame, type ScenarioDef } from '@fm/engine2/types';
import { decimate, decode, streamBytes } from '@fm/engine2/frames';
import { runScenario } from '@fm/engine2/sim';
import { SCENARIOS } from '@fm/engine2/scenarios';
import { draw, hitTest, type Overlays, type ViewState } from './render.ts';

const SPEEDS = [0.25, 0.5, 1] as const;

interface Loaded {
  def: ScenarioDef;
  live: Frame[];
  stored: Frame[];
  storedKB: number;
}

function load(def: ScenarioDef, seed: number): Loaded {
  const live = runScenario(def, `wb-${seed}`);
  const stream = decimate(live);
  return { def, live, stored: decode(stream), storedKB: Math.round(streamBytes(stream) / 1024) };
}

export function App() {
  const [seed, setSeed] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>(() => load(SCENARIOS[0], 0));
  const [source, setSource] = useState<'live' | 'stored'>('live');
  const [overlays, setOverlays] = useState<Overlays>({ velocity: true, targets: true, labels: true, hud: true });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(0.5);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, bump] = useState(0);

  const frames = source === 'live' ? loaded.live : loaded.stored;
  const tMax = (loaded.def.durationTicks - 1) * DT;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simT = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef<number>(speed);
  const viewRef = useRef<ViewState | null>(null);
  playingRef.current = playing;
  speedRef.current = speed;

  const reload = (def: ScenarioDef, s = seed) => {
    setLoaded(load(def, s));
    simT.current = 0;
    setPlaying(false);
    setSelectedId(null);
  };
  const reroll = (delta: number) => {
    const s = Math.max(0, seed + delta);
    setSeed(s);
    reload(loaded.def, s);
  };

  // playback + draw loop — interpolation is PRESENTATION ONLY (spec §3)
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let uiAccum = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playingRef.current) {
        simT.current = Math.min(tMax, simT.current + dt * speedRef.current);
        if (simT.current >= tMax) setPlaying(false);
      }
      const canvas = canvasRef.current;
      if (canvas && frames.length > 0) {
        // find the surrounding frames of simT (frames may be 10 Hz or 5 Hz)
        const t = simT.current;
        let lo = 0;
        let hi = frames.length - 1;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >> 1;
          if (frames[mid].t <= t) lo = mid;
          else hi = mid;
        }
        const prev = frames[lo];
        const next = frames[Math.min(lo + 1, frames.length - 1)];
        const span = Math.max(next.t - prev.t, 1e-9);
        const view: ViewState = {
          prev,
          next,
          k: Math.min(1, Math.max(0, (t - prev.t) / span)),
          overlays,
          selectedId,
          sourceLabel: source === 'live'
            ? 'LIVE 10 Hz'
            : `STORED 5 Hz · ${loaded.storedKB} KB`,
          clockT: t,
          tick: prev.tick,
        };
        viewRef.current = view;
        draw(canvas, view);
      }
      uiAccum += dt;
      if (uiAccum > 0.12) {
        uiAccum = 0;
        bump((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [frames, overlays, selectedId, source, loaded, tMax]);

  const stepTick = (dir: 1 | -1) => {
    setPlaying(false);
    const t = Math.round(simT.current / DT) * DT + dir * DT;
    simT.current = Math.min(tMax, Math.max(0, t));
    bump((n) => n + 1);
  };

  const t = simT.current;
  const curTick = Math.round(t / DT);
  const selBody = useMemo(() => {
    if (!selectedId) return null;
    const idx = Math.min(curTick, loaded.live.length - 1);
    return loaded.live[idx]?.bodies.find((b) => b.id === selectedId) ?? null;
  }, [selectedId, curTick, loaded]);

  return (
    <div className="wb">
      <aside className="wb-side">
        <h1>Engine V2 workbench</h1>
        <div className="wb-sub">L1 · movement kinematics</div>

        <label className="wb-label">Scenario</label>
        <select
          value={loaded.def.name}
          onChange={(e) => reload(SCENARIOS.find((s) => s.name === e.target.value)!)}
        >
          {SCENARIOS.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <p className="wb-desc">{loaded.def.description}</p>

        <label className="wb-label">Seed — stochastic drills differ per roll</label>
        <div className="wb-row">
          <button onClick={() => reroll(-1)}>−</button>
          <span className="wb-seed">#{seed}</span>
          <button onClick={() => reroll(1)}>+</button>
        </div>

        <label className="wb-label">Source</label>
        <div className="wb-row">
          {(['live', 'stored'] as const).map((s) => (
            <button key={s} className={source === s ? 'active' : ''} onClick={() => setSource(s)}>
              {s === 'live' ? 'live 10 Hz' : 'stored 5 Hz'}
            </button>
          ))}
        </div>

        <label className="wb-label">Overlays</label>
        {(Object.keys(overlays) as Array<keyof Overlays>).map((k) => (
          <label key={k} className="wb-check">
            <input
              type="checkbox"
              checked={overlays[k]}
              onChange={(e) => setOverlays({ ...overlays, [k]: e.target.checked })}
            />
            {k === 'velocity' ? 'velocity vectors' : k === 'targets' ? 'movement targets' : k === 'labels' ? 'id + regime labels' : 'tick / clock HUD'}
          </label>
        ))}

        {selBody && (
          <div className="wb-inspect">
            <div className="wb-label">selected · {selBody.id}</div>
            <div>pos {selBody.x.toFixed(1)}, {selBody.y.toFixed(1)}</div>
            <div>speed {Math.hypot(selBody.vx, selBody.vy).toFixed(2)} m/s</div>
            <div>regime {selBody.regime} · {selBody.stance}</div>
            {selBody.tx !== undefined && <div>target {selBody.tx.toFixed(1)}, {selBody.ty!.toFixed(1)}</div>}
          </div>
        )}
        <div className="wb-hint">click a body to inspect · judge at 0.25–0.5×</div>
      </aside>

      <main className="wb-main">
        <canvas
          ref={canvasRef}
          className="wb-canvas"
          onClick={(e) => {
            if (viewRef.current && canvasRef.current) {
              setSelectedId(hitTest(canvasRef.current, viewRef.current, e.clientX, e.clientY));
            }
          }}
        />
        <div className="wb-transport">
          <button className="wb-play" onClick={() => setPlaying(!playing)}>{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => stepTick(-1)} title="back one tick">⟨</button>
          <button onClick={() => stepTick(1)} title="forward one tick">⟩</button>
          {SPEEDS.map((s) => (
            <button key={s} className={s === speed ? 'active' : ''} onClick={() => setSpeed(s)}>{s}×</button>
          ))}
          <input
            type="range"
            min={0}
            max={tMax}
            step={DT}
            value={t}
            onChange={(e) => {
              setPlaying(false);
              simT.current = Number(e.currentTarget.value);
              bump((n) => n + 1);
            }}
          />
          <span className="wb-clock">tick {curTick} · {t.toFixed(1)}s / {tMax.toFixed(0)}s</span>
        </div>
      </main>
    </div>
  );
}
