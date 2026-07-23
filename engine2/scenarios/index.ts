/**
 * The scenario library (spec §6) — versioned, workbench-loadable, asserted.
 * Grows continuously; a behavior that once looked right must not silently rot.
 */
import type { ScenarioDef } from '../engine2-types.ts';
import shuttleRuns from './shuttle-runs.ts';
import curvedRun from './curved-run.ts';
import arrival from './arrival.ts';
import chase from './chase.ts';
import regimes from './regimes.ts';
import { dribbleScenarios } from './dribble.ts';
import struckBall from './struck-ball.ts';
import looseBallRace from './loose-ball-race.ts';
import carryTurn from './carry-turn.ts';
import { channelDuelScenarios, coveredDuelScenarios, fullbacksDuelScenarios, duelScenarios, looseArbitration, matchDuelScenarios, weave } from './duel-1v1.ts';
import { firstTouchScenarios } from './first-touch.ts';
import { firstTouchRunScenarios, firstTouchAngleScenarios } from './first-touch-run.ts';
import { tackleScenarios } from './tackle-duel.ts';
import knockPast from './knock-past.ts';
import { l4Scenarios } from './l4-decisions.ts';
import { aerialScenarios } from './aerial.ts';
import { curveScenarios } from './curve.ts';
import { keeperScenarios } from './keeper.ts';

export const SCENARIOS: readonly ScenarioDef[] = [
  // L1 — movement (regression set)
  shuttleRuns, curvedRun, arrival, chase, regimes,
  // L2 — ball + possession coupling
  ...dribbleScenarios, struckBall, looseBallRace, carryTurn, weave, ...duelScenarios,
  // L3 — individual technique
  ...firstTouchScenarios, ...firstTouchRunScenarios, ...firstTouchAngleScenarios, ...tackleScenarios, knockPast,
  // L4 — on-ball decisions
  ...l4Scenarios,
  // L-aerial — the lofted ball
  ...aerialScenarios,
  // L-curve — the Magnus bend
  ...curveScenarios,
  // L5E — the duel machine's own pins
  looseArbitration, ...coveredDuelScenarios, ...matchDuelScenarios, ...channelDuelScenarios, ...fullbacksDuelScenarios,
  // L7 — the goalkeeper
  ...keeperScenarios,
];

export const scenarioByName = (name: string): ScenarioDef => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario "${name}" — have: ${SCENARIOS.map((x) => x.name).join(', ')}`);
  return s;
};
