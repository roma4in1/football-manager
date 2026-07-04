/**
 * agent-positioning.ts — where players WANT to be.
 *
 * Target = per-phase anchor deformed by attractors/repulsors (ball, marking
 * assignment, teammate crowding), all weighted from AGENT_CAL. The
 * pitch-control field (Spearman-style arrival-time model on a coarse grid)
 * is the shared substrate the decision model reads.
 *
 * SCAFFOLD: interfaces are the contract; computations are stubs —
 * pitch control returns a neutral field, deformation applies only the
 * ball attractor. Wednesday fills in arrival times (pace/acceleration/
 * agility) and marking assignments (marking/positioning attributes).
 */

import type { Phase, Vec2 } from './engine-types.ts';
import {
  AGENT_CAL,
  clampToPitch,
  type AgentSnapshot,
  type BallState,
  type Side,
  type TeamContext,
} from './agent-model.ts';

// ── pitch control ─────────────────────────────────────────────────────────────

export interface PitchControlField {
  readonly cols: number;
  readonly rows: number;
  /** P(home controls the cell) in [0, 1] */
  controlAt(col: number, row: number): number;
  controlAtPoint(p: Vec2): number;
}

// ── positioning ───────────────────────────────────────────────────────────────

export interface PositioningContext {
  phase: Phase;
  ball: BallState;
  possession: Side | 'contested';
  team: TeamContext;
  teammates: AgentSnapshot[];
  opponents: AgentSnapshot[];
  /** GLOBAL-frame per-phase anchors, keyed by player id */
  anchors: ReadonlyMap<string, Record<Phase, Vec2>>;
}

export interface PositioningModel {
  /** The substrate both teams' decisions read — computed once per tick. */
  computePitchControl(home: AgentSnapshot[], away: AgentSnapshot[], ball: BallState): PitchControlField;
  /** Target position per player id for this tick. */
  targetsFor(ctx: PositioningContext): Map<string, Vec2>;
}

// ── stub implementation ───────────────────────────────────────────────────────

class UniformField implements PitchControlField {
  readonly cols = AGENT_CAL.pitchControlCols;
  readonly rows = AGENT_CAL.pitchControlRows;
  // STUB: neutral field. Real model: per-cell arrival-time race
  // (pace/acceleration/agility) squashed by AGENT_CAL.controlSteepness.
  controlAt(_col: number, _row: number): number {
    return 0.5;
  }
  controlAtPoint(_p: Vec2): number {
    return 0.5;
  }
}

export class AnchorPositioningModel implements PositioningModel {
  computePitchControl(_home: AgentSnapshot[], _away: AgentSnapshot[], _ball: BallState): PitchControlField {
    return new UniformField();
  }

  targetsFor(ctx: PositioningContext): Map<string, Vec2> {
    const targets = new Map<string, Vec2>();
    for (const p of ctx.teammates) {
      const anchor = ctx.anchors.get(p.id)?.[ctx.phase] ?? p.pos;
      // STUB deformation: anchor pull + ball attraction only.
      // Real model adds: marking attractor (assigned opponent, weighted by
      // marking/positioning), space repulsor (teammate crowding within
      // repulsionRadiusM), holdPosition stiffness, workRate leash.
      const wAnchor = AGENT_CAL.anchorPull;
      const wBall = AGENT_CAL.ballAttraction * (1 - p.instructions.holdPosition * AGENT_CAL.holdPositionScoreBias);
      const total = wAnchor + wBall;
      targets.set(
        p.id,
        clampToPitch({
          x: (anchor.x * wAnchor + ctx.ball.pos.x * wBall) / total,
          y: (anchor.y * wAnchor + ctx.ball.pos.y * wBall) / total,
        }),
      );
    }
    return targets;
  }
}
