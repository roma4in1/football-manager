/**
 * selfplay.ts — the MEMORY SPACE, tier 1: batch match runner + decision
 * ledger. Runs N matches of m11-match, captures every pass decision's
 * PRICED completion and its REALIZED outcome (+ match stat lines) to a
 * JSONL ledger under learning/. The calibration report (calibrate.ts)
 * reads the ledger and flags the models that lie.
 *
 *   node --experimental-strip-types selfplay.ts <matches> [ticksPerMatch]
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';

const nMatches = Number(process.argv[2] ?? 10);
const ticks = Number(process.argv[3] ?? 9000);
mkdirSync('learning', { recursive: true });
const runId = `run-${process.pid}-${nMatches}x${ticks}`;
const ledger = `learning/${runId}.jsonl`;

for (let m = 0; m < nMatches; m++) {
  const sim = new Sim(scenarioByName('m11-match'), `sp-${m}`);
  const events: string[] = [];
  sim.telemetry = (ev) => events.push(JSON.stringify({ m, ...ev }));
  let passes = 0;
  let deaths = 0;
  for (let t = 0; t < ticks; t++) {
    sim.step();
    if (sim.ball.phase === 'dead') deaths++;
  }
  passes = events.filter((e) => e.includes('"t":"pass"')).length;
  const stat = { m, t: 'match', seed: `sp-${m}`, ticks, goalsHome: sim.goals.filter((g) => g.against === 'away').length, goalsAway: sim.goals.filter((g) => g.against === 'home').length, passes, deadTicks: deaths };
  appendFileSync(ledger, events.join('\n') + '\n' + JSON.stringify(stat) + '\n');
  console.log(`match ${m}: goals ${stat.goalsHome}-${stat.goalsAway} passes ${passes}`);
}
console.log(`ledger: engine2/${ledger}`);
