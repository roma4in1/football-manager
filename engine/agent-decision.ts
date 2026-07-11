/**
 * agent-decision.ts — what the carrier tries to do.
 *
 * Pipeline per the frozen invariants (engine-types.ts): option GENERATION is
 * geometric (vision widens the candidate set); ATTRIBUTES weight the scoring
 * (decisions/composure set the softmax temperature); INSTRUCTIONS bias
 * scoring only; execution noise lives in the execution model, never here.
 *
 * Scoring is REAL: every ball-moving option is scored
 *   P(complete) · PV(target) − κ · (1 − P(complete)) · PV_opp(target)   [expected-goals units]
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
  possessionValue,
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

/**
 * Lower temperature = sharper choices. Composure attenuates pressure's noise.
 * Match-rust adds noise on the SAME channel decisions relieve — full-unsharp
 * costs ≈ 3 decisions points (medium, per the sharpness spec), never touching
 * execution noise (that stays attribute-driven).
 */
export function temperatureFor(ctx: DecisionContext): number {
  const decisionsRelief = AGENT_CAL.temperaturePerDecisionsPoint * (ctx.carrier.attributes.decisions - 10);
  const pressureNoise = AGENT_CAL.pressureTemperatureGain * ctx.pressure * (1 - AGENT_CAL.composurePressureRelief * ctx.carrier.attributes.composure);
  const rustNoise = AGENT_CAL.sharpnessTemperaturePenalty * (1 - ctx.carrier.sharpness);
  return Math.max(AGENT_CAL.temperatureFloor, AGENT_CAL.softmaxBaseTemperature - decisionsRelief + pressureNoise + rustNoise);
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

    // passers don't play teammates who LOOK offside — judgement is strict
    // (at/behind the line), so same-tick geometry can't flag a chosen
    // receiver; offsides come from the mistimed-run draw at the kick
    // (agent-engine.ts) instead.
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

    // ambitious ground candidates: the most ADVANCED onside mates within
    // ground range, regardless of proximity. These are the risky ground
    // passes the risk slider promotes — without them the risky ground pool
    // was 2 through balls and riskAppetite couldn't dent completion.
    const candidateIds = new Set(mates.map((m) => m.id));
    const ambitious = [...ctx.teammates]
      .filter((t) => t.id !== ctx.carrier.id && !candidateIds.has(t.id) && looksOnside(t.pos) &&
        dist(t.pos, ctx.carrier.pos) <= AGENT_CAL.passRangeM)
      .sort((a, b) => (b.pos.x - a.pos.x) * attackSign)
      .slice(0, AGENT_CAL.ambitiousOptionCount);
    for (const mate of ambitious) {
      options.push({
        type: 'pass',
        target: { x: clampX(mate.pos.x + AGENT_CAL.leadPassM * attackSign), y: mate.pos.y },
        flight: 'ground',
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

  /**
   * EV scoring (the 2026-09 rebuild): every option is valued in EXPECTED
   * GOALS this possession chain — the one currency where a shot's xG and a
   * pass target's possession value are directly comparable, so shoot-vs-
   * pass falls out of the units instead of a fitted constant. Instructions
   * BIAS these values (small, centered — 0.5 is a strict no-op); attributes
   * keep driving completion probabilities and execution noise (frozen
   * invariant). The noise-fitted cardinals this replaces were falsified by
   * the four-point temperature bracket (DECISIONS 2026-08-31).
   */
  scoreOptions(ctx: DecisionContext, options: ActionOption[]): ScoredOption[] {
    const goalX = ctx.attackingGoal.x;
    const oppGoalX = PITCH_LENGTH - goalX;
    // pitch control is stored as HOME share — flip for away
    const ourControl = (p: Vec2): number =>
      ctx.side === 'home' ? ctx.pitchControl.controlAtPoint(p) : 1 - ctx.pitchControl.controlAtPoint(p);
    // κ: how much conceding possession THERE is feared, relative to true EV.
    // Risk appetite + score state discount it (scoring only): a chasing team
    // stops protecting the ball, a leading team protects it harder.
    const kTurnover = Math.max(0.1, AGENT_CAL.turnoverCostWeight *
      (1 - AGENT_CAL.riskTurnoverDiscount * (ctx.instructions.riskAppetite - 0.5) * 2 -
        AGENT_CAL.stateRiskTurnoverDiscount * ctx.scoreState));
    /** our PV of having the ball at p, nudged by who controls the space */
    const pvOurs = (p: Vec2): number =>
      possessionValue(p, goalX) + AGENT_CAL.valueControlWeight * (ourControl(p) - 0.5);
    /** THEIR PV if they take over at p — static surface + counter premium
     * (a turnover where WE are committed forward launches their transition) */
    const pvTheirs = (p: Vec2): number => {
      const ourProgress = (goalX === 0 ? PITCH_LENGTH - p.x : p.x) / PITCH_LENGTH;
      return possessionValue(p, oppGoalX) + AGENT_CAL.counterPremium * ourProgress;
    };
    /** EV of a completion gamble: keep-and-be-there vs lose-it-there */
    const gambleEv = (pComplete: number, at: Vec2): number =>
      pComplete * pvOurs(at) - kTurnover * (1 - pComplete) * pvTheirs(at);
    const centered = (bias: number, instr: number): number => bias * (instr - 0.5) * 2;

    return options.map((option) => {
      const t = option.target;
      let score: number;

      switch (option.type) {
        case 'hold': {
          // holding is a small dispossession gamble that creates no value
          const r = Math.min(0.9, AGENT_CAL.holdRiskBase + AGENT_CAL.holdRiskPressureGain * ctx.pressure);
          score = (1 - r) * AGENT_CAL.holdDecay * pvOurs(ctx.carrier.pos) -
            r * kTurnover * pvTheirs(ctx.carrier.pos) +
            centered(AGENT_CAL.holdPositionScoreBias, ctx.instructions.holdPosition) -
            AGENT_CAL.tempoHoldPenaltyEv * ctx.team.tempo -
            AGENT_CAL.stateHoldBias * ctx.scoreState; // leading: hold; chasing: move it
          break;
        }
        case 'shot': {
          // a shot IS its xG (the miss leaves the opponent restarting deep —
          // negligible on this scale). A clear chance beats a square pass by
          // construction: xG 0.3 vs P·PV(edge of box) ≈ 0.1.
          score = xgProxy(ctx.carrier.pos, goalX) +
            centered(AGENT_CAL.shootingBiasScoreBias, ctx.instructions.shootingBias) +
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
          score = gambleEv(p, t) + centered(AGENT_CAL.dribbleBiasScoreBias, ctx.instructions.dribbleBias);
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
          if (option.type === 'clear') {
            // a clearance is a contested giveaway that buys OUT of the
            // pressure-scaled danger of losing it right here
            score = AGENT_CAL.clearKeepShare * pvOurs(t) -
              (1 - AGENT_CAL.clearKeepShare) * kTurnover * pvTheirs(t) +
              AGENT_CAL.clearEscapeGain * ctx.pressure * pvTheirs(ctx.carrier.pos);
            break;
          }
          score = gambleEv(p, t);
          if (option.type === 'longPass' || option.type === 'cross') {
            score += centered(AGENT_CAL.riskAppetiteScoreBias, ctx.instructions.riskAppetite);
          }
          if (option.type === 'cross') {
            score += centered(AGENT_CAL.crossBiasScoreBias, ctx.instructions.crossBias);
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
