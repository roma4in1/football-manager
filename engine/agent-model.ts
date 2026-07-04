/**
 * agent-model.ts — shared world-state types + AGENT_CAL for the agent engine.
 *
 * SCAFFOLD (see DECISIONS.md, agent-engine architecture): types and module
 * boundaries are the deliverable; behavior is stubbed. Every tunable lives in
 * AGENT_CAL from day one — Wednesday's calibration must never chase constants
 * across modules (same discipline as the aggregate engine's CAL).
 *
 * Dependency direction (enforced by review + dependency-cruiser's engine
 * isolation): agent-model ← {agent-positioning, agent-decision,
 * agent-execution} ← agent-engine. Sub-models never import each other.
 */

import type { Attributes, BallFlight, Phase, PlayerInstructions, Tactics, Vec2 } from './engine-types.ts';

/** ALL agent-engine tunables. Placeholder values only — calibration is Wednesday's job. */
export const AGENT_CAL = {
  // ── tick loop ──────────────────────────────────────────────────────────────
  tickSeconds: 0.5, // sim step
  decisionEveryTicks: 2, // carrier re-decides at this cadence
  frameEverySeconds: 6, // MUST match the aggregate engine's frameDt (replay contract)

  // ── pitch control (Spearman-style, coarse grid) ───────────────────────────
  pitchControlCols: 21, // 5 m cells across 105 m
  pitchControlRows: 14, // ~4.9 m cells across 68 m
  arrivalTimeReactionSeconds: 0.7, // velocity carries the player through this window
  controlSteepness: 4, // logistic slope on best-arrival-time differential (per second)
  maxAccelMps2: 6, // ×(acceleration/20) at use sites — accel phase of the arrival model

  // ── positioning ────────────────────────────────────────────────────────────
  anchorPull: 1.0, // weight toward the phase anchor
  ballAttraction: 0.35, // attractor: ball position
  markingAttraction: 0.5, // attractor: assigned opponent (out of possession)
  spaceRepulsion: 0.3, // repulsor: teammate crowding
  repulsionRadiusM: 8,
  maxSpeedMps: 7.5, // scaled by pace/20 at use sites
  fatigueSpeedPenalty: 0.25, // ×(1 − penalty·fatigue)

  // ── decision ───────────────────────────────────────────────────────────────
  softmaxBaseTemperature: 1.0,
  temperaturePerDecisionsPoint: 0.03, // T = base − k·(decisions−10), floored
  temperatureFloor: 0.25,
  composurePressureRelief: 0.02, // pressure penalty attenuation per composure point
  passOptionCount: 5, // geometric candidates per decision
  carryOptionCount: 3,
  riskAppetiteScoreBias: 0.3, // instructions bias SCORING only (frozen invariant)
  shootingBiasScoreBias: 0.4,
  holdPositionScoreBias: 0.2,

  // ── execution ──────────────────────────────────────────────────────────────
  passDirectionNoiseRad: 0.12, // ×(20 − passing)/20 at use sites
  longPassDirectionNoiseRad: 0.2, // reads longPassing, never passing
  crossDirectionNoiseRad: 0.18, // reads crossing
  passVelocityNoise: 0.1,
  shotDirectionNoiseRad: 0.15, // reads finishing (feet) / heading (headers)
  carryNoiseM: 0.6, // dribbling-scaled waypoint scatter
  receiveNoiseM: 1.2, // firstTouch-scaled trap scatter
  aerialHeightCmWeight: 0.02, // duel score: height contribution per cm over 170
  aerialJumpingWeight: 0.6,
  aerialHeadingWeight: 0.4,

  // ── phases ─────────────────────────────────────────────────────────────────
  counterPressSeconds: 6, // window after losing the ball (types.ts note: ~6 s)
  counterAttackSeconds: 6, // window after winning it, opponent unset
  finalThirdX: 70, // own-relative x beyond which possession is 'finalThird'
  buildUpX: 35, // below which controlled possession is 'buildUp'

  // ── bookkeeping ────────────────────────────────────────────────────────────
  fatiguePerTick: 0.00009, // ~0.24/half at tick 0.5 s before stamina scaling
  staminaFatigueRelief: 0.5, // ×(1 − relief·stamina/20)
} as const;

// ── world state ───────────────────────────────────────────────────────────────

export type Side = 'home' | 'away';

/** Mutable per-player sim state. Positions are GLOBAL frame (home attacks +x). */
export interface AgentState {
  id: string;
  side: Side;
  isGk: boolean;
  pos: Vec2;
  vel: Vec2;
  attributes: Attributes;
  instructions: PlayerInstructions;
  /** per-phase anchors in GLOBAL frame (away anchors pre-flipped at setup) */
  anchors: Record<Phase, Vec2>;
  fatigue: number; // 0–1, grows during the half
  yellows: 0 | 1;
  sentOff: boolean;
  injured: boolean;
  startMinutes: number; // carried from resume state
  startFatigue: number;
}

/** Read-only view handed to the sub-models each tick. */
export interface AgentSnapshot {
  readonly id: string;
  readonly side: Side;
  readonly isGk: boolean;
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly attributes: Attributes;
  readonly instructions: PlayerInstructions;
  readonly fatigue: number;
}

export interface BallState {
  pos: Vec2;
  flight: BallFlight;
  /** player in control, or null while the ball travels / is contested */
  carrierId: string | null;
  /** side last in control — drives phase inference while the ball travels */
  lastTouchSide: Side;
}

/** One team's static context for the half. */
export interface TeamContext {
  side: Side;
  tactics: Tactics;
  playerIds: string[]; // active (sent-off excluded)
}

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;

export const clampToPitch = (p: Vec2): Vec2 => ({
  x: Math.min(PITCH_LENGTH, Math.max(0, p.x)),
  y: Math.min(PITCH_WIDTH, Math.max(0, p.y)),
});

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
