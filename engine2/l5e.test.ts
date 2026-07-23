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

test('the COVERED DUEL defends honestly: ride + goal-side cover + herd wide + the strip (both skill levels)', () => {
  // the defensive-brain acceptance (L5E-DESIGN: principles pass). Act ONE
  // only — kickoff to the first defender possession; after the strip the
  // drill's second act (counterpress, retake) is its own story. Visible
  // signatures, wb seeds leading (the pinning discipline):
  //   the defense WINS (a strip happens), danger never enters shooting
  //   range (<16 m of the mouth), the pair HERDS the carrier wide off the
  //   central axis, the presser visibly RIDES (inside 3 m), and the
  //   second man holds the carrier→goal line (II.7), not the ball side.
  const seeds = ['wb-0', 'wb-1', 'wb-2', 'cd-0', 'cd-1', 'cd-2', 'cd-3', 'cd-4'];
  for (const name of ['duel-2v1-covered-close', 'duel-2v1-covered-heavy']) {
    let honest = 0;
    for (const seed of seeds) {
      const sim = new Sim(scenarioByName(name), seed);
      let minGoal = Infinity;
      let maxWide = 0;
      let ride = 0;
      let goalSide = 0;
      let ticks = 0;
      let stripped = false;
      for (let t = 0; t < 300; t++) {
        sim.step();
        const att = sim.bodies.find((b) => b.id === 'attacker')!;
        const d1 = sim.bodies.find((b) => b.id === 'def1')!;
        const d2 = sim.bodies.find((b) => b.id === 'def2')!;
        const c = sim.ball.carrierId;
        if (c === 'def1' || c === 'def2') { stripped = true; break; }
        ticks++;
        minGoal = Math.min(minGoal, Math.hypot(att.pos.x - 105, att.pos.y - 34));
        maxWide = Math.max(maxWide, Math.abs(att.pos.y - 34));
        if (Math.hypot(att.pos.x - d1.pos.x, att.pos.y - d1.pos.y) < 3) ride++;
        if (d2.pos.x > att.pos.x) goalSide++;
        if (sim.ball.phase === 'dead') break;
      }
      if (stripped && minGoal > 16 && maxWide > 20 && ride >= 3 && goalSide / Math.max(ticks, 1) > 0.5) honest++;
    }
    assert.ok(honest >= 7, `${name}: the covered pair defends honestly (strip, no danger, herd, ride, II.7 cover) — ${honest}/8`);
  }
});

test('the MARK denies the outlet: in the 2v2 the marked mate never receives, and the mark is visible', () => {
  // the mark intent's own pin — the STABLE claim across every tuning of
  // the mark spot (goal-side, ball-shade): the outlet pass is priced out
  // or dies. Deliberately narrow: who wins the ensuing 1v1 carry is the
  // OPEN question (the concede-that-never-stops, the named next machine
  // item) and is NOT pinned here.
  const seeds = ['wb-0', 'wb-1', 'wb-2', 'mk-0', 'mk-1', 'mk-2', 'mk-3', 'mk-4'];
  for (const name of ['duel-2v2-covered-close', 'duel-2v2-covered-heavy']) {
    let denied = 0;
    let marked = 0;
    for (const seed of seeds) {
      const sim = new Sim(scenarioByName(name), seed);
      let received = false;
      let labeled = false;
      for (let t = 0; t < 300; t++) {
        const f = sim.step();
        if (f.bodies.some((b) => b.id === 'def2' && b.action === 'mark')) labeled = true;
        if (sim.ball.carrierId === 'mate') received = true;
        if (sim.ball.carrierId?.startsWith('def') || sim.ball.phase === 'dead') break;
      }
      if (!received) denied++;
      if (labeled) marked++;
    }
    assert.ok(denied >= 7, `${name}: the marked outlet never receives (${denied}/8 denied)`);
    assert.ok(marked >= 7, `${name}: the mark is VISIBLE on def2 (${marked}/8 seeds show the label)`);
  }
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
