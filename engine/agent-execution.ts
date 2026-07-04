/**
 * agent-execution.ts — what actually happens to the chosen action.
 *
 * Attribute-driven directional/velocity noise, applied AFTER the decision
 * (frozen invariant: instructions never touch execution). The ball-flight
 * enum is load-bearing: lofted/high deliveries route through aerial-duel
 * resolution (jumping/heading + height), ground/driven do not.
 *
 * Success resolution is REAL:
 * - pass family: an interception RACE along the actual (noised) ball path —
 *   defender arrival times (the shared arrival-time model, anticipation-
 *   shaved) vs ball travel time at sampled nodes — times a technical
 *   completion logistic (skill, pressure attenuated by composure).
 * - lofted balls race only at the reception point (receiver vs best
 *   defender); losing that race hands the contest to the aerial duel.
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
import { AGENT_CAL, arrivalTime, clampToPitch, dist, xgProxy, type AgentSnapshot } from './agent-model.ts';
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
  /** did the action come off as intended (pass arrives, shot on target…) */
  success: boolean;
  /** where the ball ends up (noise applied) */
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

/** rotate + stretch the actor→target vector by attribute-scaled noise */
function applyNoise(
  from: Vec2,
  target: Vec2,
  skill: number, // 1–20; higher = tighter
  dirNoiseRad: number,
  velNoise: number,
  rng: KeyedRng,
  ...key: (string | number)[]
): Vec2 {
  const slack = (20 - skill) / 20;
  const stream = rng.stream(...key);
  const angle = Math.atan2(target.y - from.y, target.x - from.x) + stream.gauss(0, dirNoiseRad * slack);
  const length = dist(from, target) * (1 + stream.gauss(0, velNoise * slack));
  return clampToPitch({ x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length });
}

const NOISE_BY_TYPE: Record<string, { dir: number; vel: number; skill: (a: AgentSnapshot) => number }> = {
  pass: { dir: AGENT_CAL.passDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: (a) => a.attributes.passing },
  longPass: { dir: AGENT_CAL.longPassDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: (a) => a.attributes.longPassing },
  cross: { dir: AGENT_CAL.crossDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: (a) => a.attributes.crossing },
  shot: { dir: AGENT_CAL.shotDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: (a) => a.attributes.finishing },
  clear: { dir: AGENT_CAL.longPassDirectionNoiseRad, vel: AGENT_CAL.passVelocityNoise, skill: (a) => a.attributes.longPassing },
  carry: { dir: 0.08, vel: 0.05, skill: (a) => a.attributes.dribbling },
};

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** attribute logit term: maps 1–20 onto ≈ [−1, 1] around 10 */
const skillEdge = (attr: number): number => (attr / 20 - 0.5) * 2;

/** effective pressure after composure attenuation (execution side) */
const feltPressure = (p: AgentSnapshot, pressure: number): number =>
  pressure * Math.max(0, 1 - AGENT_CAL.execComposureRelief * p.attributes.composure);

/** defender's arrival at a point, shaved by anticipation */
function defenderArrival(o: AgentSnapshot, p: Vec2): number {
  return arrivalTime(o, p.x, p.y) - AGENT_CAL.anticipationRaceS * (o.attributes.anticipation - 10);
}

// ── model implementation ──────────────────────────────────────────────────────

export class NoisyExecutionModel implements ExecutionModel {
  execute(action: ActionOption, ctx: ExecContext, rng: KeyedRng, tick: number): ExecutionOutcome {
    const actor = ctx.actor;
    if (action.type === 'hold') {
      return { action, success: true, endPoint: actor.pos, flight: 'ground' };
    }
    const profile = NOISE_BY_TYPE[action.type] ?? NOISE_BY_TYPE.pass;
    const endPoint = applyNoise(
      actor.pos, action.target, profile.skill(actor), profile.dir, profile.vel,
      rng, tick, actor.id, 'exec', action.type,
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
          AGENT_CAL.gkXgWeight * (xgProxy(actor.pos, ctx.attackingGoalX) - 0.1) -
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

    // pass family: technical completion × interception race on the real path
    const d = dist(actor.pos, endPoint);
    const pTechnical = sigmoid(
      AGENT_CAL.passExecBaseLogit +
      AGENT_CAL.passExecSkillLogit * skillEdge(profile.skill(actor)) -
      AGENT_CAL.passExecPressureLogit * feltPressure(actor, ctx.pressure),
    );

    let pSafe: number; // P(no defender takes it en route / at arrival)
    if (action.flight === 'ground' || action.flight === 'driven') {
      const speed = AGENT_CAL.groundPassSpeedMps;
      pSafe = 1;
      for (const f of [0.35, 0.65, 0.95]) {
        const node = { x: actor.pos.x + (endPoint.x - actor.pos.x) * f, y: actor.pos.y + (endPoint.y - actor.pos.y) * f };
        const tBall = (d * f) / speed;
        let tDef = Infinity;
        for (const o of ctx.opponents) {
          const t = defenderArrival(o, node);
          if (t < tDef) tDef = t;
        }
        const margin = tDef - tBall; // positive: ball beats the defender
        // same convention as the lofted branch: the defender only gets even
        // odds when he beats the ball by the offset (σ at margin = −offset)
        pSafe *= sigmoid(AGENT_CAL.raceSteepness * (margin + AGENT_CAL.interceptOffsetS));
      }
    } else {
      // lofted/high: mid-flight is unplayable; the race is at the drop point,
      // receiver vs best-placed defender. Losing it = contested → aerial duel.
      const tBall = d / AGENT_CAL.loftedPassSpeedMps;
      let tDef = Infinity;
      for (const o of ctx.opponents) {
        const t = defenderArrival(o, endPoint);
        if (t < tDef) tDef = t;
      }
      const tRecv = ctx.receiver
        ? arrivalTime(ctx.receiver, endPoint.x, endPoint.y)
        : tBall + 0.8; // clear: nobody is timed onto it
      const margin = tDef - Math.max(tBall, tRecv);
      pSafe = sigmoid(AGENT_CAL.raceSteepness * (margin + AGENT_CAL.interceptOffsetS));
    }

    const success = rng.chance(pTechnical * pSafe, tick, actor.id, 'outcome', action.type);
    return { action, success, endPoint, flight: action.flight };
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
      return (
        AGENT_CAL.aerialJumpingWeight * c.attributes.jumping +
        AGENT_CAL.aerialHeadingWeight * c.attributes.heading +
        AGENT_CAL.aerialStrengthWeight * c.attributes.strength +
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
