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
 * Deformation is REAL: team-instruction shaping (lineHeight/width/
 * compactness), a pressing set chasing the ball, marking pickups, off-ball
 * forward runs, and teammate space repulsion — all AGENT_CAL-weighted.
 */

import type { Phase, Vec2 } from './engine-types.ts';
import {
  AGENT_CAL,
  arrivalTime,
  clampToPitch,
  dist,
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
    const side = ctx.team.side;
    const inPossession = ctx.possession === side;
    const attackSign = side === 'home' ? 1 : -1;
    const team = ctx.team.tactics.team;
    const goalX = side === 'home' ? PITCH_LENGTH : 0;
    const outfield = ctx.teammates.filter((p) => !p.isGk);
    const centroidX = outfield.reduce((s, p) => s + p.pos.x, 0) / Math.max(1, outfield.length);

    // offside line: second-last opponent (GK included). In possession,
    // attackers hold this line instead of camping beyond it — offsides then
    // come from timing (line pushes up, runners lag), not from standing there.
    const oppXs = ctx.opponents.map((o) => o.pos.x).sort((a, b) => (side === 'home' ? b - a : a - b));
    const offsideLine = oppXs[1] ?? oppXs[0] ?? (side === 'home' ? PITCH_LENGTH : 0);
    const holdLineX = (x: number): number =>
      side === 'home' ? Math.min(x, Math.max(offsideLine - 0.3, PITCH_LENGTH / 2))
      : Math.max(x, Math.min(offsideLine + 0.3, PITCH_LENGTH / 2));

    // the press: nearest N outfielders to the ball, if close enough
    const pressers = new Set(
      inPossession
        ? []
        : outfield
            .filter((p) => dist(p.pos, ctx.ball.pos) < AGENT_CAL.pressMaxDistM)
            .sort((a, b) => dist(a.pos, ctx.ball.pos) - dist(b.pos, ctx.ball.pos))
            .slice(0, AGENT_CAL.pressersCount)
            .map((p) => p.id),
    );

    for (const p of ctx.teammates) {
      // the carrier is steered by the decision model, not by shape
      if (p.id === ctx.ball.carrierId) {
        targets.set(p.id, p.pos);
        continue;
      }
      if (p.isGk) {
        targets.set(p.id, clampToPitch({
          x: side === 'home' ? AGENT_CAL.gkBoxX : PITCH_LENGTH - AGENT_CAL.gkBoxX,
          y: PITCH_WIDTH / 2 + (ctx.ball.pos.y - PITCH_WIDTH / 2) * AGENT_CAL.gkBallTrackY,
        }));
        continue;
      }

      const anchor = ctx.anchors.get(p.id)?.[ctx.phase] ?? p.pos;
      // team-instruction shaping of the base point
      const base: Vec2 = {
        x: anchor.x + (inPossession ? 0 : (team.lineHeight - 0.5) * AGENT_CAL.lineHeightShiftM * attackSign),
        y: PITCH_WIDTH / 2 +
          (anchor.y - PITCH_WIDTH / 2) * (AGENT_CAL.widthSpreadBase + AGENT_CAL.widthSpreadGain * team.width),
      };

      // weighted attractors (each pulls the target toward a point)
      let wSum = AGENT_CAL.anchorPull;
      let x = base.x * AGENT_CAL.anchorPull;
      let y = base.y * AGENT_CAL.anchorPull;
      const pull = (point: Vec2, w: number): void => {
        if (w <= 0) return;
        wSum += w;
        x += point.x * w;
        y += point.y * w;
      };

      if (pressers.has(p.id)) {
        pull(ctx.ball.pos, AGENT_CAL.pressPullWeight * (0.5 + p.instructions.pressingIntensity) * (0.5 + team.pressTrigger));
      } else if (!inPossession) {
        // marking: pick up the nearest unengaged opponent within radius
        const mark = ctx.opponents
          .filter((o) => !o.isGk && dist(o.pos, p.pos) < AGENT_CAL.markingRadiusM)
          .sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos))[0];
        if (mark) pull(mark.pos, AGENT_CAL.markingAttraction * (p.attributes.marking / 20));
        // compactness squeezes the block toward the team centroid
        pull({ x: centroidX, y: base.y }, AGENT_CAL.compactnessPull * team.compactness);
        pull(ctx.ball.pos, AGENT_CAL.ballAttraction * 0.5);
      } else {
        pull(ctx.ball.pos, AGENT_CAL.ballAttraction * (1 - 0.5 * p.instructions.holdPosition));
        // off-ball forward runs, stronger deep in the attack
        const runW = AGENT_CAL.forwardRunPull * (p.attributes.offTheBall / 20) *
          (ctx.phase === 'finalThird' || ctx.phase === 'counterAttack' ? 1.4 : 1) *
          (1 - 0.6 * p.instructions.holdPosition);
        pull({ x: goalX, y: p.pos.y }, runW);
      }

      let target: Vec2 = { x: x / wSum, y: y / wSum };

      // space repulsion: don't stack on the nearest teammate
      const nearest = ctx.teammates
        .filter((t) => t.id !== p.id && !t.isGk)
        .sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos))[0];
      if (nearest && dist(nearest.pos, target) < AGENT_CAL.repulsionRadiusM) {
        const d = Math.max(0.5, dist(nearest.pos, target));
        const push = (AGENT_CAL.repulsionRadiusM - d) * AGENT_CAL.spaceRepulsion;
        target = { x: target.x + ((target.x - nearest.pos.x) / d) * push, y: target.y + ((target.y - nearest.pos.y) / d) * push };
      }

      if (inPossession) target.x = holdLineX(target.x); // play on the shoulder

      targets.set(p.id, clampToPitch(target));
    }
    return targets;
  }
}
