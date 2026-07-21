/**
 * L4 tests — on-ball decisions. Units pin the value/risk geometry; scenario
 * rates pin the spec's acceptance lines: striker-shoots-by-construction, no
 * backward pass from a clear chance, and the risk instruction visibly
 * shifting the choice distribution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';
import { keepValue, passCompletion, posValue, supportSpot, xG } from './decide.ts';
import type { BodyState, Frame } from './engine2-types.ts';

const mkBody = (id: string, team: 'home' | 'away', x: number, y: number, vx = 0, vy = 0): BodyState => ({
  id, team,
  attributes: { pace: 13, acceleration: 13, agility: 12, balance: 12, dribbling: 12, firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12 },
  pos: { x, y }, vel: { x: vx, y: vy }, speed: Math.hypot(vx, vy),
  facing: 0, regime: 'run', stance: 'moving',
  command: { type: 'hold' }, pathIndex: 0, arrived: true, arrivedAtTick: 0,
});

const runScenario = (name: string, seed: string): Frame[] => {
  const def = scenarioByName(name);
  const sim = new Sim(def, seed);
  const frames: Frame[] = [];
  for (let t = 0; t < def.durationTicks; t++) frames.push(sim.step());
  return frames;
};

test('posValue: monotone toward the attacked goal, for both teams', () => {
  assert.ok(posValue({ x: 80, y: 34 }, 'home') > posValue({ x: 40, y: 34 }, 'home'));
  assert.ok(posValue({ x: 25, y: 34 }, 'away') > posValue({ x: 65, y: 34 }, 'away'));
  // central beats wide at the same depth near goal
  assert.ok(posValue({ x: 92, y: 34 }, 'home') > posValue({ x: 92, y: 8 }, 'home'));
});

test('keepValue: space raises it, straying from the station drains it', () => {
  const opp = [mkBody('o', 'away', 50, 34)];
  assert.ok(keepValue({ x: 44, y: 34 }, opp, { x: 44, y: 34 }) > keepValue({ x: 48, y: 34 }, opp, { x: 48, y: 34 }));
  assert.ok(keepValue({ x: 40, y: 34 }, opp, { x: 40, y: 34 }) > keepValue({ x: 40, y: 34 }, opp, { x: 52, y: 34 }));
});

test('xG: real geometry — distance, angle, blockers, the point-blank boot', () => {
  const none: BodyState[] = [];
  assert.ok(xG({ x: 96, y: 34 }, 'home', none) > xG({ x: 85, y: 34 }, 'home', none), 'closer is better');
  assert.ok(xG({ x: 94, y: 34 }, 'home', none) > xG({ x: 94, y: 12 }, 'home', none), 'central beats tight angle');
  const blocked = [mkBody('b', 'away', 99, 34)];
  assert.ok(xG({ x: 94, y: 34 }, 'home', blocked) < xG({ x: 94, y: 34 }, 'home', none), 'a body on the line costs');
  const pointBlank = [mkBody('b', 'away', 95.2, 34)];
  assert.ok(xG({ x: 94, y: 34 }, 'home', pointBlank) < 0.1, 'a boot on your toes blocks the shot outright');
});

test('passCompletion: open lanes carry, occupied lanes die, motion counts', () => {
  const open = passCompletion({ x: 40, y: 34 }, { x: 54, y: 34 }, 12, [mkBody('o', 'away', 47, 44)], 14);
  const onLane = passCompletion({ x: 40, y: 34 }, { x: 54, y: 34 }, 12, [mkBody('o', 'away', 47, 34.5)], 14);
  assert.ok(open > 0.8, `open lane completes (${open.toFixed(2)})`);
  assert.ok(onLane < 0.35, `a defender standing in the lane kills it (${onLane.toFixed(2)})`);
  // a defender SPRINTING onto the lane threatens more than one leaving it
  const closing = passCompletion({ x: 40, y: 34 }, { x: 54, y: 34 }, 12, [mkBody('o', 'away', 47, 38, 0, -6)], 14);
  const leaving = passCompletion({ x: 40, y: 34 }, { x: 54, y: 34 }, 12, [mkBody('o', 'away', 47, 38, 0, 6)], 14);
  assert.ok(closing < leaving, 'lane risk reads defender motion');
});

test('striker-breakaway: through on goal he SHOOTS — construction, not role (16 seeds)', () => {
  let shots = 0;
  for (let s = 0; s < 16; s++) {
    const frames = runScenario('striker-breakaway', `l4-${s}`);
    let shot = false;
    let backwardPassInRange = false;
    for (const f of frames) {
      const st = f.bodies.find((b) => b.id === 'striker')!;
      if (st.action === 'shoot') shot = true;
      // no backward pass from a clear chance (spec acceptance): the only
      // teammate is BEHIND him — any pass intent inside range is backward
      if (st.x > 78 && st.action?.startsWith('pass')) backwardPassInRange = true;
    }
    if (shot) shots++;
    assert.equal(backwardPassInRange, false, `l4-${s}: passed backward from the chance`);
  }
  // the shortfall seeds are the chaser honestly winning the ball first
  assert.ok(shots >= 14, `the striker shoots when he has the chance (${shots}/16)`);
});

test('risk dial: the instruction picks the TARGET — safe outlet vs through ball (16 seeds each)', () => {
  const firstPassTarget = (name: string): { left: number; right: number } => {
    const out = { left: 0, right: 0 };
    for (let s = 0; s < 16; s++) {
      const def = scenarioByName(name);
      const sim = new Sim(def, `l4-${s}`);
      let first = '';
      for (let t = 0; t < 220 && !first; t++) {
        const f = sim.step();
        const m = f.bodies.find((b) => b.id === 'mid')!;
        if (m.action?.startsWith('pass→')) first = m.action.slice(5);
      }
      if (first === 'left') out.left++;
      else if (first === 'right') out.right++;
    }
    return out;
  };
  const high = firstPassTarget('counter-3v2-risk-high');
  const low = firstPassTarget('counter-3v2-risk-low');
  // the judged semantics: safe = the ball to the open man; speculative =
  // the through ball to the deep runner
  assert.ok(low.right >= 12, `risk-low plays the safe outlet (${low.right}/16 right)`);
  assert.ok(high.left >= 12, `risk-high hits the through ball (${high.left}/16 left)`);
});

test('supportSpot (L5a): moves off a blocked lane, spaces off teammates, deforms toward the ball', () => {
  const carrier = mkBody('c', 'home', 40, 34);
  const mate = mkBody('m', 'home', 54, 34);
  const blocker = mkBody('o', 'away', 47, 34.2); // parked ON the home lane
  const spot = supportSpot(mate, carrier, [carrier, mate, blocker], { x: 54, y: 34 }, 'keep');
  const laneAtHome = passCompletion(carrier.pos, { x: 54, y: 34 }, 10, [blocker], 14, mate);
  const laneAtSpot = passCompletion(carrier.pos, spot, 10, [blocker], 14, mate);
  assert.ok(laneAtSpot > laneAtHome + 0.15, `the spot opens the lane (${laneAtHome.toFixed(2)} → ${laneAtSpot.toFixed(2)})`);
  // spacing: a crowding teammate pushes the spot away
  const crowd = mkBody('m2', 'home', 54, 35);
  const spaced = supportSpot(mate, carrier, [carrier, mate, blocker, crowd], { x: 54, y: 34 }, 'keep');
  assert.ok(Math.hypot(spaced.x - crowd.pos.x, spaced.y - crowd.pos.y) > 2.5, 'spaced off the crowder');
});

test('rondo-4v2 with support (L5a): passers reposition and the ball still circulates (4 seeds)', () => {
  let moved = 0;
  let checked = 0;
  for (let s = 0; s < 4; s++) {
    const def = scenarioByName('rondo-4v2');
    const sim = new Sim(def, `l4-${s}`);
    const start = new Map(sim.bodies.map((b) => [b.id, { ...b.pos }]));
    const disp = new Map<string, number>();
    for (let t = 0; t < def.durationTicks; t++) {
      sim.step();
      for (const b of sim.bodies) {
        if (!b.id.startsWith('p')) continue;
        const s0 = start.get(b.id)!;
        disp.set(b.id, Math.max(disp.get(b.id) ?? 0, Math.hypot(b.pos.x - s0.x, b.pos.y - s0.y)));
      }
    }
    for (const [, d] of disp) { checked++; if (d > 2) moved++; }
  }
  assert.ok(moved >= checked * 0.5, `support repositions the passers (${moved}/${checked} moved >2m)`);
});

test('runs-in-behind (L5b): the whole move is emergent — trigger, seam, release, finish (16 seeds)', () => {
  let ran = 0;
  let received = 0;
  let shot = 0;
  for (let s = 0; s < 16; s++) {
    const def = scenarioByName('runs-in-behind');
    const sim = new Sim(def, `l5-${s}`);
    let sawRun = false;
    let got = false;
    let fired = false;
    for (let t = 0; t < def.durationTicks; t++) {
      const f = sim.step();
      const st = f.bodies.find((b) => b.id === 'striker')!;
      if (st.action === 'run') sawRun = true;
      if (f.ball.carrierId === 'striker') got = true;
      if (st.action === 'shoot') fired = true;
    }
    if (sawRun) ran++;
    if (got) received++;
    if (fired) shot++;
  }
  assert.ok(ran >= 15, `the run triggers from carrier context (${ran}/16)`);
  assert.ok(received >= 12, `the release finds the runner (${received}/16)`);
  assert.ok(shot >= 10, `the move finishes (${shot}/16)`);
});

test('wall-pass (L5b): the one-two rhythm — give, dart in flight, return met moving (16 seeds)', () => {
  let movingReturns = 0;
  for (let s = 0; s < 16; s++) {
    const def = scenarioByName('wall-pass');
    const sim = new Sim(def, `l5-${s}`);
    let wallHad = false;
    let done = false;
    for (let t = 0; t < def.durationTicks && !done; t++) {
      sim.step();
      const c = sim.ball.carrierId;
      if (c === 'wall') wallHad = true;
      if (wallHad && c === 'playmaker') {
        const pm = sim.bodies.find((b) => b.id === 'playmaker')!;
        if (pm.speed > 2.5 && pm.pos.x > 62) movingReturns++;
        done = true;
      }
    }
  }
  // the give-and-go: the thread meets a MOVING man BEYOND the wall (the
  // judged one-two spec: give → dart → thread at the breach)
  assert.ok(movingReturns >= 12, `threads met moving beyond the wall (${movingReturns}/16)`);
});

test('rondo-4v2: the ball CIRCULATES under the keep objective (4 seeds)', () => {
  // whole-drill circulation: a cut ball can end a seed's keep early (the
  // passers cannot press to recover — that is L4's boundary, off-ball
  // defending is L5's), so the floor is across seeds, not per seed
  let totalTransfers = 0;
  for (let s = 0; s < 4; s++) {
    const def = scenarioByName('rondo-4v2');
    const sim = new Sim(def, `l4-${s}`);
    let prev: string | null = null;
    let transfers = 0;
    for (let t = 0; t < def.durationTicks; t++) {
      sim.step();
      const c = sim.ball.carrierId;
      if (c && prev && c !== prev && c.startsWith('p') && prev.startsWith('p')) transfers++;
      if (c) prev = c;
    }
    totalTransfers += transfers;
  }
  assert.ok(totalTransfers >= 16, `passer-to-passer transfers across 4 seeds (${totalTransfers})`);
});
