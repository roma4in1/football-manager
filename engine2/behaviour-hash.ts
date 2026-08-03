/**
 * behaviour-hash.ts — THE INERTNESS PROOF.
 *
 * A single integer over a fixed slice of simulated world-state. Two builds
 * that produce the SAME hash are byte-identical in behaviour; a build that
 * changes only reporting, labelling or instrumentation MUST leave it
 * unchanged, and that is the only cheap way to prove a "this changes nothing"
 * claim rather than assert it.
 *
 * THE DEFINITION IS THE TOOL. Changing the seeds, the scenario, the tick
 * count, the sampling stride or the rounding produces a number that is not
 * comparable with any recorded value, which destroys the whole point. If a
 * different slice is ever wanted, add a SECOND function — do not edit this one.
 *
 * This lived only in a chat log for ~40 sessions and every value below was
 * re-derived by hand. Committed so future comparisons are anchored.
 *
 *   pnpm --filter @fm/engine2 hash
 *
 * KNOWN VALUES (recovered from the session record; the older entries were
 * taken on working trees mid-session rather than at a commit, so they are
 * recorded with what is actually known and not back-fitted to a sha):
 *
 *   330891334142  goals 26   e7948e69  (the distance-scaled sigma)
 *   166718641633             working tree, goal-kick posture arc
 *   164180110242  goals 15   working tree, "iteration 3 — clamp only"
 *   885956124474             working tree, goal-kick posture arc
 *   867903672546  goals 20   working tree, proved a reporting-only change
 *                            byte-identical to main (the method's first use)
 *   736243648720             working tree, counterfactual-fork arc
 *
 * Only the first is anchored to a commit. The rest are kept because a
 * recurrence of one is still evidence, and because losing them entirely would
 * lose the arc's only inertness record.
 */
import { Sim } from './sim.ts';
import { scenarioByName } from './scenarios/index.ts';

export function behaviourHash(): { hash: number; goals: number } {
  let hash = 0;
  let goals = 0;
  for (let s = 0; s < 4; s++) {
    const sim = new Sim(scenarioByName('m11-match-full'), `id-${s}`);
    for (let t = 0; t < 9000; t++) {
      sim.step();
      // every 97th tick: a stride coprime with the tick rate, so the sample
      // does not lock onto any periodic phase of the simulation
      if (t % 97 === 0) {
        for (const b of sim.bodies) {
          hash = (hash * 31 + Math.round(b.pos.x * 100) + Math.round(b.pos.y * 100)) % 1e12;
        }
        hash = (hash * 31 + Math.round(sim.ball.pos.x * 100) + Math.round(sim.ball.pos.y * 100)) % 1e12;
      }
    }
    goals += sim.goals.length;
  }
  return { hash, goals };
}

if (import.meta.filename === process.argv[1]) {
  const { hash, goals } = behaviourHash();
  console.log(`BEHAVIOUR HASH ${hash} | goals ${goals}`);
}
