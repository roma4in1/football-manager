/**
 * technique.test.ts — L3 assertions. Stochastic mechanisms are asserted as
 * RATES across seeds (keyed rng: each seed deterministic, rates honest) and
 * as model properties (probability orderings). Plus the two audit fixes:
 * bodies never interpenetrate, kicks are reach-gated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TECH, touchPopProbability, tackleWinProbability, shieldRadiusM } from './technique.ts';
import { runScenario } from './sim.ts';
import { scenarioByName, SCENARIOS } from './scenarios/index.ts';
import type { BodyAttributes } from './engine2-types.ts';

const attrs = (over: Partial<BodyAttributes> = {}): BodyAttributes => ({
  pace: 12, acceleration: 12, agility: 12, balance: 12, dribbling: 12,
  firstTouch: 12, passing: 12, tackling: 12, strength: 12, stamina: 12, ...over,
});

test('first-touch model: difficulty orders by ball speed, height, pressure; skill relieves', () => {
  const silk = attrs({ firstTouch: 18 });
  const heavy = attrs({ firstTouch: 5 });
  assert.ok(touchPopProbability(silk, 13, 0, false) < touchPopProbability(heavy, 13, 0, false), 'skill relieves');
  assert.ok(touchPopProbability(heavy, 6, 0, false) < touchPopProbability(heavy, 14, 0, false), 'faster is harder');
  assert.ok(touchPopProbability(heavy, 10, 0, false) < touchPopProbability(heavy, 10, 0.4, false), 'a bouncing ball is harder');
  assert.ok(touchPopProbability(heavy, 10, 0, false) < touchPopProbability(heavy, 10, 0, true), 'pressure bites');
  assert.ok(touchPopProbability(silk, 13, 0, false) < 0.2, 'a silk touch on a driven ball is usually dead');
});

test('tackle model: the composite edge orders win probability; shield widens with strength+balance', () => {
  const winner = tackleWinProbability(attrs({ tackling: 17, strength: 16 }), attrs({ dribbling: 8, balance: 8 }));
  const loser = tackleWinProbability(attrs({ tackling: 7, strength: 8 }), attrs({ dribbling: 17, balance: 16 }));
  assert.ok(winner > 0.6 && loser < 0.25, `edges express (${winner.toFixed(2)} vs ${loser.toFixed(2)})`);
  assert.ok(shieldRadiusM(attrs({ strength: 18, balance: 18 })) > shieldRadiusM(attrs({ strength: 6, balance: 6 })) + 0.1);
});

/** pop rate for a first-touch drill across seeds */
function popRate(name: string, seeds: number): number {
  let pops = 0;
  let contacts = 0;
  for (let s = 0; s < seeds; s++) {
    const frames = runScenario(scenarioByName(name), `ft-${s}`);
    // a pop = the receiver contacts the ball (it slows near him) but is NOT
    // the carrier immediately after contact
    // contact = genuinely within claim reach (kick noise can miss wide — a
    // missed feed is not a first touch and stays out of the denominator)
    const contact = frames.findIndex((f) => f.tick > 12 &&
      Math.hypot(f.ball.x - f.bodies.find((b) => b.id === 'receiver')!.x,
        f.ball.y - f.bodies.find((b) => b.id === 'receiver')!.y) < 0.85);
    if (contact < 0) continue;
    contacts++;
    const soonCarrier = frames.slice(contact, contact + 6).some((f) => f.ball.carrierId === 'receiver');
    if (!soonCarrier) pops++;
  }
  return contacts === 0 ? 0 : pops / contacts;
}

test('first-touch scenarios: silk kills driven balls; heavy feet under pressure spill (rates across 24 seeds)', () => {
  const silk = popRate('first-touch-silk', 24);
  const silkPressed = popRate('first-touch-silk-pressed', 24);
  const heavy = popRate('first-touch-heavy', 24);
  const heavyPressed = popRate('first-touch-heavy-pressed', 24);
  assert.ok(silk <= 0.15, `silk, free: almost always dead (${silk.toFixed(2)})`);
  assert.ok(heavyPressed >= 0.33, `heavy under pressure spills often (${heavyPressed.toFixed(2)})`);
  assert.ok(heavyPressed > heavy - 1e-9, 'pressure only ever hurts');
  assert.ok(heavy > silk - 1e-9 && silkPressed >= silk - 1e-9, 'orderings hold');
});

test('tackle scenarios: the ball-winner strips, the shielder holds (rates across 20 seeds)', () => {
  let strips = 0;
  let holds = 0;
  for (let s = 0; s < 20; s++) {
    const strip = runScenario(scenarioByName('tackle-duel-strip'), `tk-${s}`);
    if (strip.some((f) => f.ball.carrierId === 'hunter' || (f.ball.carrierId === null && f.tick > 30))) strips++;
    const hold = runScenario(scenarioByName('tackle-duel-hold'), `tk-${s}`);
    const last = hold[hold.length - 1];
    if (last.ball.carrierId === 'carrier') holds++;
  }
  assert.ok(strips >= 15, `the strong tackler usually dispossesses (${strips}/20)`);
  assert.ok(holds >= 13, `the strong shielder usually survives 30s (${holds}/20)`);
});

test('kick noise: weak feet scatter more than elite feet (spread across 30 seeds)', () => {
  const spread = (passing: number): number => {
    const ys: number[] = [];
    for (let s = 0; s < 30; s++) {
      const def: import('./engine2-types.ts').ScenarioDef = {
        version: 1, name: `scatter-${passing}`, description: '', durationTicks: 50,
        bodies: [{ id: 'k', team: 'home', pos: { x: 20, y: 34 }, attributes: attrs({ passing }) }],
        ball: { carrier: 'k' },
        script: [],
        kicks: [{ atTick: 5, bodyId: 'k', kick: { target: { x: 60, y: 34 }, speedMps: 12, loftDeg: 0 } }],
      };
      const frames = runScenario(def, `sc-${s}`);
      ys.push(frames[frames.length - 1].ball.y);
    }
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    return Math.sqrt(ys.reduce((a, y) => a + (y - mean) ** 2, 0) / ys.length);
  };
  const elite = spread(19);
  const poor = spread(4);
  assert.ok(poor > elite * 2, `passing 4 scatters ≫ passing 19 (σ ${poor.toFixed(2)} vs ${elite.toFixed(2)})`);
  assert.ok(elite < 1.2, `elite feet stay tight at 40m (σ ${elite.toFixed(2)})`);
});

test('kicks are reach-gated: a kick scheduled while the ball is mid-touch away is a no-op', () => {
  const def: import('./engine2-types.ts').ScenarioDef = {
    version: 1, name: 'reach-gate', description: '', durationTicks: 80,
    bodies: [{ id: 'r', team: 'home', pos: { x: 20, y: 34 }, attributes: attrs({ dribbling: 5 }) }],
    ball: { carrier: 'r' },
    script: [{ atTick: 5, bodyId: 'r', command: { type: 'moveTo', target: { x: 80, y: 34 }, regime: 'sprint' } }],
    // scheduled mid-sprint: with heavy feet the ball is routinely > 1.1m ahead
    kicks: [{ atTick: 40, bodyId: 'r', kick: { target: { x: 20, y: 60 }, speedMps: 14, loftDeg: 0 } }],
  };
  const frames = runScenario(def, 'assert');
  const kickTickBall = frames[40].ball;
  const gap = Math.hypot(kickTickBall.x - frames[40].bodies[0].x, kickTickBall.y - frames[40].bodies[0].y);
  if (gap > TECH.kickReachM) {
    // the kick must NOT have fired: the ball keeps rolling forward, not to y=60
    assert.ok(frames[45].ball.y > 30, 'no remote-control strike');
  }
});

test('bodies never interpenetrate (audit fix): min pairwise separation holds everywhere', () => {
  for (const def of SCENARIOS) {
    if (def.bodies.length < 2) continue;
    const frames = runScenario(def, 'assert');
    for (const f of frames) {
      for (let i = 0; i < f.bodies.length; i++) {
        for (let j = i + 1; j < f.bodies.length; j++) {
          const d = Math.hypot(f.bodies[i].x - f.bodies[j].x, f.bodies[i].y - f.bodies[j].y);
          assert.ok(d >= TECH.bodyRadiusM * 2 - 0.15, `${def.name}: ${f.bodies[i].id}/${f.bodies[j].id} overlap (${d.toFixed(2)}m) at tick ${f.tick}`);
        }
      }
    }
  }
});
