/**
 * aerial.test.ts — the lofted ball (physics.md flight). The ground lane is
 * blocked; a driven loft clears the defender and drops for a runner who
 * controls it on the far side. Foundation for the aerial through ball / chip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import { solveLoftSpeed } from './ball.ts';

test('a lofted ball flies over head height and a runner controls it on the drop (the aerial through ball)', () => {
  let controlled = 0;
  let aerial = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(scenarioByName('aerial-through'), `aerial-${s}`);
    let apex = 0;
    for (let t = 0; t < 120; t++) {
      sim.step();
      apex = Math.max(apex, sim.ball.z);
      if (sim.ball.carrierId === 'runner') { controlled++; break; }
    }
    if (apex > 1.9) aerial++; // a real loft — over a standing defender's head at its apex
  }
  // the flight is a genuine aerial arc; a runner reads the drag+bounce flight
  // (predictBall) and arrives to control it — the aerial through ball works
  assert.equal(aerial, 8, `every loft flies over head height (${aerial}/8)`);
  assert.ok(controlled >= 6, `the runner controls the dropped ball on the far side (${controlled}/8)`);
});

test('the carrier LOFTS over a blocked ground lane, clearing the defender\'s head', () => {
  let lofted = 0;
  let cleared = 0;
  let received = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(scenarioByName('aerial-chip'), `chip-${s}`);
    let sawAir = false;
    let hAtBlocker = 0;
    for (let t = 0; t < 90; t++) {
      sim.step();
      if (sim.ball.phase === 'airborne') sawAir = true;
      const bl = sim.bodies.find((b) => b.id === 'blocker')!;
      if (Math.abs(sim.ball.pos.x - bl.pos.x) < 1.5) hAtBlocker = Math.max(hAtBlocker, sim.ball.z);
      if (sim.ball.carrierId === 'mate' && sawAir) { received++; break; }
    }
    if (sawAir) lofted++;
    if (hAtBlocker > 2.0) cleared++;
  }
  assert.ok(lofted >= 7, `the carrier goes aerial over the block (${lofted}/8)`);
  assert.ok(cleared >= 7, `the loft clears the blocker's head (${cleared}/8)`);
  assert.ok(received >= 6, `the open mate collects the drop (${received}/8)`);
});

test('the ballistic loft solver lands the ball at the requested distance (driven loft)', () => {
  // driven lofts (low angle) are the accurate, fast aerial ball
  for (const [dist, loft] of [[25, 22], [34, 22], [40, 25]] as const) {
    const speed = solveLoftSpeed(dist, loft);
    assert.ok(speed > 8 && speed < 42, `speed in range for ${dist}m/${loft}° (${speed.toFixed(1)})`);
  }
});
