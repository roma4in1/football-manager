/**
 * agent-decision.ts — what the carrier tries to do.
 *
 * Pipeline per the frozen invariants (engine-types.ts): option GENERATION is
 * geometric (vision widens the candidate set); ATTRIBUTES weight the scoring
 * (decisions/composure set the softmax temperature); INSTRUCTIONS bias
 * scoring only; execution noise lives in the execution model, never here.
 *
 * Scoring is REAL: every ball-moving option is scored
 *   P(complete) · V(target) − turnoverCost · (1 − P(complete)) · V_opp(target)
 * where V reads the shared pitch-control field plus an xT-style
 * position-value proxy (agent-model), and P(complete) is a logistic over
 * distance, passing-lane risk (nearest opponent to the lane), control at the
 * target, and the relevant technical attribute. Shots score from the shared
 * xgProxy. Instruction biases are additive score terms — never execution.
 */

import type { BallFlight, PlayerInstructions, TeamInstructions, Vec2 } from './engine-types.ts';
import {
  AGENT_CAL,
  dist,
  PITCH_LENGTH,
  PITCH_WIDTH,
  positionValue,
  xgProxy,
  type AgentSnapshot,
  type Side,
} from './agent-model.ts';
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
  /** pressure on the carrier in [0,1] — nearest-opponent proximity */
  pressure: number;
  /** score-state urgency: positive = chasing (open up), negative = seeing it out */
  scoreState: number;
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

// ── geometry helpers ─────────────────────────────────────────────────────────

const clampX = (x: number): number => Math.min(PITCH_LENGTH, Math.max(0, x));
const clampY = (y: number): number => Math.min(PITCH_WIDTH, Math.max(0, y));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** How exposed the carrier→target lane is: 1 = an opponent sits on it, 0 = clear. */
function laneRisk(from: Vec2, to: Vec2, opponents: AgentSnapshot[]): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return 0;
  let worst = 0;
  for (const o of opponents) {
    // project the opponent onto the segment, only mid-lane bodies threaten
    const t = ((o.pos.x - from.x) * dx + (o.pos.y - from.y) * dy) / len2;
    if (t < 0.1 || t > 0.95) continue;
    const px = from.x + t * dx;
    const py = from.y + t * dy;
    const perp = Math.hypot(o.pos.x - px, o.pos.y - py);
    const risk = Math.max(0, 1 - perp / AGENT_CAL.laneRadiusM);
    if (risk > worst) worst = risk;
  }
  return worst;
}

// ── model implementation ─────────────────────────────────────────────────────

export class GeometricDecisionModel implements DecisionModel {
  generateOptions(ctx: DecisionContext): ActionOption[] {
    const options: ActionOption[] = [{ type: 'hold', target: ctx.carrier.pos, flight: 'ground' }];
    const goalX = ctx.attackingGoal.x;
    const attackSign = goalX > 0 ? 1 : -1;
    const ownRelX = goalX === 0 ? PITCH_LENGTH - ctx.carrier.pos.x : ctx.carrier.pos.x;
    const inFinalThird = ownRelX > AGENT_CAL.finalThirdX;
    const isWide = Math.abs(ctx.carrier.pos.y - PITCH_WIDTH / 2) > AGENT_CAL.crossWideYOffsetM;

    // passers don't play teammates standing clearly offside — they wait for
    // the runner to come back. The judgement band (passerLineJudgementM vs
    // the tighter flag tolerance) is where real offsides come from.
    const defXs = ctx.opponents.map((o) => o.pos.x).sort((a, b) => (goalX > 0 ? b - a : a - b));
    const offsideLine = defXs[1] ?? defXs[0] ?? goalX;
    const looksOnside = (p: Vec2): boolean =>
      goalX > 0
        ? p.x <= Math.max(offsideLine, PITCH_LENGTH / 2) + AGENT_CAL.passerLineJudgementM
        : p.x >= Math.min(offsideLine, PITCH_LENGTH / 2) - AGENT_CAL.passerLineJudgementM;

    // pass candidates: nearest mates, set widened by vision
    const nMates = Math.max(2, Math.round(AGENT_CAL.passOptionCount * (0.5 + 0.5 * (ctx.carrier.attributes.vision / 20))));
    const mates = [...ctx.teammates]
      .filter((t) => t.id !== ctx.carrier.id && looksOnside(t.pos))
      .sort((a, b) => dist(a.pos, ctx.carrier.pos) - dist(b.pos, ctx.carrier.pos))
      .slice(0, nMates);
    for (const mate of mates) {
      // lead the receiver toward goal — passes go into space, not to feet
      const target: Vec2 = { x: clampX(mate.pos.x + AGENT_CAL.leadPassM * attackSign), y: mate.pos.y };
      const far = dist(mate.pos, ctx.carrier.pos) > AGENT_CAL.passRangeM;
      const mateInBox = (goalX === 0 ? PITCH_LENGTH - mate.pos.x : mate.pos.x) > PITCH_LENGTH - 18 &&
        Math.abs(mate.pos.y - PITCH_WIDTH / 2) < 20;
      const isCross = inFinalThird && isWide && mateInBox;
      options.push({
        type: isCross ? 'cross' : far ? 'longPass' : 'pass',
        target,
        flight: isCross ? 'lofted' : far ? 'lofted' : 'ground',
        receiverId: mate.id,
      });
    }

    // through balls ON THE DECK: the most advanced mates, led hard into
    // space. Higher value, lower completion — risk/reward scoring decides.
    // Never lofted (that's what longPass switches are for), so out-of-range
    // targets are simply not options.
    const advanced = [...mates]
      .sort((a, b) => (b.pos.x - a.pos.x) * attackSign)
      .slice(0, AGENT_CAL.throughOptionCount);
    for (const mate of advanced) {
      const target: Vec2 = { x: clampX(mate.pos.x + AGENT_CAL.throughLeadM * attackSign), y: mate.pos.y };
      if (dist(ctx.carrier.pos, target) > AGENT_CAL.passRangeM) continue;
      options.push({ type: 'pass', target, flight: 'ground', receiverId: mate.id });
    }

    // carries: straight at goal plus two diagonals
    const carryAngles = [0, Math.PI / 5, -Math.PI / 5].slice(0, AGENT_CAL.carryOptionCount);
    for (const a of carryAngles) {
      options.push({
        type: 'carry',
        target: {
          x: clampX(ctx.carrier.pos.x + Math.cos(a) * AGENT_CAL.carryStepM * attackSign),
          y: clampY(ctx.carrier.pos.y + Math.sin(a) * AGENT_CAL.carryStepM),
        },
        flight: 'ground',
      });
    }

    if (dist(ctx.carrier.pos, ctx.attackingGoal) < AGENT_CAL.shotRangeM) {
      options.push({ type: 'shot', target: ctx.attackingGoal, flight: 'driven' });
    }

    // pressured deep in our own third: hoofing it is on the table
    if (ownRelX < AGENT_CAL.clearOwnRelXM && ctx.pressure > AGENT_CAL.clearPressureFloor) {
      options.push({
        type: 'clear',
        target: { x: clampX(ctx.carrier.pos.x + 45 * attackSign), y: ctx.carrier.pos.y > PITCH_WIDTH / 2 ? 55 : 13 },
        flight: 'lofted',
      });
    }
    return options;
  }

  scoreOptions(ctx: DecisionContext, options: ActionOption[]): ScoredOption[] {
    const goalX = ctx.attackingGoal.x;
    const oppGoalX = PITCH_LENGTH - goalX;
    // pitch control is stored as HOME share — flip for away
    const ourControl = (p: Vec2): number =>
      ctx.side === 'home' ? ctx.pitchControl.controlAtPoint(p) : 1 - ctx.pitchControl.controlAtPoint(p);
    // risk appetite + score state discount how much losing the ball is
    // feared (scoring only): a chasing team stops protecting the ball, a
    // leading team protects it harder
    const turnoverCost = Math.max(0.1, AGENT_CAL.turnoverCostWeight *
      (1 - AGENT_CAL.riskTurnoverDiscount * (ctx.instructions.riskAppetite - 0.5) * 2 -
        AGENT_CAL.stateRiskTurnoverDiscount * ctx.scoreState));
    // V(target): where would the ball be worth having, weighted by who'd have it
    const valueAt = (p: Vec2): number =>
      positionValue(p, goalX) + AGENT_CAL.valueControlWeight * (ourControl(p) - 0.5);

    return options.map((option) => {
      const t = option.target;
      let score: number;

      switch (option.type) {
        case 'hold': {
          score = AGENT_CAL.holdBaseScore +
            AGENT_CAL.holdPositionScoreBias * ctx.instructions.holdPosition -
            AGENT_CAL.holdPressurePenalty * ctx.pressure -
            AGENT_CAL.tempoHoldPenalty * ctx.team.tempo -
            AGENT_CAL.stateHoldBias * ctx.scoreState; // leading: hold; chasing: move it
          break;
        }
        case 'shot': {
          // negative base gates volume; the xg term keeps the quality gradient
          score = AGENT_CAL.shotBaseScore +
            AGENT_CAL.shotValueWeight * xgProxy(ctx.carrier.pos, goalX) +
            AGENT_CAL.shootingBiasScoreBias * ctx.instructions.shootingBias +
            AGENT_CAL.stateShotBias * Math.max(0, ctx.scoreState); // chasers shoot earlier
          break;
        }
        case 'carry': {
          const skill = ctx.carrier.attributes.dribbling / 20;
          const p = sigmoid(
            AGENT_CAL.carryBaseLogit +
            AGENT_CAL.passSkillLogit * (skill - 0.5) * 2 -
            AGENT_CAL.carryPressureLogit * ctx.pressure +
            AGENT_CAL.controlCompletionLogit * (ourControl(t) - 0.5),
          );
          score = p * valueAt(t) -
            turnoverCost * (1 - p) * positionValue(t, oppGoalX) +
            AGENT_CAL.dribbleBiasScoreBias * ctx.instructions.dribbleBias;
          break;
        }
        default: {
          // pass / longPass / cross / clear — the throw-catch family.
          // GK carriers estimate with gkDistribution (their outfield pass
          // attributes are seeded flat-low; execution reads the same source)
          const attr = ctx.carrier.isGk ? ctx.carrier.attributes.gkDistribution
            : option.type === 'pass' ? ctx.carrier.attributes.passing
            : option.type === 'cross' ? ctx.carrier.attributes.crossing
            : ctx.carrier.attributes.longPassing; // longPass + clear
          const d = dist(ctx.carrier.pos, t);
          const p = sigmoid(
            AGENT_CAL.passBaseLogit +
            AGENT_CAL.passSkillLogit * (attr / 20 - 0.5) * 2 -
            d / AGENT_CAL.passDistDecayM -
            AGENT_CAL.laneRiskLogit * laneRisk(ctx.carrier.pos, t, ctx.opponents) +
            AGENT_CAL.controlCompletionLogit * (ourControl(t) - 0.5),
          );
          score = p * valueAt(t) - turnoverCost * (1 - p) * positionValue(t, oppGoalX);
          if (option.type === 'longPass' || option.type === 'cross') {
            score += AGENT_CAL.riskAppetiteScoreBias * (ctx.instructions.riskAppetite - 0.5);
          }
          if (option.type === 'cross') {
            score += AGENT_CAL.crossBiasScoreBias * ctx.instructions.crossBias;
          }
          if (option.type === 'clear') {
            score = AGENT_CAL.clearBaseScore + AGENT_CAL.clearPressureGain * ctx.pressure;
          }
          break;
        }
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
