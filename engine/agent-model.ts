/**
 * agent-model.ts — shared world-state types + AGENT_CAL for the agent engine.
 *
 * Every tunable lives in AGENT_CAL — calibration never chases constants
 * across modules (same discipline as the aggregate engine's CAL). The shared
 * helpers here (arrivalTime, positionValue, xgProxy) are the single source of
 * truth all three sub-models read, so decision and execution can never
 * disagree about geometry or chance quality.
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
  cruiseSpeedShare: 0.35, // jog share of max speed for near-target shuffles
  urgencyDistM: 10, // target this far away → full sprint
  fatigueSpeedPenalty: 0.45, // ×(1 − penalty·fatigue)
  lineHeightShiftM: 12, // defensive base x shift across lineHeight 0→1
  widthSpreadBase: 0.7, // y spread = base + gain×width
  widthSpreadGain: 0.6,
  compactnessPull: 0.4, // ×team.compactness toward team centroid, out of possession
  pressPullWeight: 1.7, // nearest defenders chase the ball
  pressersCount: 2, // how many join the press
  pressMaxDistM: 30, // base chase radius, scaled by pressTrigger at use site
  pressRangeBase: 0.6, // chase range = pressMaxDistM × (base + gain·pressTrigger)
  pressRangeGain: 0.8, // trigger 0.9 chases from ~40 m; 0.1 from ~20 m
  counterPressRangeBoost: 1.3, // gegenpressing window: wider net, extra body
  forwardRunPull: 0.3, // ×(offTheBall/20), possession phases, off-ball players
  gkBoxX: 5.5, // GK holds this deep
  gkBallTrackY: 0.3, // GK lateral ball tracking share

  // ── decision ───────────────────────────────────────────────────────────────
  softmaxBaseTemperature: 0.55,
  temperaturePerDecisionsPoint: 0.03, // T = base − k·(decisions−10), floored
  temperatureFloor: 0.25,
  composurePressureRelief: 0.02, // pressure penalty attenuation per composure point
  pressureSecondWeight: 0.5, // second-nearest opponent's share of felt pressure
  passOptionCount: 5, // geometric candidates per decision (vision widens toward this)
  carryOptionCount: 3, // forward + two diagonals
  riskAppetiteScoreBias: 0.35, // instructions bias SCORING only (frozen invariant)
  riskTurnoverDiscount: 0.8, // riskAppetite shrinks the turnover-cost term
  // score-state behavior (DECISIONS.md): chasing teams open up, leading teams
  // see the game out. scoreState ∈ [−stateMax, stateMax], positive = chasing,
  // from goal difference × (base + timeGain·matchFraction). Decision biases +
  // positioning shifts only — execution noise stays attribute-driven.
  stateUrgencyBase: 0.25,
  stateUrgencyTimeGain: 1.0,
  stateMax: 1.5,
  stateRiskTurnoverDiscount: 0.45, // chasing discounts turnover fear
  stateShotBias: 0.15, // chasing shoots earlier
  stateHoldBias: 0.26, // chasing hates holding; leading loves it
  statePushShiftM: 7, // team base line shifts this far at full urgency
  stateForwardRunGain: 0.5, // chasing off-ball runs push harder
  homeExpansiveness: 0.3, // constant home scoreState offset — expansive hosts
  shootingBiasScoreBias: 0.25,
  holdPositionScoreBias: 0.2,
  dribbleBiasScoreBias: 0.15,
  crossBiasScoreBias: 0.9,
  // option geometry
  passRangeM: 30, // beyond → longPass (lofted)
  leadPassM: 2.5, // targets lead the receiver toward goal
  throughLeadM: 9, // through-ball variant: hard lead into space
  throughOptionCount: 2, // for the most advanced mates
  ambitiousOptionCount: 2, // most-advanced onside mates beyond the nearest set
  shotRangeM: 26,
  crossWideYOffsetM: 13, // |y − 34| beyond this in the final third → crossing zone
  carryStepM: 8,
  clearOwnRelXM: 30, // inside own-relative x AND pressured → clear is an option
  clearPressureFloor: 0.45,
  // scoring: score = P(complete)·V(target) − turnoverCost·(1−P)·V_opp(target)
  valueControlWeight: 0.5, // pitch-control share folded into V(target)
  turnoverCostWeight: 1.25,
  xtProgressExp: 1.6, // positionValue = (x_rel/105)^exp × width falloff
  xtWidthPenalty: 0.5,
  passBaseLogit: 1.9, // P(complete) logit intercept
  passSkillLogit: 1.0, // ×(skill/20 − 0.5)·2
  passDistDecayM: 20, // logit −d/decay
  laneRiskLogit: 1.6, // ×(1 − nearest-opponent-to-lane / laneRadius)
  laneRadiusM: 4,
  controlCompletionLogit: 0.8, // ×(ourControl(target) − 0.5)
  carryBaseLogit: 1.0,
  carryPressureLogit: 1.5,
  shotBaseScore: -0.76, // negative gate on shot volume (xg term restores good chances)
  shotValueWeight: 0.6, // shot score = base + weight × xgProxy + biases
  holdBaseScore: -0.15,
  holdPressurePenalty: 0.5,
  tempoHoldPenalty: 0.25, // high tempo teams hate standing on the ball
  clearBaseScore: -0.5,
  clearPressureGain: 1.0,
  // shared xG proxy (decision scoring now, shot/GK models in parts c–d)
  xgMax: 0.45,
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
  aerialStrengthWeight: 0.25,
  gkAerialHandsBonus: 2, // keepers can catch — a reach edge in claim contests
  aerialArrivalPerSecond: 3, // duel-score points per second of arrival advantage
  aerialNoiseSigma: 2,
  // success resolution (execution owns the truth; decision only estimates)
  groundPassSpeedMps: 14,
  loftedPassSpeedMps: 16, // chord speed of the arc — hang time favors defenders
  raceSteepness: 2.5, // logit per second of ball-vs-defender arrival margin
  interceptOffsetS: 0.35, // defender must beat the ball by this for even odds
  anticipationRaceS: 0.06, // seconds shaved off arrival per anticipation point over 10
  execComposureRelief: 0.025, // pressure attenuation ×composure (execution side)
  passExecBaseLogit: 1.9, // technical completion given no interception
  passExecSkillLogit: 1.8, // ×(attr/20 − 0.5)·2
  passExecPressureLogit: 1.0,
  loftedSkillExtraLogit: 1.8, // longPassing/crossing bite harder on lofted balls
  carryExecBaseLogit: 2.2,
  carryExecSkillLogit: 1.2,
  carryExecPressureLogit: 1.8,
  carryControlLogit: 0.8, // ×(ourControl(end) − 0.5)
  shotOnTargetBase: 0.0,
  shotSkillLogit: 1.0,
  shotDistDecayM: 14, // logit −d/decay
  shotPressureLogit: 0.8,
  gkBeatBase: -0.05, // P(goal | on target) logit vs keeper quality
  gkXgWeight: 3.0, // ×(xgProxy − 0.1): big chances beat keepers
  gkQualityLogit: 1.2, // ×(mean(gkReflexes, gkPositioning)/20 − 0.5)·2

  // ── phases ─────────────────────────────────────────────────────────────────
  counterPressSeconds: 6, // window after losing the ball (types.ts note: ~6 s)
  counterAttackSeconds: 6, // window after winning it, opponent unset
  finalThirdX: 70, // own-relative x beyond which possession is 'finalThird'
  buildUpX: 35, // below which controlled possession is 'buildUp'

  // ── events: fouls / cards / injuries / offsides / set pieces ──────────────
  foulPerTackle: 0.14, // P(foul | failed-carry challenge), aggression-scaled
  aggressionFoulGain: 0.4, // ×(1 + gain·(aggression/20 − 0.5))
  aerialFoulRate: 0.02, // duel loser brings the man down
  yellowPerFoul: 0.17,
  redPerFoul: 0.006, // straight red; second yellow also sends off
  bookedCautionFactor: 0.1, // players on a yellow tackle carefully
  boxFoulFactor: 0.18, // nobody dives in inside their own box
  injuryPerTickBase: 0.0000019, // ≈ 3.2%/player/match at 10800 ticks incl fatigue gain
  injuryFatigueGain: 1.0, // hazard ×(1 + gain·fatigue)
  offsideToleranceM: 0.5, // linesman: receiver this far beyond the second-last defender → flagged
  passerLineJudgementM: 1.5, // passers skip receivers beyond line+this; the flag band is tolerance..judgement
  lineHoldBufferM: 2.0, // attackers hold this far INSIDE the line (onside-safe hover)
  penaltyGoalProb: 0.76,
  cornerProb: 0.1, // P(corner | shot saved or off target)
  setPieceHeaderXgFactor: 0.62, // headers convert worse than feet from the same spot
  setPieceDeliveryNoiseM: 3.5, // ×(20 − setPieceDelivery)/20
  homePressureRelief: 0.45, // crowd effect: home carrier feels less pressure

  // ── bookkeeping ────────────────────────────────────────────────────────────
  fatiguePerTick: 0.00007, // ~0.24/half at tick 0.5 s before stamina scaling
  fatigueWorkShare: 0.9, // share of the tick's fatigue that scales with distance run
  staminaFatigueRelief: 0.5, // ×(1 − relief·stamina/20)
  ppdaZoneOwnRelXM: 55, // build-up zone: passer's own-relative x below this
  ratingGoalBonus: 0.8, // playerRatings: base 6.5 ± these
  ratingAerialBonus: 0.05,
  ratingCardPenalty: 0.4,
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

