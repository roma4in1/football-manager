/**
 * scenarios.test.ts — the scenario library's crisp assertions (spec §6 use b):
 * chase outcomes follow from physics, regimes are ordered, shuttles plant and
 * return, curved runs never pivot-teleport, arrivals don't overshoot. The
 * PRIMARY acceptance for these scenarios is the workbench eye; these
 * assertions are the regression floor under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, type Frame } from './engine2-types.ts';
import { topSpeedMps, regimeCapMps } from './kinematics.ts';
import { runScenario } from './sim.ts';
import { scenarioByName, SCENARIOS } from './scenarios/index.ts';

const body = (f: Frame, id: string) => {
  const b = f.bodies.find((x) => x.id === id);
  assert.ok(b, `body ${id} in frame`);
  return b;
};

/** first tick a body is within tol of a point AND practically stopped */
function arrivalTick(frames: Frame[], id: string, x: number, y: number, tol = 0.6): number {
  for (const f of frames) {
    const b = body(f, id);
    if (Math.hypot(b.x - x, b.y - y) <= tol && Math.hypot(b.vx, b.vy) <= 0.3) return f.tick;
  }
  return -1;
}

/** first tick a body comes within reach of a point (stopped or not) — race semantics */
function reachTick(frames: Frame[], id: string, x: number, y: number, tol = 0.6): number {
  for (const f of frames) {
    const b = body(f, id);
    if (Math.hypot(b.x - x, b.y - y) <= tol) return f.tick;
  }
  return -1;
}

test('every scenario is v1, runs its full duration, and keeps bodies on-pitch-sane', () => {
  for (const def of SCENARIOS) {
    const frames = runScenario(def, 'assert');
    assert.equal(frames.length, def.durationTicks);
    for (const f of frames) {
      for (const b of f.bodies) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), `${def.name}: finite positions`);
        assert.ok(b.x > -5 && b.x < 110 && b.y > -5 && b.y < 73, `${def.name}: ${b.id} stays near the pitch`);
      }
    }
  }
});

test('continuity everywhere: no body ever moves farther in one tick than physics allows', () => {
  for (const def of SCENARIOS) {
    const frames = runScenario(def, 'assert');
    // movement at vmax PLUS the capped per-tick separation displacement
    // (press scrums collide at sprint — a nudge while at top speed is
    // physics, not a teleport)
    const caps = new Map(def.bodies.map((b) => [b.id, topSpeedMps(b.attributes.pace) * DT + 0.5 + 1e-6]));
    for (let i = 1; i < frames.length; i++) {
      for (const b of frames[i].bodies) {
        const p = body(frames[i - 1], b.id);
        const step = Math.hypot(b.x - p.x, b.y - p.y);
        assert.ok(step <= caps.get(b.id)!, `${def.name}: ${b.id} teleported ${step.toFixed(2)}m in one tick`);
      }
    }
  }
});

test('shuttle-runs: both runners complete two full laps with planted stops at each end', () => {
  const def = scenarioByName('shuttle-runs');
  const frames = runScenario(def, 'assert');
  // final resting place is the start marker (lap 2 return complete)
  const last = frames[frames.length - 1];
  for (const [id, y] of [['mid', 28], ['elite', 40]] as const) {
    const b = body(last, id);
    assert.ok(Math.hypot(b.x - 20, b.y - y) < 0.7, `${id} back home (at ${b.x.toFixed(1)},${b.y.toFixed(1)})`);
    assert.ok(Math.hypot(b.vx, b.vy) < 0.3, `${id} settled`);
    // the far end was genuinely reached with a stop each lap: find a stopped
    // visit at x≈85 (the turn is a plant, not a fly-by)
    const stoppedAtFar = frames.some((f) => {
      const s = body(f, id);
      return Math.abs(s.x - 85) < 0.7 && Math.hypot(s.vx, s.vy) < 0.35;
    });
    assert.ok(stoppedAtFar, `${id} plants at the far end`);
  }
  // the elite profile finishes its whole shuttle meaningfully earlier: the
  // FINAL settle tick is the first frame after which the body never again
  // leaves its home marker
  const finalSettle = (id: string, y: number): number => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const b = body(frames[i], id);
      const home = Math.hypot(b.x - 20, b.y - y) <= 0.7 && Math.hypot(b.vx, b.vy) <= 0.3;
      if (!home) return frames[i + 1]?.tick ?? -1;
    }
    return 0;
  };
  const midDone = finalSettle('mid', 28);
  const eliteDone = finalSettle('elite', 40);
  assert.ok(eliteDone > 0 && midDone > 0 && eliteDone < midDone - 10, `elite (${eliteDone}) beats mid (${midDone}) by >1s`);
});

test('curved-run: the 90° re-target carves through intermediate headings (no snap)', () => {
  const def = scenarioByName('curved-run');
  const frames = runScenario(def, 'assert');
  // between the re-target (tick 60) and arrival, heading must pass through
  // the diagonal band — a pivot-teleport would jump 0 → −90° in a tick
  let sawDiagonal = false;
  for (let i = 61; i < 120; i++) {
    const b = body(frames[i], 'ninety');
    const speed = Math.hypot(b.vx, b.vy);
    if (speed < 1) continue;
    const heading = Math.atan2(b.vy, b.vx);
    if (heading > 0.35 && heading < 1.2) sawDiagonal = true; // toward +y after going +x
  }
  assert.ok(sawDiagonal, 'the turn traverses diagonal headings — an arc, not a snap');
  // the reverse runner must briefly BRAKE below jog cruise before heading back
  let minSpeedDuringTurn = Infinity;
  for (let i = 61; i < 110; i++) {
    const b = body(frames[i], 'reverse');
    minSpeedDuringTurn = Math.min(minSpeedDuringTurn, Math.hypot(b.vx, b.vy));
  }
  assert.ok(minSpeedDuringTurn < regimeCapMps(15, 'jog'), `180° forces a brake (min ${minSpeedDuringTurn.toFixed(1)} m/s)`);
  assert.ok(minSpeedDuringTurn > 0.05, 'but never a full freeze-frame stop mid-pitch');
});

test('arrival: all three runs stop at their markers without overshoot', () => {
  const def = scenarioByName('arrival');
  const frames = runScenario(def, 'assert');
  const marks: Array<[string, number, number]> = [['short', 40, 20], ['medium', 55, 34], ['long', 80, 48]];
  for (const [id, x, y] of marks) {
    assert.ok(arrivalTick(frames, id, x, y) > 0, `${id} arrives and settles`);
    let maxX = 0;
    for (const f of frames) maxX = Math.max(maxX, body(f, id).x);
    assert.ok(maxX <= x + 0.6, `${id} overshoot ${(maxX - x).toFixed(2)}m ≤ 0.6m`);
  }
});

test('chase: top speed wins the long heat, acceleration wins the short heat — by physics', () => {
  const def = scenarioByName('chase');
  const frames = runScenario(def, 'assert');
  const longSpeedster = reachTick(frames, 'long-speedster', 85, 24, 0.8);
  const longIgniter = reachTick(frames, 'long-igniter', 85, 30, 0.8);
  assert.ok(longSpeedster > 0 && longIgniter > 0, 'both finish the long heat');
  assert.ok(longSpeedster < longIgniter, `70m: pace 18 (${longSpeedster}) beats accel 18 (${longIgniter})`);
  const shortSpeedster = reachTick(frames, 'short-speedster', 38, 50, 0.8);
  const shortIgniter = reachTick(frames, 'short-igniter', 38, 56, 0.8);
  assert.ok(shortSpeedster > 0 && shortIgniter > 0, 'both finish the short heat');
  assert.ok(shortIgniter < shortSpeedster, `8m: accel 18 (${shortIgniter}) beats pace 18 (${shortSpeedster})`);
});

test('regimes: four distinct, ordered gaits — arrivals and cruise speeds both in strict order', () => {
  const def = scenarioByName('regimes');
  const frames = runScenario(def, 'assert');
  const order = ['sprint', 'run', 'jog', 'walk'] as const;
  const ys = { sprint: 56, run: 42, jog: 28, walk: 14 } as const;
  let prevTick = 0;
  let prevPeak = Infinity;
  for (const id of order) {
    const t = arrivalTick(frames, id, 85, ys[id]);
    assert.ok(t > prevTick, `${id} arrives after the faster regime (${t})`);
    prevTick = t;
    let peak = 0;
    for (const f of frames) {
      const b = body(f, id);
      peak = Math.max(peak, Math.hypot(b.vx, b.vy));
    }
    assert.ok(peak < prevPeak - 0.4, `${id} peak ${peak.toFixed(2)} clearly below the next regime up`);
    assert.ok(peak <= regimeCapMps(14, id) + 1e-6, `${id} respects its cap`);
    prevPeak = peak;
  }
});
