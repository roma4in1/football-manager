/**
 * kinematics.test.ts — L1 unit assertions where crisp expectations exist
 * (spec §6): speed caps respected, acceleration honesty, braking bounds,
 * turning radius scaling with speed, standstill pivots allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DT, type BodyState, type MovementCommand } from './engine2-types.ts';
import {
  accelPeakMps2,
  brakePeakMps2,
  lateralGripMps2,
  normalizeAngle,
  regimeCapMps,
  stepBody,
  topSpeedMps,
  turningRadiusM,
} from './kinematics.ts';

const mkBody = (
  attrs: Partial<BodyState['attributes']> = {},
  pos = { x: 10, y: 34 },
  command: MovementCommand = { type: 'hold' },
): BodyState => ({
  id: 'b',
  team: 'home',
  attributes: { pace: 12, acceleration: 12, agility: 12, stamina: 12, ...attrs },
  pos: { ...pos },
  vel: { x: 0, y: 0 },
  speed: 0,
  facing: 0,
  regime: 'walk',
  stance: 'settled',
  command,
  pathIndex: 0,
  arrived: false,
  arrivedAtTick: -1,
});

const run = (body: BodyState, ticks: number, onTick?: (b: BodyState, t: number) => void): void => {
  for (let t = 0; t < ticks; t++) {
    stepBody(body, t);
    onTick?.(body, t);
  }
};

test('attribute mapping lands in real football ranges — and extremes stay human', () => {
  assert.ok(Math.abs(topSpeedMps(20) - 10.2) < 0.01, 'elite top speed ~10.2 m/s');
  assert.ok(Math.abs(topSpeedMps(10) - 7.6) < 0.01, 'mid top speed ~7.6 m/s');
  assert.ok(topSpeedMps(1) > 4.5 && topSpeedMps(1) < 6, 'pace 1 still moves like a human');
  assert.ok(accelPeakMps2(20) <= 8.5, 'peak accel bounded');
  assert.ok(brakePeakMps2(20) > accelPeakMps2(20), 'braking beats accelerating');
  assert.ok(turningRadiusM(12, 9) > turningRadiusM(12, 4), 'radius grows with speed');
});

test('a long sprint reaches and RESPECTS the top-speed cap', () => {
  const body = mkBody({ pace: 16 }, { x: 5, y: 34 }, { type: 'moveTo', target: { x: 100, y: 34 }, regime: 'sprint' });
  const vmax = topSpeedMps(16);
  let peak = 0;
  run(body, 100, (b) => {
    peak = Math.max(peak, b.speed);
    assert.ok(b.speed <= vmax + 1e-9, `speed ${b.speed} never exceeds vmax ${vmax}`);
  });
  assert.ok(peak >= 0.95 * vmax, `a 95m sprint approaches top speed (peak ${peak.toFixed(2)} vs ${vmax.toFixed(2)})`);
});

test('acceleration honesty: 90% of top speed in 2–4.5 s for a mid profile', () => {
  const body = mkBody({ pace: 12, acceleration: 12 }, { x: 5, y: 34 }, { type: 'moveTo', target: { x: 100, y: 34 }, regime: 'sprint' });
  const vmax = topSpeedMps(12);
  let reachedAt = -1;
  run(body, 80, (b, t) => {
    if (reachedAt < 0 && b.speed >= 0.9 * vmax) reachedAt = t;
  });
  assert.ok(reachedAt > 0, 'reaches 90% of vmax');
  const secs = reachedAt * DT;
  assert.ok(secs >= 2 && secs <= 4.5, `90% vmax in ${secs.toFixed(1)}s (want 2–4.5s — sprint physics, not teleports)`);
});

test('regime caps are distinct and ordered for one body', () => {
  const caps = (['walk', 'jog', 'run', 'sprint'] as const).map((r) => regimeCapMps(14, r));
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i] > caps[i - 1] + 0.5, `${caps[i]} > ${caps[i - 1]} — regimes visibly distinct`);
  }
});

test('turning radius scales with speed: the same 90° re-target arcs wider when faster', () => {
  const measureMinRadius = (regime: 'jog' | 'sprint'): number => {
    const body = mkBody({ agility: 12 }, { x: 10, y: 20 }, { type: 'moveTo', target: { x: 95, y: 20 }, regime });
    run(body, 40); // reach cruise going +x
    body.command = { type: 'moveTo', target: { x: body.pos.x, y: 65 }, regime }; // 90° re-target
    let minR = Infinity;
    let prevHeading = Math.atan2(body.vel.y, body.vel.x);
    run(body, 30, (b) => {
      if (b.speed < 1) return;
      const heading = Math.atan2(b.vel.y, b.vel.x);
      const dTheta = Math.abs(normalizeAngle(heading - prevHeading));
      prevHeading = heading;
      if (dTheta > 1e-4) minR = Math.min(minR, (b.speed * DT) / dTheta);
    });
    return minR;
  };
  const rJog = measureMinRadius('jog');
  const rSprint = measureMinRadius('sprint');
  assert.ok(rSprint > rJog * 1.5, `sprint turn radius ${rSprint.toFixed(1)}m ≫ jog ${rJog.toFixed(1)}m`);
});

test('no instantaneous direction change: per-tick heading delta obeys grip while moving', () => {
  const body = mkBody({}, { x: 10, y: 34 }, { type: 'moveTo', target: { x: 90, y: 34 }, regime: 'sprint' });
  run(body, 35);
  const grip = lateralGripMps2(12);
  body.command = { type: 'moveTo', target: { x: 10, y: 34 }, regime: 'sprint' }; // 180°
  let prev: { heading: number; speed: number } | null = { heading: Math.atan2(body.vel.y, body.vel.x), speed: body.speed };
  run(body, 60, (b) => {
    if (b.speed < 1.4) {
      prev = null; // pivot-speed domain: the floor governs there; re-baseline after
      return;
    }
    const heading = Math.atan2(b.vel.y, b.vel.x);
    if (prev !== null) {
      const dTheta = Math.abs(normalizeAngle(heading - prev.heading));
      // the integrator bounds the step by the PRE-step speed
      const omegaCap = (grip / Math.max(prev.speed, 1.3)) * DT;
      assert.ok(dTheta <= omegaCap + 1e-6, `heading step ${dTheta.toFixed(3)} ≤ grip bound ${omegaCap.toFixed(3)} at v=${b.speed.toFixed(1)}`);
    }
    prev = { heading, speed: b.speed };
  });
});

test('arrival: decelerate-to-arrive stops AT the target — no overshoot, no orbit', () => {
  for (const distM of [8, 25, 55]) {
    const body = mkBody({}, { x: 20, y: 34 }, { type: 'moveTo', target: { x: 20 + distM, y: 34 }, regime: 'run' });
    let maxX = 20;
    run(body, 300, (b) => {
      maxX = Math.max(maxX, b.pos.x);
    });
    assert.ok(body.arrived, `${distM}m run arrives`);
    assert.ok(body.speed <= 0.25, 'settled after arrival');
    const over = maxX - (20 + distM);
    assert.ok(over <= 0.6, `${distM}m run overshoot ${over.toFixed(2)}m ≤ 0.6m`);
    assert.ok(Math.hypot(body.pos.x - (20 + distM), body.pos.y - 34) <= 0.5, 'rests at the marker');
  }
});

test('standstill pivot is allowed (a settled body turns in place, rate-limited)', () => {
  const body = mkBody({}, { x: 50, y: 34 }, { type: 'hold', facing: Math.PI });
  run(body, 1);
  assert.ok(Math.abs(body.facing) > 0.3, 'facing starts moving immediately');
  run(body, 10);
  assert.ok(Math.abs(normalizeAngle(body.facing - Math.PI)) < 0.05, 'reaches the commanded facing inside ~1s');
});
