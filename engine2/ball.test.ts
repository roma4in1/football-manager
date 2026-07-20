/**
 * ball.test.ts — L2 physics assertions where crisp expectations exist:
 * rolling friction is monotone to rest, ballistic flight matches projectile
 * math, bounces decay by restitution into a roll, kicks release possession,
 * and the carry coupling scales touch length with speed and control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALL, kickBall, stepBall, type BallState } from './ball.ts';
import { runScenario } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import type { Frame } from './engine2-types.ts';

const mkBall = (): BallState => ({
  pos: { x: 30, y: 34 }, z: 0, vel: { x: 0, y: 0 }, vz: 0, phase: 'rolling', carrierId: null, kickerId: null, kickerLockUntilTick: 0,
});

test('a ground kick decelerates monotonically to rest — no gliding, no reversal', () => {
  const ball = mkBall();
  kickBall(ball, { x: 90, y: 34 }, 16, 0, 'tester', 0);
  assert.equal(ball.phase, 'rolling');
  let prev = Infinity;
  let ticks = 0;
  while (Math.hypot(ball.vel.x, ball.vel.y) > 0 && ticks < 200) {
    stepBall(ball);
    const s = Math.hypot(ball.vel.x, ball.vel.y);
    assert.ok(s <= prev + 1e-9, 'speed never increases while rolling');
    prev = s;
    ticks++;
  }
  const travelled = ball.pos.x - 30;
  // v²/(2a) = 16²/3.4 ≈ 75 m, discretization ±a few m
  assert.ok(Math.abs(travelled - 16 ** 2 / (2 * BALL.rollDecelMps2)) < 6, `roll-out ${travelled.toFixed(1)}m ≈ v²/2a`);
});

test('a lofted kick flies ballistically: range ≈ v²·sin(2θ)/g before the first bounce', () => {
  const ball = mkBall();
  kickBall(ball, { x: 100, y: 34 }, 20, 40, 'tester', 0);
  assert.equal(ball.phase, 'airborne');
  let ticks = 0;
  while (ball.phase === 'airborne' && ticks < 400) {
    stepBall(ball);
    ticks++;
    if (ball.z === 0 && ball.vz >= 0 && ticks > 2) break; // first ground contact handled
  }
  const range = ball.pos.x - 30;
  const expected = (20 ** 2 * Math.sin((2 * 40 * Math.PI) / 180)) / BALL.gravity; // ≈ 40.2 m
  assert.ok(Math.abs(range - expected) < 3, `first-bounce range ${range.toFixed(1)}m ≈ ${expected.toFixed(1)}m`);
});

test('bounces decay by restitution and hand over to rolling', () => {
  const ball = mkBall();
  kickBall(ball, { x: 80, y: 34 }, 18, 35, 'tester', 0);
  const peaks: number[] = [];
  let lastZ = 0;
  let rising = false;
  for (let i = 0; i < 900 && !(ball.phase === 'rolling'); i++) {
    stepBall(ball);
    if (ball.vz > 0 && !rising) rising = true;
    if (rising && ball.vz <= 0 && ball.z > 0.05) {
      peaks.push(ball.z);
      rising = false;
    }
    lastZ = ball.z;
  }
  assert.equal(ball.phase, 'rolling', 'flight ends in a roll');
  assert.equal(lastZ === 0 || ball.z === 0, true);
  assert.ok(peaks.length >= 2, `saw ${peaks.length} bounce peaks`);
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] < peaks[i - 1] * 0.6, `bounce peaks decay (${peaks[i - 1].toFixed(2)} → ${peaks[i].toFixed(2)})`);
  }
});

// ── coupling, through the scenario runner ────────────────────────────────────

const gapSeries = (frames: Frame[], carrierId: string): number[] =>
  frames
    .filter((f) => f.ball.carrierId === carrierId)
    .map((f) => {
      const c = f.bodies.find((b) => b.id === carrierId)!;
      return Math.hypot(f.ball.x - c.x, f.ball.y - c.y);
    });

test('touch length scales with speed and inversely with close control', () => {
  const maxGap = (name: string): number => {
    const frames = runScenario(scenarioByName(name), 'assert');
    // measure once the carry is underway (skip launch), while still carried
    return Math.max(...gapSeries(frames.slice(30, 200), 'carrier'));
  };
  const closeJog = maxGap('dribble-close-jog');
  const closeSprint = maxGap('dribble-close-sprint');
  const heavyJog = maxGap('dribble-heavy-jog');
  const heavySprint = maxGap('dribble-heavy-sprint');
  assert.ok(closeJog < 1.6, `close control at a jog is glued (max gap ${closeJog.toFixed(2)}m)`);
  assert.ok(closeSprint > closeJog + 0.4, `sprinting lengthens touches (${closeSprint.toFixed(2)} vs ${closeJog.toFixed(2)})`);
  assert.ok(heavyJog > closeJog + 0.2, `heavy feet lengthen touches at the same speed (${heavyJog.toFixed(2)} vs ${closeJog.toFixed(2)})`);
  assert.ok(heavySprint > closeSprint + 0.3, `heavy sprint is the loosest (${heavySprint.toFixed(2)})`);
  assert.ok(heavySprint < BALL.maxDribbleGapM, 'but still a carry, not a giveaway, on an open run');
});

test('every dribble drill retains possession over the route (the coupling holds)', () => {
  for (const name of ['dribble-close-jog', 'dribble-close-sprint', 'dribble-heavy-jog', 'dribble-heavy-sprint']) {
    const frames = runScenario(scenarioByName(name), 'assert');
    const last = frames[frames.length - 1];
    assert.equal(last.ball.carrierId, 'carrier', `${name}: still his ball at the end`);
    const carrier = last.bodies.find((b) => b.id === 'carrier')!;
    assert.ok(Math.hypot(carrier.x - 80, carrier.y - 34) < 3, `${name}: route completed WITH the ball`);
  }
});

test('kicking releases possession; the ball leaves the boot at kick speed', () => {
  const frames = runScenario(scenarioByName('struck-ball'), 'assert');
  const before = frames[14];
  const after = frames[16];
  assert.equal(before.ball.carrierId, 'striker');
  assert.equal(after.ball.carrierId, null);
  const v = Math.hypot(frames[16].ball.x - frames[15].ball.x, frames[16].ball.y - frames[15].ball.y) / 0.1;
  assert.ok(v > 12 && v <= 14.5, `ground drive moves off at ~14 m/s (measured ${v.toFixed(1)})`);
});

test('loose-ball races resolve by physics: near-slow takes the short ball, far-fast takes the long one', () => {
  const frames = runScenario(scenarioByName('loose-ball-race'), 'assert');
  // race 1: first claim after the tick-10 feed
  const claim1 = frames.find((f) => f.tick > 12 && f.ball.carrierId !== null && f.ball.carrierId !== 'feeder');
  assert.ok(claim1, 'race 1 resolves');
  assert.equal(claim1.ball.carrierId, 'near-slow', 'the short feed goes to the nearer body');
  // race 2: first non-feeder claim after the long feed at tick 208
  const claim2 = frames.find((f) => f.tick > 215 && f.ball.carrierId !== null && f.ball.carrierId !== 'feeder');
  assert.ok(claim2, 'race 2 resolves');
  assert.equal(claim2.ball.carrierId, 'far-fast', 'the long feed rewards raw pace');
});

test('carry-turn: the cut separates man and ball, the chase re-collects, both legs complete', () => {
  const frames = runScenario(scenarioByName('carry-turn'), 'assert');
  const gaps = frames.slice(60, 140).map((f) => {
    const c = f.bodies.find((b) => b.id === 'carrier')!;
    return Math.hypot(f.ball.x - c.x, f.ball.y - c.y);
  });
  assert.ok(Math.max(...gaps) > 1.2, `the cut opens a real gap (${Math.max(...gaps).toFixed(2)}m)`);
  // the chase collects: possession returns to the carrier before the handoff kick
  const recollected = frames.some((f) => f.tick > 62 && f.tick < 195 && f.ball.carrierId === 'carrier');
  assert.ok(recollected, 'the carrier chases his own touch down and re-collects');
  // leg 2: the heavy runner ends up carrying after the handoff
  const heavyCarries = frames.some((f) => f.tick > 210 && f.ball.carrierId === 'heavy');
  assert.ok(heavyCarries, 'the handoff reaches the heavy-feet runner');
});
