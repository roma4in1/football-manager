/**
 * curve.test.ts — the Magnus bend (physics.md sidespin). A ball struck with
 * spin curves perpendicular to its travel; a kicker bends it around a defender
 * on the direct line to a receiver a straight ball could not reach cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import { kickBall, stepBall, type BallState } from './ball.ts';

const mkBall = (): BallState => ({
  pos: { x: 10, y: 34 }, z: 0, vel: { x: 0, y: 0 }, vz: 0, spin: 0,
  phase: 'carried', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
});

const flightEnd = (spin: number): { x: number; y: number } => {
  const b = mkBall();
  kickBall(b, { x: 44, y: 34 }, 22, 12, 'k', 0, spin);
  let t = 0;
  while ((b.phase === 'airborne' || Math.hypot(b.vel.x, b.vel.y) > 0.15) && t < 400) { stepBall(b); t++; }
  return { x: b.pos.x, y: b.pos.y };
};

test('sidespin curves the ball perpendicular to travel, sign-correct, magnitude in range', () => {
  const straight = flightEnd(0);
  assert.ok(Math.abs(straight.y - 34) < 0.1, `no spin flies straight (Δy ${(straight.y - 34).toFixed(2)})`);
  const up = flightEnd(80);
  const down = flightEnd(-80);
  // +spin and −spin bend opposite ways, by a believable amount over ~34 m
  assert.ok(up.y - 34 > 1.5, `+spin curves one way (Δy ${(up.y - 34).toFixed(1)})`);
  assert.ok(34 - down.y > 1.5, `−spin curves the other (Δy ${(down.y - 34).toFixed(1)})`);
  assert.ok(Math.abs(up.y - 34) < 6, `the bend is a curve, not a hook (Δy ${(up.y - 34).toFixed(1)})`);
});

test('a curled pass bends AROUND a defender on the direct line to the receiver', () => {
  let curved = 0;
  let cleared = 0;
  let received = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(scenarioByName('curled-pass'), `cv-${s}`);
    let maxDev = 0;
    let minDefDist = 99;
    let launched = false;
    for (let t = 0; t < 90; t++) {
      sim.step();
      if (sim.ball.phase !== 'carried') launched = true;
      if (launched) {
        maxDev = Math.max(maxDev, Math.abs(sim.ball.pos.y - 34)); // deviation from the straight aim (y=34)
        const df = sim.bodies.find((b) => b.id === 'defender')!;
        minDefDist = Math.min(minDefDist, Math.hypot(sim.ball.pos.x - df.pos.x, sim.ball.pos.y - df.pos.y));
      }
      if (sim.ball.carrierId === 'receiver') { received++; break; }
    }
    if (maxDev > 2) curved++;
    if (minDefDist > 1.5) cleared++;
  }
  assert.ok(curved >= 7, `the ball visibly curls off the straight aim (${curved}/8)`);
  assert.ok(cleared >= 7, `the curl bends clear of the defender on the line (${cleared}/8)`);
  assert.ok(received >= 7, `the receiver collects the bent ball (${received}/8)`);
});
