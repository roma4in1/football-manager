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
  markingRadiusM: 16, // opponents beyond this aren't picked up
  spaceRepulsion: 0.3, // repulsor: teammate crowding
  repulsionRadiusM: 8,
  maxSpeedMps: 7.5, // scaled by pace/20 at use sites
  fatigueSpeedPenalty: 0.25, // ×(1 − penalty·fatigue)
  lineHeightShiftM: 12, // defensive base x shift across lineHeight 0→1
  widthSpreadBase: 0.7, // y spread = base + gain×width
  widthSpreadGain: 0.6,
  compactnessPull: 0.4, // ×team.compactness toward team centroid, out of possession
  pressPullWeight: 1.4, // nearest defenders chase the ball
  pressersCount: 2, // how many join the press
  pressMaxDistM: 30, // beyond this nobody presses
  forwardRunPull: 0.3, // ×(offTheBall/20), possession phases, off-ball players
  gkBoxX: 5.5, // GK holds this deep
  gkBallTrackY: 0.3, // GK lateral ball tracking share

  // ── decision ───────────────────────────────────────────────────────────────
  softmaxBaseTemperature: 1.0,
  temperaturePerDecisionsPoint: 0.03, // T = base − k·(decisions−10), floored
  temperatureFloor: 0.25,
  composurePressureRelief: 0.02, // pressure penalty attenuation per composure point
  passOptionCount: 5, // geometric candidates per decision (vision widens toward this)
  carryOptionCount: 3, // forward + two diagonals
  riskAppetiteScoreBias: 0.3, // instructions bias SCORING only (frozen invariant)
  shootingBiasScoreBias: 0.4,
  holdPositionScoreBias: 0.2,
  dribbleBiasScoreBias: 0.15,
  crossBiasScoreBias: 0.35,
  // option geometry
  passRangeM: 26, // beyond → longPass (lofted)
  leadPassM: 2.5, // targets lead the receiver toward goal
  shotRangeM: 28,
  crossWideYOffsetM: 16, // |y − 34| beyond this in the final third → crossing zone
  carryStepM: 8,
  clearOwnRelXM: 30, // inside own-relative x AND pressured → clear is an option
  clearPressureFloor: 0.45,
  // scoring: score = P(complete)·V(target) − turnoverCost·(1−P)·V_opp(target)
  valueControlWeight: 0.5, // pitch-control share folded into V(target)
  turnoverCostWeight: 0.6,
  xtProgressExp: 1.6, // positionValue = (x_rel/105)^exp × width falloff
  xtWidthPenalty: 0.5,
  passBaseLogit: 1.9, // P(complete) logit intercept
  passSkillLogit: 1.0, // ×(skill/20 − 0.5)·2
  passDistDecayM: 20, // logit −d/decay
  laneRiskLogit: 1.6, // ×(1 − nearest-opponent-to-lane / laneRadius)
  laneRadiusM: 4,
  controlCompletionLogit: 0.8, // ×(ourControl(target) − 0.5)
  carryBaseLogit: 1.4,
  carryPressureLogit: 1.5,
  shotValueWeight: 1.4, // shot score = weight × xgProxy + biases
  holdBaseScore: -0.15,
  holdPressurePenalty: 0.5,
  tempoHoldPenalty: 0.25, // high tempo teams hate standing on the ball
  clearBaseScore: -0.5,
  clearPressureGain: 1.0,
  // shared xG proxy (decision scoring now, shot/GK models in parts c–d)
  xgMax: 0.75,
  xgDistDecayM: 11,
  xgCentralityFloor: 0.25, // angle factor: floor + (1−floor)×centrality

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
  fatigueWorkShare: 0.6, // share of the tick's fatigue that scales with distance run
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

/**
 * Time for one player to reach a point: the reaction window carries them at
 * their current velocity, then they accelerate toward the point up to vmax.
 * vmax scales with pace and fatigue, the acceleration phase with the
 * acceleration attribute (kinematics: d_accel = vmax²/2a).
 */
/**
 * Value of holding the ball at a point for the side attacking goalX — an
 * xT-style proxy: grows toward the opponent goal (power curve), damped
 * toward the touchlines. In [0, 1].
 */
export function positionValue(p: Vec2, goalX: number): number {
  const xRel = goalX === 0 ? PITCH_LENGTH - p.x : p.x;
  const progress = Math.pow(Math.max(0, xRel) / PITCH_LENGTH, AGENT_CAL.xtProgressExp);
  const widthFalloff = 1 - AGENT_CAL.xtWidthPenalty * Math.pow(Math.abs(p.y - PITCH_WIDTH / 2) / (PITCH_WIDTH / 2), 2);
  return progress * widthFalloff;
}

/**
 * Shared xG proxy — distance decay × centrality. Used by decision scoring
 * now, and by the shot/GK resolution models (parts c–d) so the two never
 * disagree about what a good chance is.
 */
export function xgProxy(shotPos: Vec2, goalX: number): number {
  const d = dist(shotPos, { x: goalX, y: PITCH_WIDTH / 2 });
  const centrality = 1 - Math.min(1, Math.abs(shotPos.y - PITCH_WIDTH / 2) / (PITCH_WIDTH / 2));
  const angleFactor = AGENT_CAL.xgCentralityFloor + (1 - AGENT_CAL.xgCentralityFloor) * centrality;
  return AGENT_CAL.xgMax * Math.exp(-d / AGENT_CAL.xgDistDecayM) * angleFactor;
}

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

