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

export const SCENARIOS: readonly ScenarioDef[] = [shuttleRuns, curvedRun, arrival, chase, regimes];

export const scenarioByName = (name: string): ScenarioDef => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario "${name}" — have: ${SCENARIOS.map((x) => x.name).join(', ')}`);
  return s;
};
