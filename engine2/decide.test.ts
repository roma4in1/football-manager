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
import { keepValue, passCompletion, posValue, xG } from './decide.ts';
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

test('risk dial: the instruction VISIBLY shifts the choice distribution (16 seeds each)', () => {
  const earlyRelease = (name: string): number => {
    let count = 0;
    for (let s = 0; s < 16; s++) {
      const def = scenarioByName(name);
      const sim = new Sim(def, `l4-${s}`);
      let prev: string | null = null;
      let released = false;
      for (let t = 0; t < 60 && !released; t++) {
        sim.step();
        const c = sim.ball.carrierId;
        if (c && prev === 'mid' && c !== 'mid' && (c === 'left' || c === 'right')) released = true;
        if (c) prev = c;
      }
      if (released) count++;
    }
    return count;
  };
  const high = earlyRelease('counter-3v2-risk-high');
  const low = earlyRelease('counter-3v2-risk-low');
  // speculative = tempo (release early); safe = keep it on the boot
  assert.ok(high >= 12, `risk-high releases the early ball (${high}/16)`);
  assert.ok(low <= 4, `risk-low keeps the carry (${low}/16)`);
  assert.ok(high - low >= 10, `the dial separates the styles (${high} vs ${low})`);
});

test('rondo-4v2: the ball CIRCULATES under the keep objective (4 seeds)', () => {
  let totalTransfers = 0;
  for (let s = 0; s < 4; s++) {
    const def = scenarioByName('rondo-4v2');
    const sim = new Sim(def, `l4-${s}`);
    let prev: string | null = null;
    let transfers = 0;
    let lost = false;
    for (let t = 0; t < def.durationTicks && !lost; t++) {
      sim.step();
      const c = sim.ball.carrierId;
      if (c?.startsWith('c')) lost = true;
      if (c && prev && c !== prev && c.startsWith('p') && prev.startsWith('p')) transfers++;
      if (c) prev = c;
    }
    totalTransfers += transfers;
  }
  assert.ok(totalTransfers >= 12, `passes before the chasers win it, 4 seeds (${totalTransfers})`);
});
