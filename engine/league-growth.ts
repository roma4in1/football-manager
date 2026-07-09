/**
 * league-growth.ts — training focus + season-end growth, ONE system.
 *
 * Weekly training ACCUMULATES into a per-player scratch (squad_players
 * .training_progress); the live attribute never mutates mid-season.
 * Season end applies the accumulated training MINUS an age decline in a
 * single pass (attribute_audit reason 'season_growth'), for CONTRACTED
 * players only — frozen-pool players never age or grow (locked spec).
 *
 * This module is PURE (engine package, zero deps): the server tick and the
 * multi-season growth harness (growth-harness.ts) consume the exact same
 * math, so the compounding the harness reports is the compounding a real
 * save gets. All magnitudes live in LEAGUE_CFG and were tuned against the
 * harness's 5-season spread trajectory — growth must be small enough that
 * squad-quality gaps do not runaway-compound (DECISIONS.md).
 *
 * Shape of a week, per player:
 *   perAttr = (weeklyBudget / |group|)            — narrow focus trains faster
 *           × intensityAccrualMul(intensity)      — 0 at rest … 2 at max
 *           × trainingGrowthMul(facility level)   — the PR #14 hook, ×1…×1.75
 *           × ageTrainingMul(age)                 — young grow, veterans barely
 *           × minutesMul(week minutes)            — benchwarmers stagnate
 * Intensity is a real trade-off: the same dial scales fatigue recovery DOWN
 * (intensityRecoveryMul), neutral at the 0.5 default — resting recovers more.
 *
 * Season end, per attribute:
 *   next = clamp(1, 20, current + accrued − declineWeight(attr) · ageDecline(age))
 * Physical attributes decline fully, technical partially, mental barely, gk
 * slowest — a real footballer's arc: legs go first, the brain stays.
 */

import type { Attributes } from './engine-types.ts';
import { LEAGUE_CFG, trainingGrowthMul } from './league-config.ts';

export const TRAINING_FOCUSES = ['balanced', 'possession', 'attacking', 'defending', 'physical'] as const;
export type TrainingFocus = (typeof TRAINING_FOCUSES)[number];

const POSSESSION: Array<keyof Attributes> = ['passing', 'longPassing', 'vision', 'firstTouch', 'dribbling'];
const ATTACKING: Array<keyof Attributes> = ['finishing', 'offTheBall', 'crossing', 'setPieceDelivery', 'heading'];
const DEFENDING: Array<keyof Attributes> = ['tackling', 'marking', 'positioning', 'anticipation', 'composure'];
const PHYSICAL: Array<keyof Attributes> = ['pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility'];
const GOALKEEPING: Array<keyof Attributes> = ['gkReflexes', 'gkPositioning', 'gkDistribution'];
const BALANCED: Array<keyof Attributes> = [...POSSESSION, ...ATTACKING, ...DEFENDING, ...PHYSICAL, 'decisions', 'workRate'];

const FOCUS_GROUPS: Record<TrainingFocus, Array<keyof Attributes>> = {
  balanced: BALANCED,
  possession: POSSESSION,
  attacking: ATTACKING,
  defending: DEFENDING,
  physical: PHYSICAL,
};

/**
 * Keepers always train their craft: any club focus maps to the gk group for
 * GK-position players (no 'goalkeeping' preset — it would be dead weight for
 * ten outfielders, and a keeper on 'possession' weeks would train nothing).
 */
export function focusAttributes(focus: TrainingFocus, position: string): Array<keyof Attributes> {
  return position === 'GK' ? GOALKEEPING : FOCUS_GROUPS[focus];
}

export const isTrainingFocus = (v: unknown): v is TrainingFocus =>
  typeof v === 'string' && (TRAINING_FOCUSES as readonly string[]).includes(v);

// ── the dials ────────────────────────────────────────────────────────────────

/**
 * 0 at full rest (no development), 1 at the 0.5 default, then DIMINISHING
 * returns to 1.3 flat out — overtraining buys little while still costing
 * recovery. The cap is a compounding brake: without it, intensity × facility
 * stacked to ×3.5 and rich clubs ran away (growth-harness finding).
 */
export const intensityAccrualMul = (intensity: number): number => {
  const i = clamp01(intensity);
  return i <= 0.5 ? 2 * i : 1 + (LEAGUE_CFG.trainingIntensityMaxGain - 1) * ((i - 0.5) / 0.5);
};

/** Fatigue-recovery scaling: neutral at 0.5, resting recovers MORE. */
export const intensityRecoveryMul = (intensity: number): number =>
  1 + LEAGUE_CFG.trainingIntensityRecoveryPenalty * (0.5 - clamp01(intensity));

/** Played players develop; benchwarmers keep a floor share. */
export const minutesMul = (weekMinutes: number): number =>
  LEAGUE_CFG.trainingMinutesFloor + (1 - LEAGUE_CFG.trainingMinutesFloor) * Math.min(1, Math.max(0, weekMinutes) / 90);

/**
 * Development speed by age: ×1.6 at 17–20, sliding to ×1 by 24 (peak entry),
 * flat through 27, sliding to the veteran floor by 33.
 */
export function ageTrainingMul(age: number): number {
  const { ageYouthMul, ageVeteranMul } = LEAGUE_CFG;
  if (age <= 20) return ageYouthMul;
  if (age <= 24) return ageYouthMul + ((1 - ageYouthMul) * (age - 20)) / 4;
  if (age <= 27) return 1;
  if (age <= 33) return 1 + ((ageVeteranMul - 1) * (age - 27)) / 6;
  return ageVeteranMul;
}

/** Season decline in raw points, before the per-attribute weight. 0 until 30. */
export function ageDecline(age: number): number {
  const past = age - LEAGUE_CFG.ageDeclineStartAge;
  if (past < 0) return 0;
  return Math.min(LEAGUE_CFG.ageDeclineMaxPerSeason, LEAGUE_CFG.ageDeclinePerYear * (past + 1));
}

const MENTAL: Set<string> = new Set(['decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'vision', 'aggression']);
const PHYS: Set<string> = new Set(PHYSICAL);
const GK: Set<string> = new Set(GOALKEEPING);

/** Legs go first, the brain stays: physical 1, gk 0.3, mental 0.1, rest 0.4. */
export function declineWeight(attr: keyof Attributes): number {
  if (PHYS.has(attr)) return 1;
  if (GK.has(attr)) return 0.3;
  if (MENTAL.has(attr)) return 0.1;
  return 0.4;
}

// ── the two operations ───────────────────────────────────────────────────────

export interface WeekContext {
  focus: TrainingFocus;
  intensity: number; // 0..1, club dial
  trainingLevel: number; // facility 0..5
  age: number;
  position: string;
  weekMinutes: number;
}

/** One tick's accrual: attribute → fractional points earned this week. */
export function weeklyTrainingAccrual(ctx: WeekContext): Partial<Record<keyof Attributes, number>> {
  const group = focusAttributes(ctx.focus, ctx.position);
  const perAttr =
    (LEAGUE_CFG.trainingWeeklyBudget / group.length) *
    intensityAccrualMul(ctx.intensity) *
    trainingGrowthMul(ctx.trainingLevel) *
    ageTrainingMul(ctx.age) *
    minutesMul(ctx.weekMinutes);
  if (perAttr <= 0) return {};
  const out: Partial<Record<keyof Attributes, number>> = {};
  for (const key of group) out[key] = round4(perAttr);
  return out;
}

/** Merge a week into the running scratch (does NOT touch live attributes). */
export function accumulateProgress(
  progress: Partial<Record<keyof Attributes, number>>,
  week: Partial<Record<keyof Attributes, number>>,
): Partial<Record<keyof Attributes, number>> {
  const out = { ...progress };
  for (const [key, inc] of Object.entries(week) as Array<[keyof Attributes, number]>) {
    out[key] = round4((out[key] ?? 0) + inc);
  }
  return out;
}

/**
 * Headroom scaling on GAINS (never on decline): marginal improvement gets
 * harder near the 20 cap — a 17-rated attribute grows at ~a quarter of an
 * 11-rated one. Footballing-real (elite marginal gains) and the structural
 * brake that keeps top clubs from compounding away (growth-harness).
 */
export function headroomMul(current: number): number {
  return clamp(0.1, 1.2, Math.pow(Math.max(0, 20 - current) / 9, 1.2));
}

export interface SeasonGrowthResult {
  after: Attributes;
  changed: boolean;
}

/**
 * Season end: accumulated training (headroom-scaled) + age decline, one
 * pass, clamped to [1, 20]. Values are kept to 2 decimals — attributes are
 * fractional from here on (the engine consumes them arithmetically; 1–20
 * remains the scale).
 */
export function applySeasonGrowth(
  attributes: Attributes,
  progress: Partial<Record<keyof Attributes, number>>,
  age: number,
): SeasonGrowthResult {
  const decline = ageDecline(age);
  const after = { ...attributes };
  let changed = false;
  for (const key of Object.keys(after) as Array<keyof Attributes>) {
    const gain = (progress[key] ?? 0) * headroomMul(after[key]);
    const next = round2(clamp(1, 20, after[key] + gain - declineWeight(key) * decline));
    if (next !== after[key]) changed = true;
    after[key] = next;
  }
  return { after, changed };
}

const clamp = (lo: number, hi: number, v: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(0, 1, v);
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
