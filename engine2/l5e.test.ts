/**
 * l5e.test.ts — the duel machine's own pins (design: L5E-DESIGN.md). The
 * machine's defensive states are exercised by the existing duel/head-on
 * drills; here live the arbitration, and the machine-adjacent guarantees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';

test('loose-ball ARBITRATION: one of the pair claims, the twin offsets, and the RELEASED pass to the third man survives', () => {
  let pairClaims = 0;
  let flips = 0;
  let passReachesMid = 0;
  let bracketed = 0;
  let looksLikeAPass = 0;
  // the WORKBENCH seeds lead: the builder watches wb-N, so wb-N is what the
  // pin must certify — a spread of test-only seeds proved nothing he saw
  const seeds = ['wb-0', 'wb-1', 'wb-2', 'arb-0', 'arb-1', 'arb-2', 'arb-3', 'arb-4'];
  for (const seed of seeds) {
    const sim = new Sim(scenarioByName('l5e-loose-arbitration'), seed);
    let first: string | null = null;
    let prev: string | null = null;
    let passed = false;
    let sepAtClaim = 0;
    for (let t = 0; t < 120; t++) {
      const f = sim.step();
      const c = sim.ball.carrierId;
      if (c && !first) {
        first = c;
        if (c === 't1' || c === 't2') pairClaims++;
        const t1 = sim.bodies.find((b) => b.id === 't1')!;
        const t2 = sim.bodies.find((b) => b.id === 't2')!;
        sepAtClaim = Math.hypot(t1.pos.x - t2.pos.x, t1.pos.y - t2.pos.y);
      }
      // the collector must actually PASS (mid collecting it himself proved
      // nothing — the judged hole in the first version of this pin), and it
      // must LOOK like a pass: a struck ball, not a dribble mid walks onto
      if (!passed && f.bodies.find((b) => (b.id === 't1' || b.id === 't2') && b.action?.startsWith('pass→mid'))) {
        passed = true;
        if (Math.hypot(sim.ball.vel.x, sim.ball.vel.y) >= 5) looksLikeAPass++;
      }
      // the ping-pong: the collectors trading the ball between themselves
      if (c && prev && c !== prev && (prev === 't1' || prev === 't2') && (c === 't1' || c === 't2')) flips++;
      if (passed && c === 'mid') { passReachesMid++; break; }
      if (c) prev = c;
    }
    // NOT twin runs (judged): by the claim the two have split, bracketing
    if (sepAtClaim > 1.3) bracketed++;
  }
  assert.ok(pairClaims >= 7, `the racing pair claims the loose ball, not the far man (${pairClaims}/8)`);
  assert.ok(looksLikeAPass >= 7, `the release is a STRUCK ball (>=5 m/s), visibly a pass (${looksLikeAPass}/8)`);
  assert.equal(flips, 0, `the collectors never trade the ball between themselves (${flips} flips)`);
  assert.ok(passReachesMid >= 7, `the collector RELEASES and the third man receives — the twin no longer eats it (${passReachesMid}/8)`);
  assert.ok(bracketed >= 7, `the supporters take DISTINCT spots, no twin runs (${bracketed}/8 bracketed)`);
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
