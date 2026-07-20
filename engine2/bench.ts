/**
 * bench.ts — the §7 profile, run at L1 as mandated: ms/tick for 22 bodies at
 * 10 Hz and the projected full-match sim time, plus the decimated-stream
 * storage projection. `pnpm --filter @fm/engine2 bench`.
 */
import { gzipSync } from 'node:zlib';
import { PITCH, type BodyInit, type ScenarioDef } from './engine2-types.ts';
import { decimate, streamBytes } from './frames.ts';
import { KeyedRng } from './keyed-rng.ts';
import { Sim } from './sim.ts';

const MATCH_TICKS = 54_000; // 90 min × 60 s × 10 Hz

const rng = new KeyedRng('bench');
const bodies: BodyInit[] = Array.from({ length: 22 }, (_, i) => ({
  id: `p${i}`,
  team: i < 11 ? 'home' : 'away',
  pos: { x: 5 + rng.float(0, `p${i}`, 'x') * (PITCH.length - 10), y: 4 + rng.float(0, `p${i}`, 'y') * (PITCH.width - 8) },
  attributes: {
    pace: 8 + Math.floor(rng.float(0, `p${i}`, 'pace') * 12),
    acceleration: 8 + Math.floor(rng.float(0, `p${i}`, 'acc') * 12),
    agility: 8 + Math.floor(rng.float(0, `p${i}`, 'agi') * 12),
    balance: 8 + Math.floor(rng.float(0, `p${i}`, 'bal') * 12),
    dribbling: 8 + Math.floor(rng.float(0, `p${i}`, 'dri') * 12),
    firstTouch: 12, passing: 12, tackling: 12, strength: 12,
    stamina: 12,
  },
}));

const def: ScenarioDef = { version: 1, name: 'bench-22', description: 'profiling', durationTicks: MATCH_TICKS, bodies, script: [] };
const sim = new Sim(def, 'bench');

// continuous work: every body re-targeted every 2 s (the busiest realistic
// command churn a match would issue), keyed so the run is reproducible
const regimes = ['walk', 'jog', 'run', 'sprint'] as const;
const frames = [];
const t0 = performance.now();
for (let tick = 0; tick < MATCH_TICKS; tick++) {
  if (tick % 20 === 0) {
    for (const b of sim.bodies) {
      b.command = {
        type: 'moveTo',
        target: {
          x: 5 + rng.float(tick, b.id, 'tx') * (PITCH.length - 10),
          y: 4 + rng.float(tick, b.id, 'ty') * (PITCH.width - 8),
        },
        regime: regimes[Math.floor(rng.float(tick, b.id, 'reg') * 4)],
      };
      b.arrived = false;
      b.arrivedAtTick = -1;
      b.pathIndex = 0;
    }
  }
  frames.push(sim.step());
}
const elapsedMs = performance.now() - t0;

const stream = decimate(frames);
const bytes = streamBytes(stream);

console.log(JSON.stringify({
  bodies: 22,
  ticks: MATCH_TICKS,
  totalMs: +elapsedMs.toFixed(1),
  usPerTick: +((elapsedMs * 1000) / MATCH_TICKS).toFixed(2),
  projectedFullMatchSeconds: +(elapsedMs / 1000).toFixed(2),
  budgetSeconds: 180,
  budgetHeadroom: +((180 * 1000) / elapsedMs).toFixed(0) + 'x',
  decimatedStreamMB: +(bytes / 1_048_576).toFixed(2),
  decimatedGzipMB: +(gzipSync(JSON.stringify(stream)).length / 1_048_576).toFixed(2),
  fullRateFramesMB: +(JSON.stringify(frames).length / 1_048_576).toFixed(1),
}, null, 2));
