/**
 * l5e.test.ts — the duel machine's own pins (design: L5E-DESIGN.md). The
 * machine's defensive states are exercised by the existing duel/head-on
 * drills; here live the arbitration, and the machine-adjacent guarantees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';

test('loose-ball ARBITRATION: one claims, the twin offsets, and the pass to the third man survives', () => {
  let flips = 0;
  let midGets = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(scenarioByName('l5e-loose-arbitration'), `arb-${s}`);
    let prev: string | null = null;
    for (let t = 0; t < 100; t++) {
      sim.step();
      const c = sim.ball.carrierId;
      // the ping-pong: the collectors trading the ball between themselves
      if (c && prev && c !== prev && (prev === 't1' || prev === 't2') && (c === 't1' || c === 't2')) flips++;
      if (c === 'mid') { midGets++; break; }
      if (c) prev = c;
    }
  }
  assert.equal(flips, 0, `the collectors never trade the ball between themselves (${flips} flips)`);
  assert.ok(midGets >= 7, `the third man receives — his lane is not eaten by the twin (${midGets}/8)`);
});

test('bounds: a CARRIED ball over the line is out, and bodies stay on the park', () => {
  const outfield = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 14, passing: 15, tackling: 12, strength: 12, stamina: 12 };
  const sim = new Sim({
    version: 1, name: 'bounds-inline', description: 'a carrier dribbles over the touchline', durationTicks: 80,
    bodies: [{ id: 'c', team: 'home', pos: { x: 30, y: 3 }, attributes: outfield }],
    ball: { carrier: 'c' },
    script: [{ atTick: 4, bodyId: 'c', command: { type: 'moveTo', target: { x: 30, y: -6 }, regime: 'run' } }],
  }, 'bd-0');
  let died = false;
  for (let t = 0; t < 80; t++) {
    sim.step();
    const c = sim.bodies.find((b) => b.id === 'c')!;
    assert.ok(c.pos.y >= 0 && c.pos.y <= 68, `the body stays on the park (y ${c.pos.y.toFixed(2)})`);
    if (sim.ball.phase === 'dead') { died = true; break; }
  }
  assert.ok(died, 'the dribbled-out ball goes dead — carrying over the line does not keep play alive');
});
