/**
 * keeper.test.ts — L7 sub-phase 1: angle-play positioning + shot-stopping on
 * the xyz footing (a dive's reach, a catch vs a parry) + the goal seam.
 * Attributes map deliberately onto the outfield schema: agility ≈ the dive,
 * firstTouch ≈ handling. Claims/punches, distribution, sweeping are later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import type { ScenarioDef } from './engine2-types.ts';
import { GOAL } from './decide.ts';

test('SHOT-STOPPING: the keeper saves what he can reach; placed corners beat him; the goal seam records them', () => {
  let shots = 0;
  let saves = 0;
  let goals = 0;
  for (let s = 0; s < 12; s++) {
    const sim = new Sim(scenarioByName('shot-save'), `ss-${s}`);
    let outcome = '';
    for (let t = 0; t < 50; t++) {
      const f = sim.step();
      if (f.bodies.find((b) => b.id === 'striker' && b.action === 'shoot')) shots++;
      const k = f.bodies.find((b) => b.id === 'keeper');
      if (!outcome && (k?.action === 'save-catch' || k?.action === 'save-parry')) { outcome = 'save'; saves++; }
      if (!outcome && sim.goals.length > 0) { outcome = 'goal'; goals++; }
    }
    // every recorded goal crossed BETWEEN the posts, UNDER the bar
    for (const g of sim.goals) {
      assert.ok(Math.abs(g.y - GOAL.centerY) <= GOAL.mouthHalfWidthM, `goal inside the posts (y ${g.y.toFixed(1)})`);
      assert.ok(g.z <= GOAL.barZ, `goal under the bar (z ${g.z.toFixed(1)})`);
      assert.equal(g.against, 'away', 'the crossing is against the defending team');
    }
  }
  assert.ok(shots >= 12, `the striker shoots every seed (${shots})`);
  // the knife-edge is the point: a placed corner can beat the dive, a shot
  // nearer the keeper cannot — BOTH outcomes must exist, saves competitive
  assert.ok(saves >= 4, `the keeper saves a real share (${saves}/12)`);
  assert.ok(goals >= 2, `placed corners genuinely beat him (${goals}/12)`);
});

test('the CATCH: a soft on-target ball is held — the keeper becomes the carrier', () => {
  const outfield = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 16, passing: 17, tackling: 12, strength: 12, stamina: 12 };
  const def: ScenarioDef = {
    version: 1,
    name: 'catch-inline',
    description: 'a soft shot straight at the keeper is caught and held',
    durationTicks: 40,
    bodies: [
      { id: 'shooter', team: 'home', pos: { x: 92, y: 34 }, attributes: outfield },
      { id: 'keeper', team: 'away', pos: { x: 103, y: 34 }, attributes: { ...outfield, agility: 15, firstTouch: 14 }, keeper: true },
    ],
    ball: { carrier: 'shooter' },
    kicks: [
      // soft and central — within his handling (catch ceiling ≈ 12.9 m/s)
      { atTick: 4, bodyId: 'shooter', kick: { target: { x: 105, y: 34 }, speedMps: 11, loftDeg: 0 } },
    ],
    script: [],
  };
  let caught = 0;
  for (let s = 0; s < 8; s++) {
    const sim = new Sim(def, `ct-${s}`);
    for (let t = 0; t < 40; t++) {
      const f = sim.step();
      if (f.bodies.find((b) => b.id === 'keeper' && b.action === 'save-catch')) {
        assert.equal(sim.ball.carrierId, 'keeper', 'a caught ball is HELD');
        caught++;
        break;
      }
    }
  }
  assert.ok(caught >= 7, `the soft ball is caught and held (${caught}/8)`);
});

test('ANGLE PLAY: the keeper mirrors a carrier across the box, staying on the ball–goal line at depth', () => {
  const sim = new Sim(scenarioByName('keeper-angle'), `ka-0`);
  let worstOff = 0;
  for (let t = 0; t < 90; t++) {
    sim.step();
    const k = sim.bodies.find((b) => b.id === 'keeper')!;
    const b = sim.ball.pos;
    const g = { x: 105, y: GOAL.centerY };
    const dx = g.x - b.x, dy = g.y - b.y;
    const len2 = Math.max(dx * dx + dy * dy, 1e-9);
    const tt = Math.max(0, Math.min(1, ((k.pos.x - b.x) * dx + (k.pos.y - b.y) * dy) / len2));
    const off = Math.hypot(k.pos.x - (b.x + dx * tt), k.pos.y - (b.y + dy * tt));
    if (t > 15) worstOff = Math.max(worstOff, off); // after he settles onto the line
  }
  assert.ok(worstOff < 1.2, `he stays on the ball–goal line while it moves (worst ${worstOff.toFixed(2)} m)`);
});

test('the goal seam is honest: a ball crossing OUTSIDE the posts is no goal', () => {
  const outfield = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 16, passing: 17, tackling: 12, strength: 12, stamina: 12 };
  const def: ScenarioDef = {
    version: 1,
    name: 'wide-inline',
    description: 'a hard shot wide of the far post crosses the byline — dead ball, no goal',
    durationTicks: 30,
    bodies: [{ id: 'shooter', team: 'home', pos: { x: 92, y: 34 }, attributes: outfield }],
    ball: { carrier: 'shooter' },
    kicks: [
      { atTick: 4, bodyId: 'shooter', kick: { target: { x: 105, y: 42 }, speedMps: 22, loftDeg: 3 } },
    ],
    script: [],
  };
  const sim = new Sim(def, `wd-0`);
  for (let t = 0; t < 30; t++) sim.step();
  assert.equal(sim.goals.length, 0, 'wide of the posts is not a goal');
  assert.equal(sim.ball.phase, 'dead', 'the wide ball is dead over the byline');
});
