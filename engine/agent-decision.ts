/**
 * agent-decision.ts — what the carrier tries to do.
 *
 * Pipeline per the frozen invariants (engine-types.ts): option GENERATION is
 * geometric; ATTRIBUTES weight the scoring (vision widens the set, decisions/
 * composure set the softmax temperature); INSTRUCTIONS bias scoring only;
 * execution noise lives in the execution model, never here.
 *
 * SCAFFOLD: option types + softmax choice are real; geometric generation and
 * scoring are minimal stubs (safe pass / carry / hold; shot when deep in the
 * final third). Wednesday replaces the scorer with pitch-control-driven
 * expected-value terms.
 */

import type { BallFlight, PlayerInstructions, TeamInstructions, Vec2 } from './engine-types.ts';
import { AGENT_CAL, dist, PITCH_LENGTH, PITCH_WIDTH, type AgentSnapshot, type Side } from './agent-model.ts';
import type { PitchControlField } from './agent-positioning.ts';
import type { KeyedRng } from './agent-rng.ts';

// ── option types ──────────────────────────────────────────────────────────────

export type ActionType = 'pass' | 'longPass' | 'cross' | 'carry' | 'shot' | 'clear' | 'hold';

export interface ActionOption {
  type: ActionType;
  /** where the ball is aimed (pass target, carry waypoint, goal mouth…) */
  target: Vec2;
  flight: BallFlight;
  receiverId?: string;
}

export interface ScoredOption {
  option: ActionOption;
  /** pre-softmax utility; instruction biases are already folded in */
  score: number;
}

export interface DecisionContext {
  carrier: AgentSnapshot;
  teammates: AgentSnapshot[];
  opponents: AgentSnapshot[];
  pitchControl: PitchControlField;
  attackingGoal: Vec2; // GLOBAL frame
  side: Side;
  instructions: PlayerInstructions;
  team: TeamInstructions;
  /** pressure on the carrier in [0,1] — nearest-opponent proximity (stubbed by caller) */
  pressure: number;
}

export interface DecisionModel {
  generateOptions(ctx: DecisionContext): ActionOption[];
  scoreOptions(ctx: DecisionContext, options: ActionOption[]): ScoredOption[];
  /** softmax over scores; temperature from decisions/composure via AGENT_CAL */
  choose(scored: ScoredOption[], ctx: DecisionContext, rng: KeyedRng, tick: number): ActionOption;
}

/** Lower temperature = sharper choices. Composure attenuates pressure's noise. */
export function temperatureFor(ctx: DecisionContext): number {
  const decisionsRelief = AGENT_CAL.temperaturePerDecisionsPoint * (ctx.carrier.attributes.decisions - 10);
  const pressureNoise = ctx.pressure * (1 - AGENT_CAL.composurePressureRelief * ctx.carrier.attributes.composure);
  return Math.max(AGENT_CAL.temperatureFloor, AGENT_CAL.softmaxBaseTemperature - decisionsRelief + pressureNoise);
}

// ── stub implementation ───────────────────────────────────────────────────────

export class GeometricDecisionModel implements DecisionModel {
  generateOptions(ctx: DecisionContext): ActionOption[] {
    // STUB geometry: nearest teammates as pass targets, forward carry, hold,
    // shot when close to goal. Real generator: vision-scaled candidate count,
    // through-ball lanes from pitch control, switches (longPass), crosses
    // from wide final-third zones (crossBias handled in scoring).
    const options: ActionOption[] = [{ type: 'hold', target: ctx.carrier.pos, flight: 'ground' }];

    const mates = [...ctx.teammates]
      .filter((t) => t.id !== ctx.carrier.id)
      .sort((a, b) => dist(a.pos, ctx.carrier.pos) - dist(b.pos, ctx.carrier.pos))
      .slice(0, AGENT_CAL.passOptionCount);
    for (const mate of mates) {
      const far = dist(mate.pos, ctx.carrier.pos) > 30;
      options.push({
        type: far ? 'longPass' : 'pass',
        target: mate.pos,
        flight: far ? 'lofted' : 'ground',
        receiverId: mate.id,
      });
    }

    const towardGoal = Math.sign(ctx.attackingGoal.x - ctx.carrier.pos.x) || 1;
    options.push({
      type: 'carry',
      target: {
        x: Math.min(PITCH_LENGTH, Math.max(0, ctx.carrier.pos.x + 8 * towardGoal)),
        y: Math.min(PITCH_WIDTH, Math.max(0, ctx.carrier.pos.y)),
      },
      flight: 'ground',
    });

    if (dist(ctx.carrier.pos, ctx.attackingGoal) < 25) {
      options.push({ type: 'shot', target: ctx.attackingGoal, flight: 'driven' });
    }
    return options;
  }

  scoreOptions(ctx: DecisionContext, options: ActionOption[]): ScoredOption[] {
    // STUB scoring: progress toward goal + flat type priors, with the
    // instruction biases applied exactly where they belong (scoring only).
    // Real scorer: pitch-control value at target, turnover risk, xT-style
    // progression, receiver openness — attribute-weighted throughout.
    return options.map((option) => {
      const progress = (option.target.x - ctx.carrier.pos.x) * (ctx.side === 'home' ? 1 : -1) / PITCH_LENGTH;
      let score = progress;
      if (option.type === 'shot') score += AGENT_CAL.shootingBiasScoreBias * ctx.instructions.shootingBias;
      if (option.type === 'carry') score += 0.1 * ctx.instructions.dribbleBias;
      if (option.type === 'hold') score += AGENT_CAL.holdPositionScoreBias * ctx.instructions.holdPosition - 0.1;
      if (option.type === 'longPass' || option.type === 'cross') {
        score += AGENT_CAL.riskAppetiteScoreBias * (ctx.instructions.riskAppetite - 0.5);
      }
      return { option, score };
    });
  }

  choose(scored: ScoredOption[], ctx: DecisionContext, rng: KeyedRng, tick: number): ActionOption {
    const temperature = temperatureFor(ctx);
    const weights = scored.map((s) => Math.exp(s.score / temperature));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng.float(tick, ctx.carrier.id, 'decision') * total;
    for (let i = 0; i < scored.length; i++) {
      r -= weights[i];
      if (r < 0) return scored[i].option;
    }
    return scored[scored.length - 1].option;
  }
}
