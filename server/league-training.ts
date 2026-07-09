/**
 * league-training.ts — DB orchestration for training + season-end growth.
 *
 * All the MATH lives in @fm/engine/growth (league-growth.ts) — the same pure
 * functions the multi-season growth harness reports on, so what the harness
 * says about compounding is what a real save does. This module only moves
 * rows: the weekly accrual runs inside the week-close tick transaction
 * (revealed_at is its exactly-once marker), the season-end apply runs inside
 * the final week's tick with the attribute_audit row as the per-player
 * applied-marker.
 */

import {
  accumulateProgress,
  applySeasonGrowth,
  isTrainingFocus,
  weeklyTrainingAccrual,
} from '@fm/engine/growth';
import type { Attributes } from '@fm/engine/types';
import * as store from './league-store.ts';

/**
 * One week of training for every squad player: focus/intensity/facility from
 * the club, minutes from this matchweek's final end states (a bye week has
 * none — everyone trains at the minutes floor). Accrues into the scratch
 * field; live attributes are untouched.
 */
export async function accrueWeeklyTraining(
  c: store.Queryable, seasonId: string, matchweekId: string,
): Promise<void> {
  const roster = await store.trainingRoster(c, seasonId);
  const minutes = await store.weekPlayerMinutes(c, matchweekId);
  for (const row of roster) {
    const week = weeklyTrainingAccrual({
      focus: isTrainingFocus(row.focus) ? row.focus : 'balanced',
      intensity: row.intensity,
      trainingLevel: row.trainingLevel,
      age: row.age,
      position: row.position,
      weekMinutes: minutes.get(row.playerId) ?? 0,
    });
    const next = accumulateProgress(row.progress, week);
    await store.setTrainingProgress(c, seasonId, row.playerId, next);
  }
}

/**
 * Season end: accumulated training + age curve → new live attributes, for
 * CONTRACTED players only (frozen-pool players never age or grow). Each
 * change writes attribute_audit BEFORE the attribute update — the audit PK
 * (player, season, reason) makes a retried pass skip already-grown players.
 */
export async function applySeasonEndGrowth(c: store.Queryable, seasonId: string): Promise<number> {
  const roster = await store.growthRoster(c, seasonId);
  let applied = 0;
  for (const row of roster) {
    const { after, changed } = applySeasonGrowth(row.attributes as unknown as Attributes, row.progress, row.age);
    if (!changed) continue;
    if (!(await store.insertGrowthAudit(c, row.playerId, seasonId, row.attributes, after))) continue;
    await store.updatePlayerAttributes(c, row.playerId, after);
    applied += 1;
  }
  return applied;
}
