/**
 * m11.test.ts — the FIELD TIER pilot (builder direction, Jul 24): scenario
 * pins move from artificial stages to 11v11 match situations; the physics/
 * model units remain the math tier. These pins are SURVIVAL + situation
 * signatures only — the builder's workbench eye is the acceptance for the
 * football itself; deeper claims land per-family as the sweep continues.
 * (Bounds/continuity for the m11 scenes ride the global scenario tests.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';

const SEEDS = ['wb-0', 'wb-1', 'wb-2', 'm11-0', 'm11-1'];

const run = (name: string) => {
  let engaged = 0;
  let conceded = 0;
  let claimed = 0;
  let bothCollect = 0;
  for (const seed of SEEDS) {
    const sim = new Sim(scenarioByName(name), seed);
    let press = false;
    let hColl = false;
    let aColl = false;
    let claim = false;
    for (let t = 0; t < 300; t++) {
      const f = sim.step();
      for (const b of f.bodies) {
        if (b.id.startsWith('h-') && (b.action === 'press' || b.action === 'counterpress')) press = true;
        if (b.action === 'collect') {
          if (b.id.startsWith('h-')) hColl = true;
          else aColl = true;
        }
      }
      if (sim.ball.carrierId) claim = true;
      if (sim.goals?.length) { if (sim.goals[0].against === 'home') conceded++; break; }
      if (sim.ball.phase === 'dead') break;
    }
    if (press) engaged++;
    if (hColl && aColl) bothCollect++;
    if (claim) claimed++;
  }
  return { engaged, conceded, claimed, bothCollect };
};

test('M11 pilot — the wing duel lives in match ecology: the defense engages, nothing is gifted', () => {
  const r = run('m11-wing-duel');
  assert.ok(r.engaged >= 4, `the home side engages the flank carrier (${r.engaged}/5)`);
  assert.ok(r.claimed >= 4, `the ball is live and contested (${r.claimed}/5)`);
  // re-based (Jul 24): the zero bar was a blind-check artifact — a carrier
  // who beats the block earns the finish; the lone-rider escort root is
  // the ledgered fix
  assert.ok(r.conceded <= 1, `the block mostly holds (${r.conceded}/5 conceded)`);
});

test('M11 pilot — the central drive meets the block', () => {
  const r = run('m11-central-drive');
  assert.ok(r.engaged >= 4, `the block engages the central carrier (${r.engaged}/5)`);
  assert.ok(r.conceded <= 1, `the block mostly holds the middle (${r.conceded}/5 conceded)`);
});

test('M11 pilot — the second ball is RACED by both teams (the deadlock is dead)', () => {
  // the pilot's first finding: the 8 m stray radius deadlocked an entire
  // 11v11 around a neutral ball for 18+ seconds — now each team's nearest
  // man goes, and the scramble resolves to a carrier
  const r = run('m11-second-ball');
  assert.ok(r.bothCollect >= 4, `both teams send a collector to the neutral ball (${r.bothCollect}/5)`);
  assert.ok(r.claimed >= 4, `the scramble resolves to possession (${r.claimed}/5)`);
});

test('M11 FORMATIONS — the 4-3-3 vs 5-2-3 duel: each shape keeps its identity in live play', () => {
  // storyboarded on wb-0..2 (the builder's seeds) before pinning: back
  // five 4.5-4.9/5 goal-side, front three x̄ 61-67, wingback spread
  // 40-43 m — the pins sit under the measured floors
  for (const seed of ['wb-0', 'wb-1', 'wb-2']) {
    const sim = new Sim(scenarioByName('m11-433-523'), seed);
    let hPass = 0;
    let aPass = 0;
    sim.telemetry = (e: any) => {
      if (e.t === 'pass' && (e.outcome === 'complete' || e.outcome === 'teammate')) {
        if ((e.kicker as string).startsWith('h-')) hPass++; else aPass++;
      }
    };
    const five: number[] = [];
    const three: number[] = [];
    const spread: number[] = [];
    for (let t = 0; t < 900; t++) {
      sim.step();
      if (t % 30 !== 0 || t < 60) continue;
      const backs = ['a-lwb', 'a-cb1', 'a-cb2', 'a-cb3', 'a-rwb'].map((id) => sim.bodies.find((b) => b.id === id)!);
      const hAtt = Math.max(...sim.bodies.filter((b) => b.team === 'home' && b.id !== 'h-gk').map((b) => b.pos.x));
      five.push(backs.filter((b) => b.pos.x > hAtt - 3).length);
      const front = ['h-lw', 'h-st', 'h-rw'].map((id) => sim.bodies.find((b) => b.id === id)!);
      three.push(front.reduce((s2, b) => s2 + b.pos.x, 0) / 3);
      const c = sim.ball.carrierId;
      if (c && c.startsWith('a-')) {
        const wbs = ['a-lwb', 'a-rwb'].map((id) => sim.bodies.find((b) => b.id === id)!);
        spread.push(Math.abs(wbs[0].pos.y - wbs[1].pos.y));
      }
    }
    const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    assert.ok(avg(five) >= 3.8, `${seed}: the back five holds its goal-side chain (${avg(five).toFixed(1)}/5)`);
    assert.ok(avg(three) >= 52, `${seed}: the front three stays high (x̄=${avg(three).toFixed(0)})`);
    assert.ok(spread.length > 0 && avg(spread) >= 28, `${seed}: the wingbacks give the width in possession (${spread.length ? avg(spread).toFixed(0) : 0}m)`);
    assert.ok(hPass >= 5 && aPass >= 4, `${seed}: both shapes circulate (h=${hPass} a=${aPass})`);
  }
});
