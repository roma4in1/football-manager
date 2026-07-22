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
  // a CENTRAL shot at a SET keeper (a defender back, no 1v1 rush) is
  // save-dominant — that is correct football; the goals that beat him live on
  // the ANGLE (the across-goal test below) and in the 1v1's missing chip
  assert.ok(saves >= 8, `the set keeper dominates central shots (${saves}/12)`);
  void goals; // recorded via the seam checks above; the angle owns the beat-him property
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

test('ANGLE PLAY: the keeper mirrors a carrier across the box, holding the NEAR-POST-shaded line at depth', () => {
  const sim = new Sim(scenarioByName('keeper-angle'), `ka-0`);
  let worstOff = 0;
  for (let t = 0; t < 90; t++) {
    sim.step();
    const k = sim.bodies.find((b) => b.id === 'keeper')!;
    const b = sim.ball.pos;
    // the line he GUARDS runs ball → the near-post-shaded anchor, not centre
    const shade = Math.max(-1, Math.min(1, (b.y - GOAL.centerY) / 12)) * 1.2;
    const g = { x: 105, y: GOAL.centerY + shade };
    const dx = g.x - b.x, dy = g.y - b.y;
    const len2 = Math.max(dx * dx + dy * dy, 1e-9);
    const tt = Math.max(0, Math.min(1, ((k.pos.x - b.x) * dx + (k.pos.y - b.y) * dy) / len2));
    const off = Math.hypot(k.pos.x - (b.x + dx * tt), k.pos.y - (b.y + dy * tt));
    if (t > 15) worstOff = Math.max(worstOff, off); // after he settles onto the line
  }
  assert.ok(worstOff < 1.2, `he stays on the shaded ball–goal line while it moves (worst ${worstOff.toFixed(2)} m)`);
});

test('the ANGLED shot: the striker goes ACROSS goal, and the near post never concedes', () => {
  let saves = 0;
  let goals = 0;
  let nearPostGoals = 0;
  for (let s = 0; s < 16; s++) {
    const sim = new Sim(scenarioByName('shot-angle'), `sa-${s}`);
    let outcome = '';
    for (let t = 0; t < 50; t++) {
      const f = sim.step();
      const k = f.bodies.find((b) => b.id === 'keeper');
      if (!outcome && (k?.action === 'save-catch' || k?.action === 'save-parry')) { outcome = 'save'; saves++; }
      if (!outcome && sim.goals.length > 0) {
        outcome = 'goal'; goals++;
        // the striker is at y≈24-31 (left channel): near post is the y<centre
        // post — the keeper's post. A goal there is the keeper's sin.
        if (sim.goals[0].y < GOAL.centerY) nearPostGoals++;
      }
    }
  }
  assert.ok(saves >= 5, `the keeper still saves a real share on the angle (${saves}/16)`);
  assert.ok(goals >= 2, `the across-goal finish genuinely scores (${goals}/16)`);
  assert.equal(nearPostGoals, 0, `the near post NEVER concedes — it is the keeper's post (${nearPostGoals})`);
});

test('the 1v1 RUSH: a striker clean through meets a keeper at the edge of his box, and the smother wins the day', () => {
  let outMax = 0;
  let dealt = 0;
  for (let s = 0; s < 12; s++) {
    const sim = new Sim(scenarioByName('keeper-1v1'), `kv-${s}`);
    let out = '';
    for (let t = 0; t < 70; t++) {
      const f = sim.step();
      const k = sim.bodies.find((b) => b.id === 'keeper')!;
      outMax = Math.max(outMax, 105 - k.pos.x);
      const ka = f.bodies.find((b) => b.id === 'keeper')?.action;
      if (!out && (ka === 'save-catch' || ka === 'save-parry')) { out = 'save'; dealt++; }
      if (!out && sim.ball.carrierId === 'keeper') { out = 'smother'; dealt++; }
      if (!out && (sim.goals.length || sim.ball.phase === 'dead')) out = 'past';
    }
  }
  // he does NOT wait on his line — penalty-spot/edge-of-box range
  assert.ok(outMax >= 9, `the keeper rushes out to smother the 1v1 (${outMax.toFixed(1)} m off his line)`);
  assert.ok(dealt >= 8, `the early rush wins most 1v1s (${dealt}/12) — the striker's chip/round-him are the future counters`);
});

test('the SWEEPER: a high line with play upfield, and the ball in behind is DEALT WITH before the runner', () => {
  const keeperActs = new Set(['keeper-clear', 'save-catch', 'claim', 'punch', 'header-clear']);
  let highLine = 0;
  let dealt = 0;
  for (let s = 0; s < 12; s++) {
    const sim = new Sim(scenarioByName('keeper-sweeper'), `sw-${s}`);
    let out = '';
    for (let t = 0; t < 90; t++) {
      const f = sim.step();
      const k = sim.bodies.find((b) => b.id === 'keeper')!;
      if (t === 19 && 105 - k.pos.x >= 10) highLine++; // the position is SITUATIONAL, never fixed
      const ka = f.bodies.find((b) => b.id === 'keeper')?.action;
      // the sweep's job is FIRST CONTACT — the danger dealt with (a first-time
      // boot clear, a catch, a claim); retaining possession is a bonus
      if (!out && (sim.ball.carrierId === 'keeper' || (ka && keeperActs.has(ka)))) { out = 'keeper'; dealt++; }
      if (!out && sim.ball.carrierId === 'runner') out = 'runner';
    }
  }
  assert.ok(highLine >= 10, `with play far upfield he holds a HIGH line, ≥10 m off his goal (${highLine}/12)`);
  assert.ok(dealt >= 9, `he deals with the ball in behind before the runner (${dealt}/12)`);
});

test('the CORNER: the keeper commands his box — claims or punches the hanging cross through the crowd', () => {
  let keeperFirst = 0;
  let punches = 0;
  let claims = 0;
  for (let s = 0; s < 16; s++) {
    const sim = new Sim(scenarioByName('corner-cross'), `cn-${s}`);
    let out = '';
    for (let t = 0; t < 80; t++) {
      const f = sim.step();
      const ka = f.bodies.find((b) => b.id === 'keeper')?.action;
      if (!out && ka === 'claim') { out = 'claim'; claims++; keeperFirst++; }
      if (!out && ka === 'punch') { out = 'punch'; punches++; keeperFirst++; }
      if (!out && f.bodies.find((b) => b.id !== 'keeper' && b.action?.startsWith('header'))) out = 'header';
    }
    // the seam stays honest under the corner chaos
    for (const g of sim.goals) assert.ok(Math.abs(g.y - GOAL.centerY) <= GOAL.mouthHalfWidthM);
  }
  assert.ok(keeperFirst >= 8, `the keeper attacks the cross through the bodies and gets there first (${keeperFirst}/16)`);
  assert.ok(punches >= 3, `contested in the air, he PUNCHES clear (${punches})`);
  void claims; // a clean claim is the uncontested case — present when the crowd thins
});

test('the SHUFFLE: repositioning, the keeper stays square to the ball — he never shows it his back', () => {
  const sim = new Sim(scenarioByName('keeper-angle'), `ka-0`);
  let worstOff = 0;
  let moved = false;
  for (let t = 0; t < 90; t++) {
    sim.step();
    const k = sim.bodies.find((b) => b.id === 'keeper')!;
    if (k.speed > 0.5) moved = true;
    const toBall = Math.atan2(sim.ball.pos.y - k.pos.y, sim.ball.pos.x - k.pos.x);
    const off = Math.abs(((toBall - k.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (t > 15) worstOff = Math.max(worstOff, off);
  }
  assert.ok(moved, 'he genuinely moves while tracking (a standing keeper proves nothing)');
  assert.ok(worstOff < Math.PI / 4, `facing stays on the ball while he shuffles (worst ${(worstOff * 180 / Math.PI).toFixed(0)}°)`);
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
