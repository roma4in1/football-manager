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
  pos: { x: 30, y: 34 }, z: 0, vel: { x: 0, y: 0 }, vz: 0, phase: 'rolling', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
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
  // the carry speed penalty partly cancels the control gain at the same
  // regime (slower runner → slower pushes) — the margin is honest, not soft
  assert.ok(heavyJog > closeJog + 0.12, `heavy feet lengthen touches at the same speed (${heavyJog.toFixed(2)} vs ${closeJog.toFixed(2)})`);
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

test('no tunneling: a fast ball driven through a standing body is TRAPPED at the man', () => {
  // 16 m/s = 1.6 m/tick — faster than the 0.9 m control disc is wide. The
  // swept-path claim must catch it; the sampled-endpoint claim tunneled.
  const def: import('./engine2-types.ts').ScenarioDef = {
    version: 1,
    name: 'tunnel-probe',
    description: '',
    durationTicks: 60,
    bodies: [
      { id: 'kicker', team: 'home', pos: { x: 30, y: 34 }, attributes: { pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 19, tackling: 12, strength: 12, stamina: 12 } },
      { id: 'wall', team: 'away', pos: { x: 45, y: 34 }, attributes: { pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 } },
    ],
    ball: { carrier: 'kicker' },
    script: [],
    kicks: [{ atTick: 5, bodyId: 'kicker', kick: { target: { x: 90, y: 34 }, speedMps: 16, loftDeg: 0 } }],
  };
  const frames = runScenario(def, 'assert');
  // the ball must INTERACT at the man: either trapped (claim) or a first
  // touch that pops it — never an unchanged fly-through (the tunneling bug)
  const nearWall = frames.findIndex((f) => f.ball.x >= 44);
  assert.ok(nearWall > 0, 'the drive reaches the wall');
  const speedAt = (i: number): number =>
    Math.hypot(frames[i + 1].ball.x - frames[i].ball.x, frames[i + 1].ball.y - frames[i].ball.y) / 0.1;
  const before = speedAt(nearWall - 2);
  const after = speedAt(Math.min(nearWall + 3, frames.length - 2));
  const claimed = frames.some((f) => f.ball.carrierId === 'wall');
  assert.ok(claimed || after < before * 0.55, `the ball interacts at the man (${before.toFixed(1)} → ${after.toFixed(1)} m/s, claimed=${claimed})`);
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

test('carrying the ball is slower than running free (L2 judgment note)', () => {
  // same body, same route: the free chase runners in loose-ball-race sprint
  // at full cap; the dribble drills carry. Compare peak speeds directly.
  const free = runScenario(scenarioByName('chase'), 'assert');
  let freePeak = 0;
  for (const f of free) {
    const b = f.bodies.find((x) => x.id === 'long-igniter')!; // pace 12
    freePeak = Math.max(freePeak, Math.hypot(b.vx, b.vy));
  }
  const carry = runScenario(scenarioByName('dribble-close-sprint'), 'assert');
  let carryPeak = 0;
  for (const f of carry) {
    const b = f.bodies.find((x) => x.id === 'carrier')!; // pace 14 — FASTER on paper
    carryPeak = Math.max(carryPeak, Math.hypot(b.vx, b.vy));
  }
  const freeCap = 5.0 + 0.26 * 12; // long-igniter's vmax
  const carryCap = 5.0 + 0.26 * 14;
  assert.ok(freePeak > freeCap * 0.97, 'free sprint reaches its cap');
  assert.ok(carryPeak < carryCap * 0.93, `carrying stays clearly under the free cap (${carryPeak.toFixed(2)} vs ${carryCap.toFixed(2)})`);
});

test('chasers anticipate: the racer aims AHEAD of a rolling ball, not at its tail', () => {
  const frames = runScenario(scenarioByName('loose-ball-race'), 'assert');
  // during the long feed, far-fast's movement target must lead the ball
  let sawLead = false;
  for (const f of frames) {
    if (f.tick < 212 || f.tick > 240) continue;
    const d = f.bodies.find((b) => b.id === 'far-fast')!;
    if (d.tx !== undefined && d.tx > f.ball.x + 2) sawLead = true;
  }
  assert.ok(sawLead, 'the intercept point leads the rolling ball by meters');
});

test('dribble-weave: the slalom is run WITH the ball through every gate', () => {
  const frames = runScenario(scenarioByName('dribble-weave'), 'assert');
  const last = frames[frames.length - 1];
  assert.equal(last.ball.carrierId, 'carrier', 'still carrying at the end');
  const c = last.bodies.find((b) => b.id === 'carrier')!;
  assert.ok(Math.hypot(c.x - 80, c.y - 34) < 3, 'slalom completed');
  // the ball genuinely visits both sides of the corridor (the weave is real)
  const ys = frames.filter((f) => f.tick > 20).map((f) => f.ball.y);
  assert.ok(Math.min(...ys) < 31 && Math.max(...ys) > 37, `ball weaves ${Math.min(...ys).toFixed(1)}–${Math.max(...ys).toFixed(1)}`);
  // and never runs away mid-slalom
  for (const f of frames.slice(20)) {
    const cc = f.bodies.find((b) => b.id === 'carrier')!;
    assert.ok(Math.hypot(f.ball.x - cc.x, f.ball.y - cc.y) < 3.2, 'ball stays in the carrier\'s orbit');
  }
});

test('duel-1v1: a close-control carrier with a step on a chase-only defender KEEPS the ball', () => {
  // The L3-crisp claim (possession read as the attacker crosses the zone —
  // not while loitering at the finish being mugged). The outcome-SPLIT by
  // touch quality needs a defender who can jockey/contain — L5e's marking &
  // duels; asserting it here proved to be geometry-fitting (DECISIONS).
  let retained = 0;
  for (let s = 0; s < 12; s++) {
    const frames = runScenario(scenarioByName('duel-1v1-close'), `duel-${s}`);
    const crossIdx = frames.findIndex((f) => f.bodies.find((b) => b.id === 'attacker')!.x >= 80);
    if (crossIdx >= 0 && frames[crossIdx].ball.carrierId === 'attacker') retained++;
  }
  assert.ok(retained >= 11, `the shield + touch races protect a stepped dribbler (${retained}/12)`);
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
