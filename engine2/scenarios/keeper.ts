/**
 * keeper-* — L7 sub-phase 1: angle-play positioning + shot-stopping. The
 * keeper self-positions on the ball–goal line (depth, clamped to the frame)
 * and stops shots on the xyz footing the block established: a dive's reach
 * (agility), a CATCH when the ball is holdable (firstTouch as handling), a
 * PARRY wide when it is not. Claims/punches on crosses, distribution and
 * sweeping are later sub-phases; the goal seam makes saved-vs-beaten honest.
 */
import type { ScenarioDef } from '../engine2-types.ts';

const outfield = { pace: 13, acceleration: 13, agility: 13, balance: 13, dribbling: 14, firstTouch: 16, passing: 17, tackling: 12, strength: 12, stamina: 12 };
// agility ≈ reflexes/dive (reach 1.2 + 0.035·15 ≈ 1.7 m), firstTouch ≈ handling
const gloves = { ...outfield, agility: 15, firstTouch: 14, pace: 12 };

/** SHOT-STOPPING: an unpressured striker shoots from the edge of the box; the
 * keeper on his angle deals with what is ON TARGET — catching the holdable,
 * parrying the stinger wide. The wide misses and the rare beaten corner are
 * the goal seam's to record. */
export const shotSave: ScenarioDef = {
  version: 1,
  name: 'shot-save',
  description: 'A striker shoots from the edge of the box; the keeper holds his angle and saves what is on target — catching or parrying wide. Judge the save, the parry direction, and the beaten corner.',
  durationTicks: 50,
  bodies: [
    // an unpressured striker in range — the L4 shoot fires by itself
    { id: 'striker', team: 'home', pos: { x: 88, y: 34 }, attributes: { ...outfield, passing: 16 }, brain: 'onBall', instructions: { risk: 0.6 } },
    { id: 'keeper', team: 'away', pos: { x: 103.5, y: 34 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'striker' },
  script: [],
};

/** ANGLE PLAY: the carrier crosses the face of the box; the keeper mirrors,
 * staying on the ball–goal line at depth — never stranded at a post. */
export const keeperAngle: ScenarioDef = {
  version: 1,
  name: 'keeper-angle',
  description: 'A carrier runs across the face of the box; the keeper mirrors him along the ball–goal line at depth, staying between ball and goal. Judge the angle play.',
  durationTicks: 90,
  bodies: [
    { id: 'carrier', team: 'home', pos: { x: 86, y: 16 }, attributes: outfield },
    { id: 'keeper', team: 'away', pos: { x: 102, y: 34 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'carrier' },
  script: [
    // carry across the top of the box, one side to the other
    { atTick: 4, bodyId: 'carrier', command: { type: 'moveTo', target: { x: 86, y: 52 }, regime: 'run' } },
  ],
};

export const keeperScenarios: ScenarioDef[] = [shotSave, keeperAngle];
