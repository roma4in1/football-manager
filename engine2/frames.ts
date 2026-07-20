/**
 * frames.ts — the stored/replayable format (spec §3): the sim's full-rate
 * frames decimated to 5 Hz and delta-compressed. Interpolation happens only
 * in presentation (the workbench), never in the sim.
 *
 * Encoding: frame 0 is a full keyframe; every later frame stores per-body
 * deltas as integer centimeters / centiradians against the PREVIOUS EMITTED
 * frame, omitting bodies that haven't moved past quantization. Regime/stance
 * changes ride along only when they change. Plain JSON — measured, not
 * hand-golfed; the budget is a few MB per 90-minute match (§7).
 */

import { REGIMES, type EffortRegime, type Frame } from './engine2-types.ts';

const BALL_PHASES = ['carried', 'rolling', 'airborne', 'dead'] as const;

export interface DecimatedStream {
  version: 1;
  hz: number;
  /** body ids in emission order — delta rows reference by index */
  ids: string[];
  /** team per body, parallel to ids */
  teams: ('home' | 'away')[];
  /** full keyframe: [x, y, facing, regimeIdx] per body — cm, deciradians.
   * Stance is NOT stored: it is a derived presentation signal, recomputable
   * from motion (storing it cost ~20% of the stream for zero information). */
  key: number[][];
  keyTick: number;
  /** per emitted frame: rows [bodyIdx, dx, dy, dfacing, regimeIdx]
   * (cm / decirad deltas); unchanged bodies are omitted */
  deltas: number[][][];
  /** ticks of the emitted frames after the keyframe */
  ticks: number[];
  /** ball keyframe: [x, y, z, phaseIdx, carrierIdx] (cm; carrierIdx into ids,
   * −1 = loose) */
  ballKey: number[];
  /** per emitted frame: [dx, dy, dz, phaseIdx, carrierIdx] — empty row when
   * nothing moved past quantization */
  ballDeltas: number[][];
}

const q = (v: number): number => Math.round(v * 100);
const qa = (v: number): number => Math.round(v * 10); // deciradians (~5.7°) — plenty for a facing cue

export function decimate(frames: Frame[], everyN = 2): DecimatedStream {
  if (frames.length === 0) throw new Error('no frames');
  const picked = frames.filter((_, i) => i % everyN === 0);
  const first = picked[0];
  const ids = first.bodies.map((b) => b.id);
  const teams = first.bodies.map((b) => b.team);
  const key = first.bodies.map((b) => [q(b.x), q(b.y), qa(b.facing), REGIMES.indexOf(b.regime)]);

  const ballRow = (f: Frame): number[] => [
    q(f.ball.x), q(f.ball.y), q(f.ball.z),
    BALL_PHASES.indexOf(f.ball.phase),
    f.ball.carrierId === null ? -1 : ids.indexOf(f.ball.carrierId),
  ];
  const ballKey = ballRow(first);

  const prev = key.map((row) => [...row]);
  let prevBall = [...ballKey];
  const deltas: number[][][] = [];
  const ballDeltas: number[][] = [];
  const ticks: number[] = [];
  for (let f = 1; f < picked.length; f++) {
    const rows: number[][] = [];
    picked[f].bodies.forEach((b, i) => {
      const cur = [q(b.x), q(b.y), qa(b.facing), REGIMES.indexOf(b.regime)];
      const [px, py, pf, pr] = prev[i];
      if (cur[0] === px && cur[1] === py && cur[2] === pf && cur[3] === pr) return;
      rows.push([i, cur[0] - px, cur[1] - py, cur[2] - pf, cur[3]]);
      prev[i] = cur;
    });
    deltas.push(rows);
    const cb = ballRow(picked[f]);
    ballDeltas.push(
      cb.every((v, j) => v === prevBall[j])
        ? []
        : [cb[0] - prevBall[0], cb[1] - prevBall[1], cb[2] - prevBall[2], cb[3], cb[4]],
    );
    prevBall = cb;
    ticks.push(picked[f].tick);
  }
  return { version: 1, hz: Math.round(1 / (everyN * 0.1)), ids, teams, key, keyTick: first.tick, deltas, ticks, ballKey, ballDeltas };
}

/** Decode back to (quantized) frames — the round-trip proof + the workbench's
 * stored-frames path. Stance is derived (settled below a small motion delta),
 * velocities are presentation-derived from successive positions. */
export function decode(stream: DecimatedStream): Frame[] {
  const cur = stream.key.map((row) => [...row]);
  const curBall = [...stream.ballKey];
  const mk = (tick: number, moved: (i: number) => boolean): Frame => ({
    tick,
    t: tick / 10,
    bodies: stream.ids.map((id, i) => ({
      id,
      team: stream.teams[i],
      x: cur[i][0] / 100,
      y: cur[i][1] / 100,
      vx: 0, // velocities are not stored — presentation derives motion from positions
      vy: 0,
      facing: cur[i][2] / 10,
      regime: REGIMES[cur[i][3]] as EffortRegime,
      stance: moved(i) ? 'moving' as const : 'settled' as const,
    })),
    ball: {
      x: curBall[0] / 100,
      y: curBall[1] / 100,
      z: curBall[2] / 100,
      phase: BALL_PHASES[curBall[3]],
      carrierId: curBall[4] < 0 ? null : stream.ids[curBall[4]],
    },
  });
  const frames: Frame[] = [mk(stream.keyTick, () => false)];
  stream.deltas.forEach((rows, f) => {
    const movedSet = new Set<number>();
    for (const [i, dx, dy, df, r] of rows) {
      cur[i][0] += dx;
      cur[i][1] += dy;
      cur[i][2] += df;
      cur[i][3] = r;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedSet.add(i);
    }
    const bd = stream.ballDeltas[f];
    if (bd.length > 0) {
      curBall[0] += bd[0];
      curBall[1] += bd[1];
      curBall[2] += bd[2];
      curBall[3] = bd[3];
      curBall[4] = bd[4];
    }
    frames.push(mk(stream.ticks[f], (i) => movedSet.has(i)));
  });
  return frames;
}

/** serialized size in bytes — the §7 storage measurement */
export const streamBytes = (stream: DecimatedStream): number =>
  new TextEncoder().encode(JSON.stringify(stream)).length;
