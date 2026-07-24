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
