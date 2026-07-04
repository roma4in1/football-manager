/**
 * agent-execution.ts — what actually happens to the chosen action.
 *
 * Attribute-driven directional/velocity noise, applied AFTER the decision
 * (frozen invariant: instructions never touch execution). The ball-flight
 * enum is load-bearing: lofted/high deliveries route through aerial-duel
 * resolution (jumping/heading + height), ground/driven do not.
 *
 * SCAFFOLD: contracts + noise plumbing are real; success resolution is a
 * crude distance/skill logistic. Wednesday replaces resolvers with
 * interception geometry against the pitch-control field.
 */

import type { BallFlight, Vec2 } from './engine-types.ts';
import { AGENT_CAL, clampToPitch, dist, type AgentSnapshot } from './agent-model.ts';
import type { ActionOption } from './agent-decision.ts';
import type { KeyedRng } from './agent-rng.ts';

// ── contracts ─────────────────────────────────────────────────────────────────

export interface ExecutionOutcome {
  action: ActionOption;
  /** did the action come off as intended (pass arrives, shot on target…) */
  success: boolean;
  /** where the ball ends up (noise applied) */
  endPoint: Vec2;
  flight: BallFlight;
  /** set on shots: whether it beat the keeper (stub: folded into success) */
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
  execute(action: ActionOption, actor: AgentSnapshot, rng: KeyedRng, tick: number): ExecutionOutcome;
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

// ── stub implementation ───────────────────────────────────────────────────────

export class NoisyExecutionModel implements ExecutionModel {
  execute(action: ActionOption, actor: AgentSnapshot, rng: KeyedRng, tick: number): ExecutionOutcome {
    if (action.type === 'hold') {
      return { action, success: true, endPoint: actor.pos, flight: 'ground' };
    }
    const profile = NOISE_BY_TYPE[action.type] ?? NOISE_BY_TYPE.pass;
    const endPoint = applyNoise(
      actor.pos, action.target, profile.skill(actor), profile.dir, profile.vel,
      rng, tick, actor.id, 'exec', action.type,
    );
    // STUB success: skill-vs-distance logistic. Real resolver: interception
    // race along the ball path against the pitch-control field; shots go
    // through a keeper model (gkReflexes/gkPositioning vs placement).
    const difficulty = dist(actor.pos, action.target) / 40 + (action.type === 'shot' ? 0.6 : 0);
    const skillEdge = (profile.skill(actor) - 10) / 20;
    const pSuccess = 1 / (1 + Math.exp((difficulty - skillEdge - 0.5) * 4));
    const success = rng.chance(pSuccess, tick, actor.id, 'outcome', action.type);
    return {
      action,
      success,
      endPoint,
      flight: action.flight,
      ...(action.type === 'shot' ? { goal: success } : {}),
    };
  }

  resolveAerialDuel(contest: AerialContest, rng: KeyedRng, tick: number): AerialOutcome {
    // STUB: single weighted draw. Real resolver: pairwise timing + reach
    // (jumping, height) then contact quality (heading), losers may foul.
    const scores = contest.contestants.map((c) => {
      const height = contest.heightCmById.get(c.id) ?? 180;
      return (
        AGENT_CAL.aerialJumpingWeight * c.attributes.jumping +
        AGENT_CAL.aerialHeadingWeight * c.attributes.heading +
        AGENT_CAL.aerialHeightCmWeight * Math.max(0, height - 170) * 20 +
        rng.gauss(0, 2, tick, c.id, 'aerial')
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
