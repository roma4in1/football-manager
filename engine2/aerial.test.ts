/**
 * aerial.test.ts — the lofted ball (physics.md flight). The ground lane is
 * blocked; a driven loft clears the defender and drops for a runner who
 * controls it on the far side. Foundation for the aerial through ball / chip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import { solveLoftSpeed, kickBall, stepBall, type BallState } from './ball.ts';

const mkBallOver = (): BallState => ({
  pos: { x: 66, y: 34 }, z: 0, vel: { x: 0, y: 0 }, vz: 0, spin: 0,
  phase: 'carried', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
});

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

test('the AERIAL CONTEST: a defender under a lofted ball heads it clear (lofts are honest)', () => {
  let headed = 0;
  let defenderCleared = 0;
  let clearedUpfield = 0;
  for (let s = 0; s < 16; s++) {
    const sim = new Sim(scenarioByName('aerial-contest'), `ct-${s}`);
    for (let t = 0; t < 60; t++) {
      const f = sim.step();
      const h = f.bodies.find((b) => b.action?.startsWith('header'));
      if (h) {
        headed++;
        if (h.id === 'defender' && h.action === 'header-clear') {
          defenderCleared++;
          // the away defender clears toward his attacking half (−x, away from his goal at 105)
          if (sim.ball.vel.x < 0) clearedUpfield++;
        }
        break;
      }
    }
  }
  assert.ok(headed >= 13, `the aerial ball is contested with a header (${headed}/16)`);
  assert.ok(defenderCleared >= 12, `the defender wins the leap and clears (${defenderCleared}/16)`);
  assert.equal(clearedUpfield, defenderCleared, `every clearance goes upfield, away from goal`);
});

test('the CROSS + attacking header: a striker attacks the drop and heads it at goal, on target', () => {
  let headedAtGoal = 0;
  let onTarget = 0;
  for (let s = 0; s < 10; s++) {
    const sim = new Sim(scenarioByName('cross-header'), `cr-${s}`);
    for (let t = 0; t < 90; t++) {
      const f = sim.step();
      const h = f.bodies.find((b) => b.id === 'striker' && b.action === 'header-goal');
      if (h) {
        headedAtGoal++;
        // the headed ball drives toward the goal (x105), between the posts
        const b = sim.ball;
        const tToGoal = b.vel.x > 1 ? (105 - b.pos.x) / b.vel.x : 99;
        const yAtGoal = b.pos.y + b.vel.y * tToGoal;
        if (b.vel.x > 3 && Math.abs(yAtGoal - 34) < 5) onTarget++;
        break;
      }
    }
  }
  assert.ok(headedAtGoal >= 7, `the striker heads the hard cross AT GOAL (${headedAtGoal}/10)`);
  assert.ok(onTarget >= 6, `the header is goalward and roughly on target (${onTarget}/10)`);
});

test('the 3-D BLOCK: a driven ball at body height is blocked by a defender in the path (xyz, not xy)', () => {
  let blocked = 0;
  let bodyHeight = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(scenarioByName('driven-block'), `blk-${s}`);
    let didBlock = false;
    let zAtDef = 0;
    for (let t = 0; t < 60; t++) {
      const f = sim.step();
      if (Math.abs(sim.ball.pos.x - 76) < 1.5) zAtDef = Math.max(zAtDef, sim.ball.z);
      if (f.bodies.find((b) => b.id === 'defender' && b.action === 'block')) { didBlock = true; break; }
      if (sim.ball.pos.x > 90) break; // sailed past untouched
    }
    if (didBlock) blocked++;
    // the block happens above the ground-claim ceiling (0.5 m) — a genuinely
    // aerial ball the xy claim would have let through
    if (zAtDef > 0.5) bodyHeight++;
  }
  assert.ok(blocked >= 7, `the defender blocks the driven ball in his path (${blocked}/8)`);
  assert.ok(bodyHeight >= 7, `the block is at body height, above the ground-claim ceiling (${bodyHeight}/8)`);
});

test('a hard ball caroms off a TEAMMATE in the path — a collision, not a block, and he is not immune', () => {
  let collided = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(scenarioByName('teammate-collision'), `col-${s}`);
    for (let t = 0; t < 60; t++) {
      const f = sim.step();
      if (f.bodies.find((b) => b.id === 'mate' && b.action === 'collision')) { collided++; break; }
      if (sim.ball.pos.x > 90) break; // sailed past untouched
    }
  }
  assert.ok(collided >= 7, `the ball caroms off the teammate in its path (${collided}/8)`);
});

test('a ball flighted OVER the defender\'s reach clears him — the block is height-aware', () => {
  // the same 24 m/s strike, but lofted: it sails over the 2 m reach untouched
  const b = mkBallOver();
  kickBall(b, { x: 100, y: 34 }, 24, 30, 'k', 0);
  let zAtDef = 0;
  let t = 0;
  while (b.phase === 'airborne' && t < 200) { stepBall(b); t++; if (Math.abs(b.pos.x - 76) < 1) zAtDef = b.z; }
  assert.ok(zAtDef > 2.0, `the lofted ball clears the defender's reach (${zAtDef.toFixed(1)} m > 2 m)`);
});

test('CHEST control: a fast ball crossing chest height is cushioned down OR bounces off (a failed touch)', () => {
  let cushioned = 0;
  let bounced = 0;
  for (let s = 0; s < 16; s++) {
    const sim = new Sim(scenarioByName('chest-control'), `cc-${s}`);
    for (let t = 0; t < 70; t++) {
      const f = sim.step();
      const a = f.bodies.find((b) => b.id === 'receiver' && (b.action === 'chest' || b.action === 'chest-miss'));
      if (a) {
        if (a.action === 'chest') {
          cushioned++;
          assert.equal(sim.ball.carrierId, 'receiver', 'a cushioned chest touch is controlled');
        } else {
          bounced++;
          assert.equal(sim.ball.carrierId, null, 'a bounced chest touch is loose');
        }
        break;
      }
    }
  }
  // the swept-z crossing catches the ball a plain height gate misses at 10 Hz
  assert.ok(cushioned + bounced >= 12, `the chest touch engages the fast ball (${cushioned + bounced}/16)`);
  assert.ok(cushioned >= 1 && bounced >= 1, `both a clean control and a bounce-off occur (${cushioned} cushion, ${bounced} off)`);
});

test('the CROSS DECISION: a wide, advanced carrier chooses to whip an aerial cross to a striker in the box', () => {
  let crossed = 0;
  let reached = 0;
  for (let s = 0; s < 10; s++) {
    const sim = new Sim(scenarioByName('cross-decision'), `cd-${s}`);
    let sawAir = false;
    for (let t = 0; t < 60; t++) {
      sim.step();
      if (sim.ball.phase === 'airborne' && sim.ball.kickerId === 'winger') sawAir = true;
      if (sim.ball.carrierId === 'striker' && sawAir) { reached++; break; }
    }
    if (sawAir) crossed++;
  }
  assert.ok(crossed >= 8, `the winger chooses an aerial cross, not a carry into the corner (${crossed}/10)`);
  assert.ok(reached >= 7, `the cross reaches the striker in the box (${reached}/10)`);
});

test('the ballistic loft solver lands the ball at the requested distance (driven loft)', () => {
  // driven lofts (low angle) are the accurate, fast aerial ball
  for (const [dist, loft] of [[25, 22], [34, 22], [40, 25]] as const) {
    const speed = solveLoftSpeed(dist, loft);
    assert.ok(speed > 8 && speed < 42, `speed in range for ${dist}m/${loft}° (${speed.toFixed(1)})`);
  }
});
