/**
 * agent-positioning.ts — where players WANT to be.
 *
 * Target = per-phase anchor deformed by attractors/repulsors (ball, marking
 * assignment, teammate crowding), all weighted from AGENT_CAL. The
 * pitch-control field (Spearman-style arrival-time model on a coarse grid)
 * is the shared substrate the decision model reads.
 *
 * Pitch control is REAL (see DECISIONS.md stub inventory): per cell, each
 * player's arrival time = reaction window carried at current velocity, then
 * an accelerate-to-vmax run (pace/acceleration/fatigue-scaled); the home
 * control share is a logistic on the best-arrival-time differential. The
 * grid buffer is allocated once per model and REUSED — the returned field
 * aliases it and is valid until the next computePitchControl call.
 *
 * STILL STUBBED: target deformation applies only the ball attractor;
 * marking assignments and space repulsors come with the behavior session.
 */

import type { Phase, Vec2 } from './engine-types.ts';
import {
  AGENT_CAL,
  clampToPitch,
  PITCH_LENGTH,
  PITCH_WIDTH,
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

// ── pitch-control computation ─────────────────────────────────────────────────

/**
 * Time for one player to reach a point: the reaction window carries them at
 * their current velocity, then they accelerate toward the point up to vmax.
 * vmax scales with pace and fatigue, the acceleration phase with the
 * acceleration attribute (kinematics: d_accel = vmax²/2a).
 */
export function arrivalTime(p: AgentSnapshot, x: number, y: number): number {
  const vmax = Math.max(
    0.5,
    AGENT_CAL.maxSpeedMps * (p.attributes.pace / 20) * (1 - AGENT_CAL.fatigueSpeedPenalty * p.fatigue),
  );
  const accel = Math.max(0.5, AGENT_CAL.maxAccelMps2 * (p.attributes.acceleration / 20));
  const tReact = AGENT_CAL.arrivalTimeReactionSeconds;
  const px = p.pos.x + p.vel.x * tReact;
  const py = p.pos.y + p.vel.y * tReact;
  const dx = x - px;
  const dy = y - py;
  const d = Math.sqrt(dx * dx + dy * dy);
  const dAccel = (vmax * vmax) / (2 * accel);
  const tRun = d <= dAccel ? Math.sqrt((2 * d) / accel) : vmax / accel + (d - dAccel) / vmax;
  return tReact + tRun;
}

/** Reusable coarse grid. One instance per model — computePitchControl refills
 * it in place (no per-tick allocation churn); the return value aliases it. */
export class PitchControlGrid implements PitchControlField {
  readonly cols = AGENT_CAL.pitchControlCols;
  readonly rows = AGENT_CAL.pitchControlRows;
  private readonly values: Float64Array;
  private readonly centerX: Float64Array;
  private readonly centerY: Float64Array;

  constructor() {
    this.values = new Float64Array(this.cols * this.rows);
    this.centerX = new Float64Array(this.cols);
    this.centerY = new Float64Array(this.rows);
    for (let c = 0; c < this.cols; c++) this.centerX[c] = ((c + 0.5) * PITCH_LENGTH) / this.cols;
    for (let r = 0; r < this.rows; r++) this.centerY[r] = ((r + 0.5) * PITCH_WIDTH) / this.rows;
  }

  fill(home: AgentSnapshot[], away: AgentSnapshot[]): void {
    const k = AGENT_CAL.controlSteepness;
    for (let r = 0; r < this.rows; r++) {
      const y = this.centerY[r];
      for (let c = 0; c < this.cols; c++) {
        const x = this.centerX[c];
        let tHome = Infinity;
        for (const p of home) {
          const t = arrivalTime(p, x, y);
          if (t < tHome) tHome = t;
        }
        let tAway = Infinity;
        for (const p of away) {
          const t = arrivalTime(p, x, y);
          if (t < tAway) tAway = t;
        }
        // shares sum to 1 by construction: away share = σ(−kΔ) = 1 − σ(kΔ)
        this.values[r * this.cols + c] = 1 / (1 + Math.exp(-k * (tAway - tHome)));
      }
    }
  }

  controlAt(col: number, row: number): number {
    return this.values[row * this.cols + col];
  }

  controlAtPoint(p: Vec2): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor((p.x / PITCH_LENGTH) * this.cols)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((p.y / PITCH_WIDTH) * this.rows)));
    return this.controlAt(col, row);
  }
}

// ── model implementation ──────────────────────────────────────────────────────

export class AnchorPositioningModel implements PositioningModel {
  private readonly grid = new PitchControlGrid();

  computePitchControl(home: AgentSnapshot[], away: AgentSnapshot[], _ball: BallState): PitchControlField {
    this.grid.fill(home, away);
    return this.grid;
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
