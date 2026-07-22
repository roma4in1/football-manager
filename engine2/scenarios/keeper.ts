/**
 * keeper-* — L7 sub-phase 1: angle-play positioning + shot-stopping. The
 * keeper self-positions on the ball–goal line (depth, clamped to the frame)
 * and stops shots on the xyz footing the block established: a dive's reach
 * (agility), a CATCH when the ball is holdable (firstTouch as handling), a
 * PARRY wide when it is not. Claims/punches on crosses, distribution and
 * sweeping are later sub-phases; the goal seam makes saved-vs-beaten honest.
 */
import type { ScenarioDef } from '../engine2-types.ts';
import { solveLoftSpeed } from '../ball.ts';

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
    // a recovering defender goal-side (off the shot lanes) — this is a
    // SHOT-STOPPING scenario, not a clean breakaway; without him the keeper
    // correctly reads a 1v1 and rushes instead of setting for the shot
    { id: 'cb', team: 'away', pos: { x: 93, y: 40 }, attributes: outfield },
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
    // a goal-side defender keeps this BASE angle play (a lone crossing carrier
    // is a 1v1 and the keeper rushes — from 12 m out the swinging line outruns
    // his lateral sprint, which is honest but a different scenario)
    { id: 'cb', team: 'away', pos: { x: 96, y: 34 }, attributes: outfield },
    { id: 'keeper', team: 'away', pos: { x: 102, y: 34 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'carrier' },
  script: [
    // carry across the top of the box, one side to the other
    { atTick: 4, bodyId: 'carrier', command: { type: 'moveTo', target: { x: 86, y: 52 }, regime: 'run' } },
  ],
};

/** the ANGLED shot: a striker in the channel, the keeper shading his near
 * post. The striker finishes ACROSS goal (the far corner — the longer dive,
 * the open side); the near post is the keeper's and rarely concedes. */
export const shotAngle: ScenarioDef = {
  version: 1,
  name: 'shot-angle',
  description: 'A striker shoots from the left channel; the keeper covers his near post, so the striker goes across goal to the far corner. Judge near-post cover and the across-goal finish.',
  durationTicks: 50,
  bodies: [
    { id: 'striker', team: 'home', pos: { x: 88, y: 24 }, attributes: { ...outfield, passing: 16 }, brain: 'onBall', instructions: { risk: 0.6 } },
    // a recovering defender goal-side, away from both shot lanes — keeps this
    // a shot-stopping scenario (a lone striker is a 1v1 and the keeper rushes)
    { id: 'cb', team: 'away', pos: { x: 93, y: 43 }, attributes: outfield },
    { id: 'keeper', team: 'away', pos: { x: 103.5, y: 33 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'striker' },
  script: [],
};

/** the 1v1 RUSH: a striker clean through with nobody back — the keeper does
 * not wait on his line; he comes out to penalty-spot / edge-of-box range to
 * smother the chance while it is still forming. The duel at his arrival (the
 * pinch, the save at the feet) is the smother. */
export const keeper1v1: ScenarioDef = {
  version: 1,
  name: 'keeper-1v1',
  description: 'A striker is clean through with nobody back. The keeper rushes out toward the edge of his box to smother the 1v1 rather than waiting on his line. Judge how far he comes and the duel at his arrival.',
  durationTicks: 70,
  bodies: [
    { id: 'striker', team: 'home', pos: { x: 74, y: 34 }, attributes: { ...outfield, pace: 15 }, brain: 'onBall', instructions: { risk: 0.6 } },
    { id: 'keeper', team: 'away', pos: { x: 103.5, y: 34 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'striker' },
  script: [],
};

/** the SWEEPER: play is far upfield, so the keeper holds a HIGH line well off
 * his goal — and when a long ball is played in behind his defence for a
 * runner, he is already positioned to sweep it up before the chance exists. */
export const keeperSweeper: ScenarioDef = {
  version: 1,
  name: 'keeper-sweeper',
  description: 'With play far upfield the keeper pushes to a high line; a long ball is played in behind for a runner and the keeper sweeps it up before the chance forms. Judge the high line and the sweep.',
  durationTicks: 90,
  bodies: [
    { id: 'playmaker', team: 'home', pos: { x: 30, y: 34 }, attributes: { ...outfield, passing: 18 } },
    // the runner who attacks the space in behind
    { id: 'runner', team: 'home', pos: { x: 55, y: 40 }, attributes: { ...outfield, pace: 15 }, brain: 'onBall' },
    // the away line is HIGH (squeezed up) — the space behind is the keeper's
    { id: 'cb', team: 'away', pos: { x: 57, y: 31 }, attributes: outfield },
    { id: 'keeper', team: 'away', pos: { x: 103.5, y: 34 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'playmaker' },
  kicks: [
    // the long ball in behind the high line, dropping ~x85 for the runner —
    // powered by the solver so it genuinely lands in the space (an underhit
    // ball died at x85 after bouncing and made the race a fiction)
    { atTick: 20, bodyId: 'playmaker', kick: { target: { x: 85, y: 36 }, speedMps: solveLoftSpeed(55, 21), loftDeg: 21 } },
  ],
  script: [
    { atTick: 21, bodyId: 'runner', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

/** the CORNER — claims & punches: a hanging corner drops into the goal-area
 * crowd. The keeper attacks it through his own defenders ("keeper's!") —
 * CLAIMING it clean when he can hold it, PUNCHING it clear when it is too hot
 * or contested in the air. His hands out-reach every head (2.8 m vs the 2.5 m
 * leap), which is exactly why the box is his. */
export const cornerCross: ScenarioDef = {
  version: 1,
  name: 'corner-cross',
  description: 'A hanging corner drops into a crowded goal area; the keeper attacks it through the bodies — a clean CLAIM when he can hold it, a PUNCH clear when contested. Judge the command of his box.',
  durationTicks: 80,
  bodies: [
    { id: 'taker', team: 'home', pos: { x: 104.5, y: 1 }, attributes: { ...outfield, passing: 18 } },
    // the near-post attacker attacking the drop, his marker with him
    { id: 'att', team: 'home', pos: { x: 98.5, y: 30.5 }, attributes: { ...outfield, strength: 14 }, brain: 'onBall' },
    { id: 'marker', team: 'away', pos: { x: 97.5, y: 31.5 }, attributes: { ...outfield, strength: 14 } },
    // a second pair holding the far post area
    { id: 'att2', team: 'home', pos: { x: 95, y: 37 }, attributes: outfield, brain: 'onBall' },
    { id: 'd2', team: 'away', pos: { x: 94.5, y: 36 }, attributes: outfield },
    { id: 'keeper', team: 'away', pos: { x: 104, y: 33.5 }, attributes: gloves, keeper: true },
  ],
  ball: { carrier: 'taker' },
  kicks: [
    // a HANGING corner into the heart of the goal area (steep, solver-powered)
    { atTick: 8, bodyId: 'taker', kick: { target: { x: 100.5, y: 30 }, speedMps: solveLoftSpeed(29.3, 38), loftDeg: 38 } },
  ],
  script: [
    { atTick: 9, bodyId: 'att', command: { type: 'chaseBall', regime: 'sprint' } },
    { atTick: 9, bodyId: 'marker', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

/** DISTRIBUTION: the keeper has the ball in his hands, a striker pressing him
 * — who cannot touch a held ball. He settles a beat, then throws FLAT to the
 * open full-back, not the marked midfielder; with nobody open he punts long. */
export const keeperDistribution: ScenarioDef = {
  version: 1,
  name: 'keeper-distribution',
  description: 'The keeper holds the ball under press (untouchable in his hands), then distributes: a fast flat throw to the OPEN man, ignoring the marked one. Judge the hold, the immunity, and the choice.',
  durationTicks: 60,
  bodies: [
    { id: 'keeper', team: 'away', pos: { x: 103, y: 34 }, attributes: gloves, keeper: true },
    // an open full-back wide — the right ball
    { id: 'fb', team: 'away', pos: { x: 92, y: 52 }, attributes: outfield, brain: 'onBall' },
    // a marked midfielder — the wrong ball
    { id: 'cm', team: 'away', pos: { x: 90, y: 30 }, attributes: outfield, brain: 'onBall' },
    { id: 'marker', team: 'home', pos: { x: 89, y: 29 }, attributes: outfield },
    // a striker pressing the keeper — he can harass, he cannot touch
    { id: 'striker', team: 'home', pos: { x: 98, y: 34 }, attributes: outfield },
  ],
  ball: { carrier: 'keeper' },
  script: [
    { atTick: 2, bodyId: 'striker', command: { type: 'chaseBall', regime: 'sprint' } },
  ],
};

export const keeperScenarios: ScenarioDef[] = [shotSave, keeperAngle, shotAngle, keeper1v1, keeperSweeper, cornerCross, keeperDistribution];
