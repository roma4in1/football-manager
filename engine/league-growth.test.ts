/**
 * league-growth.test.ts — pure growth-model units: curve shapes, the
 * intensity trade-off dials, focus groups, and season-end application.
 * The multi-season COMPOUNDING acceptance lives in growth-harness.ts.
 *
 *   node --test league-growth.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attributes } from './engine-types.ts';
import { LEAGUE_CFG } from './league-config.ts';
import {
  accumulateProgress,
  ageDecline,
  ageTrainingMul,
  applySeasonGrowth,
  declineWeight,
  focusAttributes,
  headroomMul,
  intensityAccrualMul,
  intensityRecoveryMul,
  isTrainingFocus,
  minutesMul,
  TRAINING_FOCUSES,
  weeklyTrainingAccrual,
} from './league-growth.ts';

const flat = (v: number): Attributes => {
  const keys = [
    'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
    'tackling', 'marking', 'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping',
    'agility', 'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
    'aggression', 'gkReflexes', 'gkPositioning', 'gkDistribution',
  ];
  return Object.fromEntries(keys.map((k) => [k, v])) as unknown as Attributes;
};

test('focus groups: outfielders train the preset, keepers always train their craft', () => {
  assert.ok(focusAttributes('possession', 'MF').includes('passing'));
  assert.ok(!focusAttributes('possession', 'MF').includes('tackling'));
  assert.deepEqual(focusAttributes('possession', 'GK'), ['gkReflexes', 'gkPositioning', 'gkDistribution']);
  assert.deepEqual(focusAttributes('physical', 'GK'), focusAttributes('balanced', 'GK'));
  for (const f of TRAINING_FOCUSES) assert.ok(isTrainingFocus(f));
  assert.ok(!isTrainingFocus('goalkeeping') && !isTrainingFocus(3));
});

test('intensity dials: rest = no growth + faster recovery; grinding = capped growth + slower recovery', () => {
  assert.equal(intensityAccrualMul(0), 0);
  assert.equal(intensityAccrualMul(0.5), 1);
  assert.equal(intensityAccrualMul(1), LEAGUE_CFG.trainingIntensityMaxGain);
  assert.ok(intensityAccrualMul(0.75) < 2 * 0.75, 'diminishing returns past the default');
  assert.equal(intensityRecoveryMul(0.5), 1, 'neutral at the default');
  assert.ok(intensityRecoveryMul(0) > 1 && intensityRecoveryMul(1) < 1);
});

test('minutes scaling: benchwarmers keep the floor share, 90 minutes is full rate', () => {
  assert.equal(minutesMul(0), LEAGUE_CFG.trainingMinutesFloor);
  assert.equal(minutesMul(90), 1);
  assert.equal(minutesMul(45), LEAGUE_CFG.trainingMinutesFloor + (1 - LEAGUE_CFG.trainingMinutesFloor) / 2);
});

test('age curves: young grow fastest, peak flat, veterans floor; decline starts at 30 and caps', () => {
  assert.equal(ageTrainingMul(18), LEAGUE_CFG.ageYouthMul);
  assert.equal(ageTrainingMul(25), 1);
  assert.equal(ageTrainingMul(40), LEAGUE_CFG.ageVeteranMul);
  for (let a = 17; a < 40; a++) assert.ok(ageTrainingMul(a) >= ageTrainingMul(a + 1), `non-increasing at ${a}`);
  assert.equal(ageDecline(29), 0);
  assert.equal(ageDecline(30), LEAGUE_CFG.ageDeclinePerYear);
  assert.equal(ageDecline(40), LEAGUE_CFG.ageDeclineMaxPerSeason);
  assert.ok(declineWeight('pace') > declineWeight('passing'), 'legs go first');
  assert.ok(declineWeight('passing') > declineWeight('decisions'), 'the brain stays');
});

test('headroom: elite attributes grow slower, never negative, clamped', () => {
  assert.ok(headroomMul(10) > headroomMul(14));
  assert.ok(headroomMul(14) > headroomMul(18));
  assert.equal(headroomMul(20), 0.1);
  assert.equal(headroomMul(1), 1.2);
});

test('weekly accrual splits the budget across the group and stacks the multipliers', () => {
  const week = weeklyTrainingAccrual({
    focus: 'possession', intensity: 0.5, trainingLevel: 0, age: 25, position: 'MF', weekMinutes: 90,
  });
  const group = focusAttributes('possession', 'MF');
  assert.equal(Object.keys(week).length, group.length);
  const per = LEAGUE_CFG.trainingWeeklyBudget / group.length;
  assert.ok(Math.abs(week.passing! - per) < 1e-9, 'baseline: all multipliers 1');
  const rested = weeklyTrainingAccrual({
    focus: 'possession', intensity: 0, trainingLevel: 5, age: 18, position: 'MF', weekMinutes: 90,
  });
  assert.deepEqual(rested, {}, 'full rest develops nothing');
});

test('season-end apply: gains headroom-scaled, decline weighted, clamped to [1,20], audit-friendly changed flag', () => {
  // a played 34-year-old: capped decline, physical hit hardest
  const old = applySeasonGrowth(flat(12), {}, 34);
  assert.ok(old.changed);
  assert.equal(old.after.pace, 12 - LEAGUE_CFG.ageDeclineMaxPerSeason);
  assert.equal(old.after.decisions, 12 - 0.1 * LEAGUE_CFG.ageDeclineMaxPerSeason);
  assert.ok(old.after.pace < old.after.passing && old.after.passing < old.after.decisions);

  // a 20-year-old with accrued training: grows, nothing declines
  const young = applySeasonGrowth(flat(12), { passing: 0.5 }, 20);
  assert.ok(young.after.passing > 12 && young.after.passing <= 12.5);
  assert.equal(young.after.pace, 12);

  // clamp: near-cap attribute cannot exceed 20; floor holds at 1
  const capped = applySeasonGrowth({ ...flat(19.9), pace: 1 }, { passing: 5 }, 34);
  assert.ok(capped.after.passing <= 20);
  assert.equal(capped.after.pace, 1);

  // no progress, peak age → unchanged
  const still = applySeasonGrowth(flat(12), {}, 25);
  assert.equal(still.changed, false);
});

test('accumulateProgress merges weeks without losing precision to display rounding', () => {
  let p: Partial<Record<keyof Attributes, number>> = {};
  for (let i = 0; i < 19; i++) p = accumulateProgress(p, { passing: 0.024 });
  assert.ok(Math.abs(p.passing! - 0.456) < 1e-3);
});
