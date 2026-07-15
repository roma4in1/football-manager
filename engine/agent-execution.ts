/**
 * agent-execution.ts — what actually happens to the chosen action.
 *
 * Attribute-driven directional/velocity noise, applied AFTER the decision
 * (frozen invariant: instructions never touch execution). The ball-flight
 * enum is load-bearing: lofted/high deliveries route through aerial-duel
 * resolution (jumping/heading + height), ground/driven do not.
 *
 * Success resolution (Phase 1 ball-flight split):
 * - pass family: execution owns the STRIKE only — a technical logistic
 *   (skill, pressure attenuated by composure) decides clean vs shanked, and
 *   a shank flies with amplified scatter. WHO GETS THE BALL is decided by
 *   the engine's in-flight simulation (real travel time, receiver runs,
 *   spatial defender interception) — never by a pre-resolved race here.
 * - carry: dribbling/pressure/control logistic; shot: on-target logistic
 *   (finishing, distance, pressure) then an xG-conditioned keeper beat
 *   (gkReflexes/gkPositioning) — the same xgProxy the decision scored with.
 * - aerial duel: jumping/heading/height/strength plus arrival-time
 *   positioning advantage at the drop point.
 *
 * The engine passes a context (control lookup, opponents, receiver, GK) —
 * as plain data/closures, keeping the no-sideways-imports rule intact.
 */

import type { BallFlight, Vec2 } from './engine-types.ts';
import { AGENT_CAL, arrivalTime, clampToPitch, dist, shotQuality, type AgentSnapshot } from './agent-model.ts';
import type { ActionOption } from './agent-decision.ts';
import type { KeyedRng } from './agent-rng.ts';

// ── contracts ─────────────────────────────────────────────────────────────────

export interface ExecContext {
  actor: AgentSnapshot;
  /** P(actor's side controls the point) — closure over the pitch-control field */
  ourControl: (p: Vec2) => number;
  opponents: AgentSnapshot[];
  /** intended receiver for pass-family actions (undefined for clear) */
  receiver?: AgentSnapshot;
  defendingGk?: AgentSnapshot;
  /** pressure on the actor in [0,1] */
  pressure: number;
  attackingGoalX: number; // 105 or 0
}

export interface ExecutionOutcome {
  action: ActionOption;
  /** the action came off as intended (clean strike / carry held / shot on target) */
  success: boolean;
  /** where the ball is headed (noise applied; a shank scatters further) */
  endPoint: Vec2;
  flight: BallFlight;
  /** set on shots: whether it beat the keeper */
  goal?: boolean;
}

export interface AerialContest {
  ball: Vec2;
  contestants: AgentSnapshot[]; // ≥ 2, mixed sides
  heightCmById: ReadonlyMap<string, number>;
}

export interface AerialOutcome {
  winnerId: string;
  /** where the winner directs the ball */
  endPoint: Vec2;
  flight: BallFlight;
}

export interface ExecutionModel {
  execute(action: ActionOption, ctx: ExecContext, rng: KeyedRng, tick: number): ExecutionOutcome;
  /** lofted/high arrivals with multiple contestants resolve here */
  resolveAerialDuel(contest: AerialContest, rng: KeyedRng, tick: number): AerialOutcome;
}

// ── noise helpers (real — these ARE the execution-noise plumbing) ────────────

/** rotate + stretch the actor→target vector by attribute-scaled noise.
 * `clamp=false` (pass family): the raw point may leave the pitch — the engine
 * turns that into a real out-of-bounds instead of pretending it stayed in. */
function applyNoise(
  from: Vec2,
  target: Vec2,
  skill: number, // 1–20; higher = tighter
  dirNoiseRad: number,
  velNoise: number,
  rng: KeyedRng,
  clamp: boolean,
  ...key: (string | number)[]
): Vec2 {
  const slack = (20 - skill) / 20;
  const stream = rng.stream(...key);
  const angle = Math.atan2(target.y - from.y, target.x - from.x) + stream.gauss(0, dirNoiseRad * slack);
  const length = dist(from, target) * (1 + stream.gauss(0, velNoise * slack));
  const raw = { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
  return clamp ? clampToPitch(raw) : raw;
}

// keepers' outfield attributes are seeded flat-low (MAPPING rule 3): their
// distribution skill lives in gkDistribution, which pass-family execution
// reads for GK actors
const gkAware = (outfield: (a: AgentSnapshot) => number, forPass: boolean) =>
  (a: AgentSnapshot): number => (a.isGk && forPass ? a.attributes.gkDistribution : outfield(a));

const NOISE_BY_TYPE: Record<string, { dir: number; vel: number; skill: (a: AgentSnapshot) => number }> = {
  pass: { dir: AGENT_CAL.passDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: gkAware((a) => a.attributes.passing, true) },
  longPass: { dir: AGENT_CAL.longPassDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: gkAware((a) => a.attributes.longPassing, true) },
  cross: { dir: AGENT_CAL.crossDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: gkAware((a) => a.attributes.crossing, true) },
  shot: { dir: AGENT_CAL.shotDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: (a) => a.attributes.finishing },
  clear: { dir: AGENT_CAL.longPassDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: gkAware((a) => a.attributes.longPassing, true) },
  carry: { dir: 0.08, vel: 0.05, skill: (a) => a.attributes.dribbling },
};

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** attribute logit term: maps 1–20 onto ≈ [−1, 1] around 10 */
const skillEdge = (attr: number): number => (attr / 20 - 0.5) * 2;

/** effective pressure after composure attenuation (execution side) */
const feltPressure = (p: AgentSnapshot, pressure: number): number =>
  pressure * Math.max(0, 1 - AGENT_CAL.execComposureRelief * p.attributes.composure);

// ── model implementation ──────────────────────────────────────────────────────

export class NoisyExecutionModel implements ExecutionModel {
  execute(action: ActionOption, ctx: ExecContext, rng: KeyedRng, tick: number): ExecutionOutcome {
    const actor = ctx.actor;
    if (action.type === 'hold') {
      return { action, success: true, endPoint: actor.pos, flight: 'ground' };
    }
    const profile = NOISE_BY_TYPE[action.type] ?? NOISE_BY_TYPE.pass;
    const passFamily = action.type !== 'shot' && action.type !== 'carry'; // hold early-returned above
    const endPoint = applyNoise(
      actor.pos, action.target, profile.skill(actor), profile.dir, profile.vel,
      rng, !passFamily, tick, actor.id, 'exec', action.type,
    );

    if (action.type === 'shot') {
      const d = dist(actor.pos, action.target);
      const pOnTarget = sigmoid(
        AGENT_CAL.shotOnTargetBase +
        AGENT_CAL.shotSkillLogit * skillEdge(actor.attributes.finishing) -
        d / AGENT_CAL.shotDistDecayM -
        AGENT_CAL.shotPressureLogit * feltPressure(actor, ctx.pressure),
      );
      const onTarget = rng.chance(pOnTarget, tick, actor.id, 'outcome', 'shot');
      let goal = false;
      if (onTarget) {
        const gk = ctx.defendingGk;
        const gkQuality = gk ? (gk.attributes.gkReflexes + gk.attributes.gkPositioning) / 2 : 10;
        const pBeat = sigmoid(
          AGENT_CAL.gkBeatBase +
          AGENT_CAL.gkXgWeight * (shotQuality(actor.pos, ctx.attackingGoalX) - 0.1) -
          AGENT_CAL.gkQualityLogit * skillEdge(gkQuality),
        );
        goal = rng.chance(pBeat, tick, actor.id, 'outcome', 'gk');
      }
      return { action, success: onTarget, endPoint, flight: action.flight, goal };
    }

    if (action.type === 'carry') {
      const p = sigmoid(
        AGENT_CAL.carryExecBaseLogit +
        AGENT_CAL.carryExecSkillLogit * skillEdge(actor.attributes.dribbling) -
        AGENT_CAL.carryExecPressureLogit * feltPressure(actor, ctx.pressure) +
        AGENT_CAL.carryControlLogit * (ctx.ourControl(endPoint) - 0.5),
      );
      const success = rng.chance(p, tick, actor.id, 'outcome', 'carry');
      return { action, success, endPoint, flight: 'ground' };
    }

    // pass family (Phase 1 ball-flight model): execution owns the STRIKE, the
    // world owns the outcome. The technical logistic decides whether the ball
    // is hit cleanly; a shank still flies — with amplified scatter — and the
    // engine's in-flight simulation (receiver runs, defender convergence,
    // spatial interception) decides who ends up with it. The old pre-resolved
    // interception race (pSafe) is GONE: physics decides where physics should.
    // Lofted balls keep the EXTRA technical skill term: the drop-point contest
    // forgives scatter (someone runs onto anything), so without it the
    // longPassing attribute barely moves completion.
    const lofted = action.flight === 'lofted' || action.flight === 'high';
    const pTechnical = sigmoid(
      AGENT_CAL.passExecBaseLogit +
      AGENT_CAL.passExecSkillLogit * skillEdge(profile.skill(actor)) +
      (lofted ? AGENT_CAL.loftedSkillExtraLogit * skillEdge(profile.skill(actor)) : 0) -
      AGENT_CAL.passExecPressureLogit * feltPressure(actor, ctx.pressure),
    );
    const cleanStrike = rng.chance(pTechnical, tick, actor.id, 'outcome', action.type);
    const finalPoint = cleanStrike
      ? endPoint
      : applyNoise(
          actor.pos, action.target, profile.skill(actor),
          profile.dir * AGENT_CAL.shankDirNoiseMul, profile.vel * AGENT_CAL.shankVelNoiseMul,
          rng, false, tick, actor.id, 'shank', action.type,
        );
    return { action, success: cleanStrike, endPoint: finalPoint, flight: action.flight };
  }

  resolveAerialDuel(contest: AerialContest, rng: KeyedRng, tick: number): AerialOutcome {
    // jumping/heading/height/strength, plus being there first: arrival-time
    // advantage over the best of the rest at the drop point.
    const arrivals = contest.contestants.map((c) => arrivalTime(c, contest.ball.x, contest.ball.y));
    const scores = contest.contestants.map((c, i) => {
      const height = contest.heightCmById.get(c.id) ?? 180;
      let bestOther = Infinity;
      for (let j = 0; j < arrivals.length; j++) if (j !== i && arrivals[j] < bestOther) bestOther = arrivals[j];
      const advantage = Math.max(-1, Math.min(1, bestOther - arrivals[i]));
      // keepers contest with their COMMAND (gk attributes + hands), not the
      // flat-low outfield jumping/heading the seed gives them
      const command = c.isGk ? (c.attributes.gkReflexes + c.attributes.gkPositioning) / 2 : 0;
      const jump = c.isGk ? command : c.attributes.jumping;
      const head = c.isGk ? command : c.attributes.heading;
      const strength = c.isGk ? command : c.attributes.strength;
      return (
        AGENT_CAL.aerialJumpingWeight * jump +
        AGENT_CAL.aerialHeadingWeight * head +
        AGENT_CAL.aerialStrengthWeight * strength +
        (c.isGk ? AGENT_CAL.gkAerialHandsBonus : 0) +
        AGENT_CAL.aerialHeightCmWeight * Math.max(0, height - 170) * 20 +
        AGENT_CAL.aerialArrivalPerSecond * advantage +
        rng.gauss(0, AGENT_CAL.aerialNoiseSigma, tick, c.id, 'aerial')
      );
    });
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    const winner = contest.contestants[best];
    return {
      winnerId: winner.id,
      endPoint: clampToPitch({
        x: contest.ball.x + rng.gauss(0, 6, tick, winner.id, 'aerial-out-x'),
        y: contest.ball.y + rng.gauss(0, 6, tick, winner.id, 'aerial-out-y'),
      }),
      flight: 'ground',
    };
  }
}
