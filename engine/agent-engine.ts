/**
 * agent-engine.ts — AgentEngine: pitch-control agent sim behind the SAME
 * frozen SimEngine interface as AggregateEngine (engine-types.ts). Swappable:
 * same signature, same HalfResult contracts, same frame cadence.
 *
 * All three injected sub-models (positioning / decision / execution) are
 * REAL (DECISIONS.md, agent-engine architecture), as are the event models
 * living here: fouls + the card ladder (second yellow sends off mid-half),
 * injuries (aggregate-hazard draw), offsides (second-last defender at the
 * kick), corners/free kicks/penalties (parameterized mini-resolutions
 * through the aerial-duel model), HT subs consumption, and the real stat
 * builders (sot/xg/ppda/fieldTilt from play, not stubs).
 *
 * Tick: perceive → position → decide (carrier) → execute → resolve ball →
 * detect events + phase transitions. All randomness is KEYED
 * (seed, tick, playerId, purpose) — never stream-ordered — so adding a
 * consumer never reshuffles existing draws (agent-rng.ts).
 */

import type {
  BallFlight,
  Fixture,
  HalfResult,
  HalfStats,
  HalfTimeState,
  MatchEvent,
  Phase,
  ReplayFrame,
  SimEngine,
  SquadPlayer,
  Tactics,
  Vec2,
} from './engine-types.ts';
import {
  AGENT_CAL,
  arrivalTime,
  clampToPitch,
  dist,
  PITCH_LENGTH,
  PITCH_WIDTH,
  shotQuality,
  xgProxy,
  type AgentSnapshot,
  type AgentState,
  type BallState,
  type Side,
  type TeamContext,
} from './agent-model.ts';
import { GeometricDecisionModel, type DecisionModel } from './agent-decision.ts';
import { NoisyExecutionModel, type ExecutionModel } from './agent-execution.ts';
import { AnchorPositioningModel, type PositioningModel } from './agent-positioning.ts';
import { KeyedRng } from './agent-rng.ts';

export const HALF_SECONDS = 2700;

const flip = (v: Vec2): Vec2 => ({ x: PITCH_LENGTH - v.x, y: PITCH_WIDTH - v.y });
const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── phase state machine (the 6 phases from engine-types) ────────────────────

/**
 * Per-side phase, driven by possession changes and ball position. Counter
 * windows (counterPress after losing the ball, counterAttack after winning
 * it) expire after AGENT_CAL.*Seconds; otherwise possession phases derive
 * from ball x in the possessing side's attacking frame, and the side out of
 * possession sits in defensiveBlock.
 */
export class PhaseTracker {
  private possession: Side;
  private sinceTurnoverS = Infinity;

  constructor(kickoffSide: Side) {
    this.possession = kickoffSide;
  }

  turnover(to: Side): void {
    if (to !== this.possession) {
      this.possession = to;
      this.sinceTurnoverS = 0;
    }
  }

  advance(dtSeconds: number): void {
    this.sinceTurnoverS += dtSeconds;
  }

  get inPossession(): Side {
    return this.possession;
  }

  phaseFor(side: Side, ballX: number): Phase {
    const counterWindow = side === this.possession ? AGENT_CAL.counterAttackSeconds : AGENT_CAL.counterPressSeconds;
    if (this.sinceTurnoverS < counterWindow) {
      return side === this.possession ? 'counterAttack' : 'counterPress';
    }
    if (side !== this.possession) return 'defensiveBlock';
    const attackingX = side === 'home' ? ballX : PITCH_LENGTH - ballX; // own-goal-relative
    if (attackingX < AGENT_CAL.buildUpX) return 'buildUp';
    if (attackingX < AGENT_CAL.finalThirdX) return 'progression';
    return 'finalThird';
  }
}

// ── engine ────────────────────────────────────────────────────────────────────

export interface AgentEngineModels {
  positioning?: PositioningModel;
  decision?: DecisionModel;
  execution?: ExecutionModel;
}

export class AgentEngine implements SimEngine {
  private readonly positioning: PositioningModel;
  private readonly decision: DecisionModel;
  private readonly execution: ExecutionModel;

  constructor(models: AgentEngineModels = {}) {
    this.positioning = models.positioning ?? new AnchorPositioningModel();
    this.decision = models.decision ?? new GeometricDecisionModel();
    this.execution = models.execution ?? new NoisyExecutionModel();
  }

  simulateHalf(
    fixture: Fixture,
    squads: { home: SquadPlayer[]; away: SquadPlayer[] },
    tactics: { home: Tactics; away: Tactics },
    seed: string,
  ): HalfResult {
    const resume = fixture.resumeState;
    if (fixture.half === 2 && !resume) throw new Error('half 2 requires resumeState');
    if (fixture.half === 1 && resume) throw new Error('half 1 must not carry resumeState');
    if (resume && (resume as { v?: unknown }).v !== 2) {
      throw new Error('unsupported HalfTimeState version: expected v=2 (no migration path — v1 blobs must not exist)');
    }

    // keyed randomness: half 1 mints the namespace, half 2 derives a child
    // from the token carried in resumeState.rngState — no stream to serialize
    const rng = fixture.half === 1
      ? new KeyedRng(`agent|${fixture.fixtureId}|${seed}`)
      : new KeyedRng(resume!.rngState).child('h2');
    const t0 = fixture.half === 1 ? 0 : HALF_SECONDS;

    const { states, inactive, homeCtx, awayCtx, heights, subsIn } = setup(squads, tactics, resume);
    const byId = new Map(states.map((s) => [s.id, s]));

    const tracker = new PhaseTracker(fixture.half === 1 ? 'home' : 'away'); // away kicks off h2
    const kickoffCarrier = nearestTo(states, tracker.inPossession, { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 });
    const ball: BallState = {
      pos: { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 },
      flight: 'ground',
      carrierId: kickoffCarrier?.id ?? null,
      lastTouchSide: tracker.inPossession,
      inFlight: null,
    };
    let flightSeq = 0; // per-half kick sequence — keys flight draws + event emission

    const events: MatchEvent[] = [{ t: t0, type: 'kickoff' }];
    const frames: ReplayFrame[] = [];
    const score: Record<Side, number> = { home: 0, away: 0 };
    const tallies = new Tallies(states.map((s) => s.id));
    const heat = new HeatAccumulator(states.map((s) => s.id));
    const possessionTicks: Record<Side, number> = { home: 0, away: 0 };

    const workOf = new Map<string, number>(); // per-tick share of max sprint, feeds fatigue
    let lastCarrierId: string | null = ball.carrierId; // challenge receive-grace tracking
    let carrierSinceTick = 0;

    // ── PROVENANCE INSTRUMENT (Phase 1 diagnosis — ball-flight/arrival) ──────
    // Per-possession-chain accounting, attached to shot events as meta. No rng
    // draws (keyed rng makes reads free anyway); measures how much of the
    // chance-creation pipeline rides the INSTANT-ARRIVAL artifact:
    //   passProgressM   ball x-progress delivered by completed passes
    //   carryProgressM  ball x-progress delivered by completed carries
    //   flightDebtS     sim-time a real ball flight would have consumed (Σ d/v)
    //   ghostRecv       completions whose receiver PHYSICALLY could not reach
    //                   the endpoint before the ball (arrivalTime > flight+0.3s)
    //   teleportM       total receiver displacement at completion (the warp)
    const chain = {
      side: tracker.inPossession as Side, startT: t0, passes: 0,
      passProgressM: 0, carryProgressM: 0, flightDebtS: 0, ghostRecv: 0, teleportM: 0,
      // assist/key-pass bookkeeping: who completed the pass to the current
      // carrier (same possession, no opponent touch in between)
      lastPasserId: null as string | null,
      lastPassReceiverId: null as string | null,
    };
    const chainReset = (side: Side, now: number): void => {
      chain.side = side; chain.startT = now; chain.passes = 0;
      chain.passProgressM = 0; chain.carryProgressM = 0; chain.flightDebtS = 0;
      chain.ghostRecv = 0; chain.teleportM = 0;
      chain.lastPasserId = null; chain.lastPassReceiverId = null;
    };
    const ticks = Math.floor(HALF_SECONDS / AGENT_CAL.tickSeconds);
    const framePeriod = Math.round(AGENT_CAL.frameEverySeconds / AGENT_CAL.tickSeconds);

    // real-stat counters (ppda, field tilt, xg)
    const buildupPasses: Record<Side, number> = { home: 0, away: 0 }; // ground passes attempted in own build-up
    const defActions: Record<Side, number> = { home: 0, away: 0 }; // tackles/interceptions/fouls in the opponent's build-up
    const tiltTicks: Record<Side, number> = { home: 0, away: 0 }; // ball in attacking third
    const xgSum: Record<Side, number> = { home: 0, away: 0 };

    const oppositeOf = (s: Side): Side => (s === 'home' ? 'away' : 'home');
    const ownRelX = (side: Side, x: number): number => (side === 'home' ? x : PITCH_LENGTH - x);
    const inBuildup = (side: Side, x: number): boolean => ownRelX(side, x) < AGENT_CAL.ppdaZoneOwnRelXM;
    const inAttackingBox = (side: Side, p: Vec2): boolean =>
      ownRelX(side, p.x) > PITCH_LENGTH - 16.5 && Math.abs(p.y - PITCH_WIDTH / 2) < 20.16;

    const sendOff = (p: AgentState): void => {
      p.sentOff = true; // fatigue freezes here; minutes stay half-granular (harness contract)
      if (ball.carrierId === p.id) ball.carrierId = null; // ball runs loose
    };

    /** Foul event + card ladder. Aggression scales every disciplinary roll. */
    const bookFoul = (fouler: AgentState, spot: Vec2, now: number, tick: number): void => {
      events.push({ t: now, type: 'foul', playerId: fouler.id, from: { ...spot } });
      if (inBuildup(oppositeOf(fouler.side), spot.x)) defActions[fouler.side]++;
      const aggro = 1 + AGENT_CAL.aggressionFoulGain * (fouler.attributes.aggression / 20 - 0.5);
      if (rng.chance(AGENT_CAL.redPerFoul * aggro, tick, fouler.id, 'red')) {
        events.push({ t: now + 0.05, type: 'card', playerId: fouler.id, meta: { card: 'red' } });
        sendOff(fouler);
      } else if (rng.chance(AGENT_CAL.yellowPerFoul * aggro, tick, fouler.id, 'yellow')) {
        events.push({ t: now + 0.05, type: 'card', playerId: fouler.id, meta: { card: 'yellow' } });
        if (fouler.yellows >= 1) {
          events.push({ t: now + 0.1, type: 'card', playerId: fouler.id, meta: { card: 'red' } });
          sendOff(fouler);
        } else {
          fouler.yellows = 1;
        }
      }
    };

    /**
     * Corner / free-kick mini-resolution through the aerial-duel model:
     * best set-piece taker delivers toward the spot, best aerial attacker
     * contests the best aerial defender; an attacking win becomes a headed
     * attempt whose goal probability IS its (header-discounted) xgProxy.
     */
    const resolveSetPieceDelivery = (side: Side, kind: 'corner' | 'freeKick', now: number, tick: number): void => {
      const goalX = side === 'home' ? PITCH_LENGTH : 0;
      const attackers = active(states).filter((s) => s.side === side && !s.isGk);
      const defenders = active(states).filter((s) => s.side !== side);
      if (attackers.length === 0 || defenders.length === 0) return;
      const taker = attackers.reduce((b, s) => (s.attributes.setPieceDelivery > b.attributes.setPieceDelivery ? s : b));
      const aerialScore = (s: AgentState): number => s.attributes.jumping + s.attributes.heading;
      const att = attackers.reduce((b, s) => (aerialScore(s) > aerialScore(b) ? s : b));
      const def = defenders.reduce((b, s) => (aerialScore(s) > aerialScore(b) ? s : b));
      const slack = (20 - taker.attributes.setPieceDelivery) / 20;
      const spot = clampToPitch({
        x: (side === 'home' ? PITCH_LENGTH - 11 : 11) + rng.gauss(0, 1 + AGENT_CAL.setPieceDeliveryNoiseM * slack, tick, taker.id, 'sp-x'),
        y: PITCH_WIDTH / 2 + rng.gauss(0, 2 + AGENT_CAL.setPieceDeliveryNoiseM * slack, tick, taker.id, 'sp-y'),
      });
      events.push({ t: now, type: kind === 'corner' ? 'cornerAwarded' : 'setPiece', playerId: taker.id, to: spot, flight: 'high' });
      const duel = this.execution.resolveAerialDuel(
        {
          ball: spot,
          contestants: [{ ...snapshotOf(att), pos: spot }, { ...snapshotOf(def), pos: { x: spot.x, y: spot.y + 0.5 } }],
          heightCmById: heights,
        },
        rng, tick,
      );
      tallies.aerial(duel.winnerId);
      if (duel.winnerId === att.id) {
        const xg = Math.min(0.4, xgProxy(spot, goalX) * AGENT_CAL.setPieceHeaderXgFactor);
        tallies.shot(att.id);
        xgSum[side] += xg;
        events.push({
          t: now + 0.1, type: 'shot', playerId: att.id, from: spot, flight: 'high',
          meta: { xg: Math.round(xg * 1000) / 1000, source: 'setPiece', header: 1 },
        });
        if (rng.chance(xg, tick, att.id, 'sp-goal')) {
          score[side]++;
          tallies.goal(att.id);
          tallies.sot(att.id);
          tallies.assist(taker.id); // the delivery IS the assist
          events.push({
            t: now + 0.2, type: 'goal', playerId: att.id, outcome: 'success',
            meta: { source: 'setPiece', header: 1, assistId: taker.id },
          });
          resetKickoff(ball, states, tracker, oppositeOf(side));
          return;
        }
        if (rng.chance(0.4, tick, att.id, 'sp-sot')) {
          tallies.sot(att.id);
          const gk = defenders.find((d) => d.isGk);
          if (gk) {
            tallies.save(gk.id);
            events.push({ t: now + 0.25, type: 'save', playerId: gk.id });
          }
        }
        giveToKeeper(ball, states, tracker, oppositeOf(side));
        return;
      }
      // defended: cleared, loose ball outside the box
      const clearPoint = clampToPitch({ x: spot.x + (side === 'home' ? -18 : 18), y: spot.y + rng.gauss(0, 8, tick, def.id, 'sp-clear') });
      const claimant = nearestAny(states, clearPoint);
      if (claimant) {
        ball.inFlight = null;
        ball.pos = { ...claimant.pos };
        ball.carrierId = claimant.id;
        ball.flight = 'ground';
        ball.lastTouchSide = claimant.side;
        tracker.turnover(claimant.side);
      }
    };

    /** Penalty: parameterized outcome, no open-play machinery. */
    const resolvePenalty = (side: Side, takerHint: AgentState, now: number, tick: number): void => {
      const attackers = active(states).filter((s) => s.side === side && !s.isGk);
      const taker = attackers.reduce(
        (b, s) => (s.attributes.finishing > b.attributes.finishing ? s : b),
        takerHint,
      );
      const spot: Vec2 = { x: side === 'home' ? PITCH_LENGTH - 11 : 11, y: PITCH_WIDTH / 2 };
      tallies.shot(taker.id);
      xgSum[side] += AGENT_CAL.penaltyGoalProb;
      events.push({
        t: now, type: 'shot', playerId: taker.id, from: spot, flight: 'driven',
        meta: { xg: AGENT_CAL.penaltyGoalProb, source: 'penalty' },
      });
      if (rng.chance(AGENT_CAL.penaltyGoalProb, tick, taker.id, 'pen')) {
        score[side]++;
        tallies.goal(taker.id);
        tallies.sot(taker.id);
        events.push({ t: now + 0.1, type: 'goal', playerId: taker.id, outcome: 'success', meta: { source: 'penalty' } });
        resetKickoff(ball, states, tracker, oppositeOf(side));
      } else {
        tallies.sot(taker.id); // saved: still on target more often than not
        const gk = active(states).find((s) => s.side !== side && s.isGk);
        if (gk) {
          tallies.save(gk.id);
          events.push({ t: now + 0.15, type: 'save', playerId: gk.id });
        }
        giveToKeeper(ball, states, tracker, oppositeOf(side));
      }
    };

    // score-state urgency: full-MATCH goal difference (resume carries h1's),
    // scaled by how late it is. Positive = chasing. Deterministic per tick.
    const priorScore = resume?.score ?? [0, 0];
    const scoreStateFor = (side: Side, now: number): number => {
      const diffHome = (priorScore[0] + score.home) - (priorScore[1] + score.away);
      const diff = side === 'home' ? diffHome : -diffHome;
      const matchFrac = now / (2 * HALF_SECONDS);
      const urgency = AGENT_CAL.stateUrgencyBase + AGENT_CAL.stateUrgencyTimeGain * matchFrac;
      // tempering (DECISIONS: equalization balance point): the mechanism
      // narrows scorelines, it must not erase quality gaps —
      // (1) extra goals of deficit add only stateGapTaper each: a 2+ goal
      //     underdog does not gegenpress back to parity as often;
      // (2) leaders keep stateLeadCautionShare of the see-it-out shift:
      //     a dominant side stays itself instead of parking and inviting.
      const gap = Math.abs(diff);
      const tapered = gap === 0 ? 0 : 1 + AGENT_CAL.stateGapTaper * (gap - 1);
      const raw = (diff < 0 ? 1 : -1) * tapered * urgency;
      const shaped = raw >= 0 ? raw : raw * AGENT_CAL.stateLeadCautionShare;
      // home teams play more expansively (2b: decision-level home term —
      // anchor/risk shift through the same channels as chasing, never a
      // completion-rate thumb)
      const home = side === 'home' ? AGENT_CAL.homeExpansiveness : 0;
      return Math.max(-AGENT_CAL.stateMax, Math.min(AGENT_CAL.stateMax, shaped + home));
    };

    // ── ball flight (Phase 1): the kicked ball is a real moving object ───────
    // Travel time elapses, receivers run onto arrival points, defenders
    // intercept WHERE THEIR BODIES MEET THE BALL. Replaces the instant-arrival
    // teleport (`receiver.pos = endPoint`) the provenance instrument convicted:
    // 98% of pre-shot chains rode physically-impossible receptions, attacks ran
    // 33% faster than the movement model allows (DECISIONS 2026-09-03 suspect).

    const lerpPoint = (a: Vec2, b: Vec2, t: number): Vec2 =>
      ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

    /** the slice of a flight the stats need after the ball itself is resolved */
    interface FlightRecord {
      kickerId: string; kickerSide: Side; actionType: string;
      flightEnum: BallFlight; from: Vec2; to: Vec2; kickT: number;
    }
    /** a flight that died in space: completion is judged at FIRST CONTROL —
     *  a receiver collecting the bounce half a second late still completed
     *  the pass; an opponent getting there first didn't. */
    // boxed: closure writes are invisible to TS narrowing (issue #9998)
    const pending = { flight: null as FlightRecord | null };

    const settleFlightStats = (f: FlightRecord, completed: boolean): void => {
      if (f.flightEnum === 'ground' || f.flightEnum === 'driven') {
        tallies.pass(f.kickerId, completed);
      } else if (f.actionType !== 'cross') {
        // long-ball metrics read these; crosses excluded (FBref-style)
        events.push({
          t: f.kickT, type: 'pass', playerId: f.kickerId,
          from: { ...f.from }, to: { ...f.to }, flight: f.flightEnum,
          outcome: completed ? 'success' : 'fail',
        });
      }
    };
    const finishFlightTally = (completed: boolean): void => {
      settleFlightStats(ball.inFlight!, completed);
    };

    /** a same-side body takes the ball cleanly at the end of a flight */
    const cleanReception = (receiver: AgentState, tick: number, now: number): void => {
      const f = ball.inFlight!;
      finishFlightTally(true);
      // provenance instrument: with real flight the receiver is HERE — the
      // teleport term measures residual snap (≤ receive radius by construction)
      if (receiver.side === f.kickerSide) {
        chain.passes++;
        chain.passProgressM += (ball.pos.x - f.from.x) * (f.kickerSide === 'home' ? 1 : -1);
        chain.flightDebtS += 0; // flight time is PAID now — it elapsed on the clock
        chain.teleportM += dist(receiver.pos, ball.pos);
        chain.lastPasserId = f.kickerId;
        chain.lastPassReceiverId = receiver.id;
      }
      ball.inFlight = null;
      ball.flight = 'ground';
      ball.carrierId = receiver.id;
      ball.pos = { ...receiver.pos };
      ball.lastTouchSide = receiver.side;
      tracker.turnover(receiver.side);

      // RECEPTION PRESSURE (the buildup-zone action supply, DECISIONS
      // 2026-09-02): a presser arriving on the touch forces an error draw —
      // defender bite vs receiver control. Unchanged mechanism, new moment.
      if (receiver.side === f.kickerSide && !receiver.isGk) {
        const presser = nearestTo(states, oppositeOf(receiver.side), receiver.pos);
        if (presser && dist(presser.pos, receiver.pos) <= AGENT_CAL.receptionPressRadiusM) {
          const trigger2 = (presser.side === 'home' ? homeCtx : awayCtx).tactics.team.pressTrigger;
          const attemptP = AGENT_CAL.receptionErrorBase *
            (0.5 + presser.instructions.pressingIntensity) * (0.5 + trigger2);
          if (rng.chance(attemptP, tick, receiver.id, 'reception-press')) {
            const bite = (presser.attributes.tackling + presser.attributes.aggression) / 2;
            const control = (receiver.attributes.firstTouch + receiver.attributes.composure) / 2;
            const winP = 1 / (1 + Math.exp(-AGENT_CAL.receptionDuelLogit * ((bite - control) / 20) * 2));
            if (rng.chance(winP, tick, presser.id, 'reception-win')) {
              // booked pressers pull out of 50/50s; nobody dives in inside
              // their own box (parity with the carry-tackle foul path)
              const foulShare = AGENT_CAL.receptionFoulShare *
                (presser.yellows ? AGENT_CAL.bookedCautionFactor : 1) *
                (inAttackingBox(receiver.side, receiver.pos) ? AGENT_CAL.boxFoulFactor : 1);
              if (rng.chance(foulShare, tick, presser.id, 'reception-foul')) {
                bookFoul(presser, receiver.pos, now + 0.1, tick);
                if (inAttackingBox(receiver.side, receiver.pos)) {
                  resolvePenalty(receiver.side, receiver, now + 0.2, tick);
                } else if (ownRelX(receiver.side, receiver.pos.x) > AGENT_CAL.finalThirdX) {
                  resolveSetPieceDelivery(receiver.side, 'freeKick', now + 0.2, tick);
                }
              } else {
                events.push({ t: now, type: 'tackle', playerId: presser.id, outcome: 'success', meta: { source: 'reception' } });
                if (inBuildup(receiver.side, receiver.pos.x)) defActions[presser.side]++;
                ball.pos = { ...presser.pos };
                ball.carrierId = presser.id;
                ball.lastTouchSide = presser.side;
                tracker.turnover(presser.side);
              }
            }
          }
        }
      }
    };

    /** an opponent meets the ball (mid-flight or at arrival): interception */
    const resolveInterception = (enemy: AgentState, at: Vec2, tick: number, now: number): void => {
      const f = ball.inFlight!;
      finishFlightTally(false);
      events.push({ t: now, type: 'interception', playerId: enemy.id });
      if (inBuildup(f.kickerSide, at.x)) defActions[enemy.side]++;
      ball.inFlight = null;
      ball.flight = 'ground';
      const pClean = Math.min(0.95, AGENT_CAL.interceptControlBase +
        AGENT_CAL.interceptControlGain * (enemy.attributes.firstTouch / 20));
      if (rng.chance(pClean, tick, enemy.id, 'intercept-control', f.flightId)) {
        ball.carrierId = enemy.id;
        ball.pos = { ...enemy.pos };
        ball.lastTouchSide = enemy.side;
        tracker.turnover(enemy.side);
      } else {
        // the ball squirts loose off the touch — a real second-ball moment
        ball.carrierId = null;
        ball.pos = clampToPitch({
          x: at.x + rng.gauss(0, AGENT_CAL.ballDeflectScatterM, tick, enemy.id, 'deflect-x', f.flightId),
          y: at.y + rng.gauss(0, AGENT_CAL.ballDeflectScatterM, tick, enemy.id, 'deflect-y', f.flightId),
        });
        ball.lastTouchSide = enemy.side;
      }
    };

    /** interception reach: anticipation reads the pass earlier → wider reach */
    const interceptReach = (p: AgentState): number =>
      AGENT_CAL.ballInterceptRadiusM *
      (1 - AGENT_CAL.ballInterceptAnticipationGain / 2 +
        AGENT_CAL.ballInterceptAnticipationGain * (p.attributes.anticipation / 20));

    /** the flight resolves at its endpoint: reception / arrival contest / loose */
    const resolveArrival = (tick: number, now: number): void => {
      const f = ball.inFlight!;
      ball.pos = { ...f.to };
      if (f.outOfBounds) {
        // the ball crossed the line: dead, thrown back in by the other side
        // (restart simplification — same family as giveToKeeper/resetKickoff)
        finishFlightTally(false);
        ball.inFlight = null;
        ball.flight = 'ground';
        const thrower = nearestTo(states, oppositeOf(f.kickerSide), f.to);
        if (thrower) {
          ball.carrierId = thrower.id;
          ball.pos = { ...thrower.pos };
          ball.lastTouchSide = thrower.side;
          tracker.turnover(thrower.side);
        } else {
          ball.carrierId = null;
        }
        return;
      }
      if (f.flightEnum === 'lofted' || f.flightEnum === 'high') {
        // drop-point contest: nearest body per side inside the contest radius
        const near = active(states)
          .filter((s) => dist(s.pos, f.to) <= AGENT_CAL.ballReceiveRadiusM + 1.0)
          .sort((a, b) => dist(a.pos, f.to) - dist(b.pos, f.to));
        const ours = near.find((s) => s.side === f.kickerSide);
        const theirs = near.find((s) => s.side !== f.kickerSide);
        if (ours && theirs) {
          // both arrived: the aerial duel decides the first touch
          const duel = this.execution.resolveAerialDuel(
            { ball: f.to, contestants: [snapshotOf(ours), snapshotOf(theirs)], heightCmById: heights },
            rng, tick,
          );
          tallies.aerial(duel.winnerId);
          const winner = byId.get(duel.winnerId)!;
          const loser = winner.id === ours.id ? theirs : ours;
          if (rng.chance(AGENT_CAL.aerialFoulRate, tick, loser.id, 'foul')) {
            bookFoul(loser, f.to, now + 0.1, tick);
          }
          finishFlightTally(winner.side === f.kickerSide);
          ball.inFlight = null;
          ball.flight = 'ground';
          ball.lastTouchSide = winner.side;
          if (dist(duel.endPoint, winner.pos) <= AGENT_CAL.ballReceiveRadiusM) {
            ball.carrierId = winner.id;
            ball.pos = { ...winner.pos };
            tracker.turnover(winner.side);
          } else {
            // headed on/away: a loose second ball — players converge on it
            ball.carrierId = null;
            ball.pos = { ...duel.endPoint };
          }
          return;
        }
        const alone = ours ?? theirs;
        if (!alone) {
          pending.flight = { ...f }; // dies in space — completion judged at first control
          ball.inFlight = null;
          ball.flight = 'ground';
          ball.carrierId = null;
          return;
        }
        if (alone.side === f.kickerSide) cleanReception(alone, tick, now);
        else resolveInterception(alone, f.to, tick, now);
        return;
      }
      // ground/driven arrival: the CLOSEST body to the drop wins the ball —
      // a marker tighter than his man picks off the pass into feet (ties and
      // near-ties go to the intended receiver: it's his ball to shield)
      const recv = f.receiverId ? byId.get(f.receiverId) : undefined;
      const recvD = recv && !recv.sentOff ? dist(recv.pos, f.to) : Infinity;
      const claimant = nearestAny(states, f.to);
      const claimD = claimant ? dist(claimant.pos, f.to) : Infinity;
      if (recvD <= AGENT_CAL.ballReceiveRadiusM && recvD <= claimD + 0.4) {
        cleanReception(recv!, tick, now);
        return;
      }
      if (claimant && claimD <= AGENT_CAL.ballReceiveRadiusM) {
        if (claimant.side === f.kickerSide) cleanReception(claimant, tick, now);
        else resolveInterception(claimant, f.to, tick, now);
        return;
      }
      // nobody made it: the ball runs dead — completion judged at first control
      pending.flight = { ...f };
      ball.inFlight = null;
      ball.flight = 'ground';
      ball.carrierId = null;
    };

    /** one tick of ball travel; ground balls are interceptable EN ROUTE */
    const advanceFlight = (tick: number, now: number): void => {
      const f = ball.inFlight!;
      const total = Math.max(0.1, dist(f.from, f.to));
      const step = Math.min(f.speedMps * AGENT_CAL.tickSeconds, total - f.travelledM);
      if (f.flightEnum === 'ground' || f.flightEnum === 'driven') {
        // sub-sample the path so a 7m/tick ball cannot skip past a defender
        const recv = f.receiverId ? byId.get(f.receiverId) : undefined;
        const subs = Math.max(1, Math.ceil(step / 1.0));
        for (let k = 1; k <= subs; k++) {
          const at = lerpPoint(f.from, f.to, (f.travelledM + (step * k) / subs) / total);
          for (const s of active(states)) {
            if (s.side === f.kickerSide || f.attempted.has(s.id)) continue;
            const reach = interceptReach(s);
            const d = dist(s.pos, at);
            if (d > reach) continue;
            // in reach = an ATTEMPT, not a take: full odds only on dead-center
            // contact; one try per defender per flight (no second bites)
            f.attempted.add(s.id);
            const pTake = AGENT_CAL.ballInterceptTakeBase * (1 - d / reach);
            if (rng.chance(pTake, tick, s.id, 'intercept-take', f.flightId)) {
              ball.pos = at;
              resolveInterception(s, at, tick, now);
              return;
            }
          }
          // the intended receiver MEETS the ball en route — a ground pass is
          // received at the body wherever he gets to it, not at a theoretical
          // endpoint (receivers come toward the ball; this is most of why the
          // ball lives at feet in real football)
          if (recv && !recv.sentOff && dist(recv.pos, at) <= AGENT_CAL.ballReceiveRadiusM) {
            ball.pos = at;
            cleanReception(recv, tick, now);
            return;
          }
        }
      }
      f.travelledM += step;
      ball.pos = lerpPoint(f.from, f.to, f.travelledM / total);
      if (f.travelledM >= total - 1e-6) resolveArrival(tick, now);
    };

    for (let tick = 0; tick < ticks; tick++) {
      const now = t0 + tick * AGENT_CAL.tickSeconds;
      tracker.advance(AGENT_CAL.tickSeconds);
      if (tracker.inPossession !== chain.side) chainReset(tracker.inPossession, now); // provenance instrument
      possessionTicks[tracker.inPossession]++;
      if (ball.pos.x > AGENT_CAL.finalThirdX) tiltTicks.home++;
      else if (ball.pos.x < PITCH_LENGTH - AGENT_CAL.finalThirdX) tiltTicks.away++;

      // ── perceive: shared substrate for both teams
      const homeSnaps = snapshots(states, 'home');
      const awaySnaps = snapshots(states, 'away');
      const control = this.positioning.computePitchControl(homeSnaps, awaySnaps, ball);

      // ── position: targets per side, then move everyone one step
      for (const [side, snaps, opps, ctx] of [
        ['home', homeSnaps, awaySnaps, homeCtx],
        ['away', awaySnaps, homeSnaps, awayCtx],
      ] as Array<[Side, AgentSnapshot[], AgentSnapshot[], TeamContext]>) {
        const targets = this.positioning.targetsFor({
          phase: tracker.phaseFor(side, ball.pos.x),
          ball,
          possession: tracker.inPossession,
          team: ctx,
          teammates: snaps,
          opponents: opps,
          anchors: anchorsOf(states, side),
          scoreState: scoreStateFor(side, now),
        });
        for (const s of states) {
          if (s.side !== side || s.sentOff) continue;
          // a pass's intended receiver runs to MEET the ball — he attacks the
          // point the ball will shortly reach (ground balls are received at
          // the body en route), falling back to the endpoint for high balls
          let target = targets.get(s.id) ?? s.pos;
          const fl = ball.inFlight;
          if (fl?.receiverId === s.id) {
            const atkSign = s.side === 'home' ? 1 : -1;
            const intoSpace = (fl.to.x - s.pos.x) * atkSign > 1; // led goalward of him
            if (!intoSpace && (fl.flightEnum === 'ground' || fl.flightEnum === 'driven')) {
              // a ball to feet is MET — attack the point it will shortly reach
              const total = Math.max(0.1, dist(fl.from, fl.to));
              const aheadM = Math.min(total, fl.travelledM + fl.speedMps * 0.6);
              target = lerpPoint(fl.from, fl.to, aheadM / total);
            } else {
              // a ball into space is RUN ONTO — keep attacking the endpoint
              target = fl.to;
            }
          }
          const moved = stepToward(s, target);
          const maxStep = AGENT_CAL.maxSpeedMps * AGENT_CAL.tickSeconds;
          workOf.set(s.id, moved / maxStep);
        }
      }

      // ── ball in flight: travel, interception races, arrival ───────────────
      if (ball.inFlight) advanceFlight(tick, now);

      // ── pressing challenge (Phase B): a defender in touching distance may
      // engage the carrier BEFORE he gets his next decision — an attribute
      // duel whose frequency rides pressingIntensity + pressTrigger. This is
      // the mechanism behind press↑ → turnovers/ppda↓/fouls (a knob couldn't
      // produce it: DECISIONS 2026-08-31). Keyed draws — no stream reshuffle.
      // possession grace: you can't be dispossessed the instant you receive —
      // this is what breaks strip-cycles (win ball → instantly stripped back)
      if (ball.carrierId !== lastCarrierId) {
        lastCarrierId = ball.carrierId;
        carrierSinceTick = tick;
      }
      {
        const holder = ball.carrierId ? byId.get(ball.carrierId) : undefined;
        // KEEPER CLAIM: a carrier inside the keeper's area gets smothered —
        // the goalmouth is not dribble-through-able (rational play found the
        // byline exploit; this is the physics that stops it)
        if (holder && !holder.sentOff && !holder.isGk && ball.flight === 'ground') {
          const goalCenter = { x: holder.side === 'home' ? PITCH_LENGTH : 0, y: PITCH_WIDTH / 2 };
          if (dist(holder.pos, goalCenter) <= AGENT_CAL.keeperClaimRadiusM) {
            const gk = active(states).find((s2) => s2.side !== holder.side && s2.isGk);
            if (gk) {
              const claimP = AGENT_CAL.keeperClaimBase * (0.5 + gk.attributes.gkPositioning / 20);
              if (rng.chance(claimP, tick, gk.id, 'keeper-claim')) {
                giveToKeeper(ball, states, tracker, gk.side);
              }
            }
          }
        }
        // keepers are never challenged (they pick it up); receive grace 2 ticks
        if (holder && !holder.sentOff && !holder.isGk && ball.flight === 'ground' &&
            ball.carrierId === holder.id &&
            tick - carrierSinceTick >= AGENT_CAL.challengeGraceTicks) {
          const challenger = nearestTo(states, oppositeOf(holder.side), holder.pos);
          if (challenger && dist(challenger.pos, holder.pos) <= AGENT_CAL.challengeRadiusM) {
            const trigger = (challenger.side === 'home' ? homeCtx : awayCtx).tactics.team.pressTrigger;
            const attemptP = AGENT_CAL.challengeAttemptBase *
              (0.5 + challenger.instructions.pressingIntensity) * (0.5 + trigger);
            if (rng.chance(attemptP, tick, challenger.id, 'challenge')) {
              const duelSkill = (challenger.attributes.tackling + challenger.attributes.anticipation) / 2;
              const keepSkill = (holder.attributes.dribbling + holder.attributes.composure) / 2;
              const winP = 1 / (1 + Math.exp(-AGENT_CAL.challengeDuelLogit * ((duelSkill - keepSkill) / 20) * 2));
              if (rng.chance(winP, tick, challenger.id, 'challenge-win')) {
                events.push({ t: now, type: 'tackle', playerId: challenger.id, outcome: 'success' });
                if (inBuildup(holder.side, holder.pos.x)) defActions[challenger.side]++;
                ball.pos = { ...challenger.pos };
                ball.carrierId = challenger.id;
                ball.lastTouchSide = challenger.side;
                tracker.turnover(challenger.side);
              } else if (rng.chance(
                AGENT_CAL.challengeFoulShare * (challenger.yellows ? AGENT_CAL.bookedCautionFactor : 1) *
                  (inAttackingBox(holder.side, holder.pos) ? AGENT_CAL.boxFoulFactor : 1),
                tick, challenger.id, 'challenge-foul')) {
                bookFoul(challenger, holder.pos, now, tick);
                if (inAttackingBox(holder.side, holder.pos)) {
                  resolvePenalty(holder.side, holder, now + 0.2, tick);
                } else if (ownRelX(holder.side, holder.pos.x) > AGENT_CAL.finalThirdX) {
                  resolveSetPieceDelivery(holder.side, 'freeKick', now + 0.2, tick);
                }
              }
            }
          }
        }
      }

      // ── decide + execute (carrier only, at the decision cadence)
      const carrier = ball.carrierId ? byId.get(ball.carrierId) : undefined;
      if (carrier && tick % AGENT_CAL.decisionEveryTicks === 0) {
        const side = carrier.side;
        const mates = side === 'home' ? homeSnaps : awaySnaps;
        const opps = side === 'home' ? awaySnaps : homeSnaps;
        // two nearest opponents: a double-team squeezes harder than one man
        let d1 = Infinity, d2 = Infinity;
        for (const o of opps) {
          const d = dist(o.pos, carrier.pos);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        const rawPressure = Math.min(1,
          Math.max(0, 1 - d1 / 10) + AGENT_CAL.pressureSecondWeight * Math.max(0, 1 - d2 / 10));
        const ctx = {
          carrier: snapshotOf(carrier),
          teammates: mates,
          opponents: opps,
          pitchControl: control,
          attackingGoal: side === 'home' ? { x: PITCH_LENGTH, y: PITCH_WIDTH / 2 } : { x: 0, y: PITCH_WIDTH / 2 },
          side,
          instructions: carrier.instructions,
          team: (side === 'home' ? homeCtx : awayCtx).tactics.team,
          // crowd effect: the ONE home-advantage mechanism (context, not
          // noise) — zeroed at a neutral venue (the playoff final)
          pressure: side === 'home' && fixture.neutralVenue !== true
            ? rawPressure * (1 - AGENT_CAL.homePressureRelief)
            : rawPressure,
          scoreState: scoreStateFor(side, now),
        };
        const options = this.decision.generateOptions(ctx);
        const chosen = this.decision.choose(this.decision.scoreOptions(ctx, options), ctx, rng, tick);

        // offside: flagged at the moment of the kick, before the ball moves
        const passReceiver = chosen.receiverId ? mates.find((m) => m.id === chosen.receiverId) : undefined;
        if (passReceiver && (chosen.type === 'pass' || chosen.type === 'longPass' || chosen.type === 'cross')) {
          const defXs = opps.map((o) => o.pos.x).sort((a, b) => (side === 'home' ? b - a : a - b));
          const line = defXs[1] ?? defXs[0] ?? (side === 'home' ? PITCH_LENGTH : 0);
          const beyondLine = side === 'home'
            ? passReceiver.pos.x > line + AGENT_CAL.offsideToleranceM
            : passReceiver.pos.x < line - AGENT_CAL.offsideToleranceM;
          const beyondBall = side === 'home' ? passReceiver.pos.x > ball.pos.x : passReceiver.pos.x < ball.pos.x;
          const inOppHalf = ownRelX(side, passReceiver.pos.x) > PITCH_LENGTH / 2;
          // the offside MODEL (DECISIONS 2026-08-30): passers no longer pick
          // visibly-offside receivers (strict judgement in agent-decision), so
          // the geometric flag is a backstop; offsides come from MISTIMED
          // RUNS — a line-riding receiver of a forward pass strays on a keyed
          // draw, less often the better their off-the-ball movement
          const ridingLine = side === 'home'
            ? passReceiver.pos.x > line - AGENT_CAL.offsideRideZoneM
            : passReceiver.pos.x < line + AGENT_CAL.offsideRideZoneM;
          const timing = 1 - AGENT_CAL.offsideTimingSkill * (passReceiver.attributes.offTheBall / 20 - 0.5) * 2;
          // the TRAP: a higher defensive line squeezes the timing window —
          // this is what makes lineHeight↑ produce offsides↑ even though a
          // halfway-high line pushes the ride zone where flags are illegal
          const defLine = (side === 'home' ? awayCtx : homeCtx).tactics.team.lineHeight;
          const trap = 0.6 + AGENT_CAL.offsideTrapGain * defLine;
          const mistimed = !beyondLine && ridingLine && beyondBall && inOppHalf &&
            rng.chance(AGENT_CAL.mistimedRunProb * trap * Math.max(0.2, timing), tick, passReceiver.id, 'offside-timing');
          if ((beyondLine && beyondBall && inOppHalf) || mistimed) {
            const margin = side === 'home' ? passReceiver.pos.x - line : line - passReceiver.pos.x;
            events.push({
              t: now, type: 'offside', playerId: passReceiver.id, from: { ...passReceiver.pos },
              // diagnosis meta: geometric margin (mistimes are ≤ tolerance),
              // receiver velocity, and which channel flagged it
              meta: {
                margin: Math.round(margin * 10) / 10,
                recvVx: Math.round(passReceiver.vel.x * 10) / 10,
                mistimed: mistimed ? 1 : 0,
              },
            });
            giveToKeeper(ball, states, tracker, oppositeOf(side));
            continue;
          }
        }

        const outcome = this.execution.execute(chosen, {
          actor: ctx.carrier,
          ourControl: (p) => (side === 'home' ? control.controlAtPoint(p) : 1 - control.controlAtPoint(p)),
          opponents: opps,
          receiver: passReceiver,
          defendingGk: opps.find((o) => o.isGk),
          pressure: ctx.pressure,
          attackingGoalX: ctx.attackingGoal.x,
        }, rng, tick);

        // ── resolve ball + detect events
        if (chosen.type === 'shot') {
          const xg = shotQuality(carrier.pos, side === 'home' ? PITCH_LENGTH : 0); // angle-honest (agent-only)
          tallies.shot(carrier.id);
          xgSum[side] += xg;
          if (outcome.success) tallies.sot(carrier.id); // success = on target
          // key pass / assist: the completed pass that put the shooter in
          // (same possession, no opponent touch in between — chain-tracked)
          const assisterId = chain.lastPassReceiverId === carrier.id ? chain.lastPasserId : null;
          if (assisterId) tallies.keyPass(assisterId);
          if (outcome.success && !outcome.goal) {
            const gk = opps.find((o) => o.isGk);
            if (gk) {
              tallies.save(gk.id);
              events.push({ t: now + 0.05, type: 'save', playerId: gk.id });
            }
          }
          events.push({
            t: now, type: 'shot', playerId: carrier.id,
            from: { ...carrier.pos }, to: outcome.endPoint, flight: outcome.flight,
            meta: {
              xg: Math.round(xg * 1000) / 1000,
              // provenance instrument (Phase 1 diagnosis): the chain behind this shot
              chPasses: chain.passes,
              chDurS: Math.round((now - chain.startT) * 10) / 10,
              chPassM: Math.round(chain.passProgressM * 10) / 10,
              chCarryM: Math.round(chain.carryProgressM * 10) / 10,
              chFlightDebtS: Math.round(chain.flightDebtS * 10) / 10,
              chGhostRecv: chain.ghostRecv,
              chTeleportM: Math.round(chain.teleportM * 10) / 10,
            },
          });
          if (outcome.goal) {
            score[side]++;
            tallies.goal(carrier.id);
            if (assisterId) tallies.assist(assisterId);
            events.push({
              t: now + 0.1, type: 'goal', playerId: carrier.id, outcome: 'success',
              ...(assisterId ? { meta: { assistId: assisterId } } : {}),
            });
            resetKickoff(ball, states, tracker, oppositeOf(side));
          } else if (rng.chance(AGENT_CAL.cornerProb, tick, carrier.id, 'corner')) {
            resolveSetPieceDelivery(side, 'corner', now + 0.2, tick);
          } else {
            giveToKeeper(ball, states, tracker, oppositeOf(side));
          }
        } else if (chosen.type === 'carry' || chosen.type === 'hold') {
          if (outcome.success && chosen.type === 'carry') {
            chain.carryProgressM += (outcome.endPoint.x - carrier.pos.x) * (side === 'home' ? 1 : -1); // instrument
          }
          if (outcome.success || chosen.type === 'hold') {
            carrier.pos = outcome.success ? outcome.endPoint : carrier.pos;
            ball.pos = { ...carrier.pos };
            ball.lastTouchSide = side;
          } else {
            // dispossessed: the nearest opponent made the challenge
            const tackler = nearestTo(states, oppositeOf(side), carrier.pos);
            let foulRate = AGENT_CAL.foulPerTackle *
              (tackler ? 1 + AGENT_CAL.aggressionFoulGain * (tackler.attributes.aggression / 20 - 0.5) : 1);
            // booked players tackle carefully; nobody dives in inside their own box
            if (tackler?.yellows) foulRate *= AGENT_CAL.bookedCautionFactor;
            if (inAttackingBox(side, carrier.pos)) foulRate *= AGENT_CAL.boxFoulFactor;
            if (tackler && rng.chance(foulRate, tick, tackler.id, 'foul')) {
              bookFoul(tackler, carrier.pos, now, tick);
              if (inAttackingBox(side, carrier.pos)) {
                resolvePenalty(side, carrier, now + 0.2, tick);
              } else if (ownRelX(side, carrier.pos.x) > AGENT_CAL.finalThirdX) {
                resolveSetPieceDelivery(side, 'freeKick', now + 0.2, tick);
              }
              // otherwise: free kick, carrier's side keeps the ball in place
            } else if (tackler) {
              events.push({ t: now, type: 'tackle', playerId: tackler.id, outcome: 'success' });
              if (inBuildup(side, carrier.pos.x)) defActions[tackler.side]++;
              ball.pos = { ...tackler.pos };
              ball.carrierId = tackler.id;
              ball.lastTouchSide = tackler.side;
              tracker.turnover(tackler.side);
            }
          }
        } else {
          // pass family: the ball is KICKED — it becomes a real flight the
          // world resolves over the coming ticks (advanceFlight). Tallies and
          // long-ball events are settled at RESOLUTION, not here.
          // PPDA numerator counts every pass attempt, lofted included.
          if (inBuildup(side, carrier.pos.x)) buildupPasses[side]++;
          // provenance instrument (kick time): a pass aimed where its receiver
          // cannot physically arrive before the ball is a GHOST-AIMED ball —
          // under instant arrival these completed anyway; now the flight decides
          if (passReceiver && chosen.receiverId) {
            const flightT = dist(carrier.pos, outcome.endPoint) /
              (outcome.flight === 'lofted' || outcome.flight === 'high'
                ? AGENT_CAL.loftedPassSpeedMps : AGENT_CAL.groundPassSpeedMps);
            const recvT = arrivalTime(passReceiver, outcome.endPoint.x, outcome.endPoint.y);
            if (recvT > flightT + 0.3) chain.ghostRecv++;
          }
          // BLOCKED RELEASE: under a presser's nose the kick can hit his legs
          // — the ball squirts loose right here instead of flying. This is the
          // crowded-midfield physics the pressure logit alone can't produce
          // (a shanked DIRECTION still finds a teammate; a block does not).
          {
            const blocker = nearestTo(states, oppositeOf(side), carrier.pos);
            if (blocker && ctx.pressure > AGENT_CAL.ballBlockPressureFloor) {
              const pBlock = AGENT_CAL.ballBlockBase * ctx.pressure * (0.5 + blocker.attributes.anticipation / 20);
              if (rng.chance(pBlock, tick, carrier.id, 'block', blocker.id)) {
                if (outcome.flight === 'ground' || outcome.flight === 'driven') tallies.pass(carrier.id, false);
                ball.carrierId = null;
                ball.flight = 'ground';
                ball.inFlight = null;
                ball.pos = clampToPitch({
                  x: carrier.pos.x + rng.gauss(0, AGENT_CAL.ballBlockScatterM, tick, carrier.id, 'block-x'),
                  y: carrier.pos.y + rng.gauss(0, AGENT_CAL.ballBlockScatterM, tick, carrier.id, 'block-y'),
                });
                ball.lastTouchSide = blocker.side;
                continue;
              }
            }
          }
          // OUT OF BOUNDS exists now: pass endpoints are unclamped — a flight
          // crossing the boundary dies at the crossing (throw-in-style restart
          // to the other side at arrival). Clip the path where it exits.
          const rawTo = outcome.endPoint;
          const oob = rawTo.x < 0 || rawTo.x > PITCH_LENGTH || rawTo.y < 0 || rawTo.y > PITCH_WIDTH;
          let to = rawTo;
          if (oob) {
            const dx = rawTo.x - carrier.pos.x;
            const dy = rawTo.y - carrier.pos.y;
            let tHit = 1;
            if (dx > 0) tHit = Math.min(tHit, (PITCH_LENGTH - carrier.pos.x) / dx);
            if (dx < 0) tHit = Math.min(tHit, (0 - carrier.pos.x) / dx);
            if (dy > 0) tHit = Math.min(tHit, (PITCH_WIDTH - carrier.pos.y) / dy);
            if (dy < 0) tHit = Math.min(tHit, (0 - carrier.pos.y) / dy);
            to = clampToPitch({ x: carrier.pos.x + dx * Math.max(0, tHit), y: carrier.pos.y + dy * Math.max(0, tHit) });
          }
          ball.inFlight = {
            from: { ...carrier.pos },
            to,
            speedMps: outcome.flight === 'lofted' || outcome.flight === 'high'
              ? AGENT_CAL.loftedPassSpeedMps : AGENT_CAL.groundPassSpeedMps,
            travelledM: 0,
            kickerId: carrier.id,
            kickerSide: side,
            receiverId: chosen.receiverId ?? null,
            actionType: chosen.type as 'pass' | 'longPass' | 'cross' | 'clear',
            flightEnum: outcome.flight,
            kickT: now,
            flightId: flightSeq++,
            cleanStrike: outcome.success,
            outOfBounds: oob,
            attempted: new Set<string>(),
          };
          ball.pos = { ...carrier.pos };
          ball.flight = outcome.flight;
          ball.carrierId = null; // the ball has left his feet
          ball.lastTouchSide = side;
        }
      } else if (!carrier && !ball.inFlight) {
        // loose ball: claimed by a body that actually REACHES it (the loose
        // chaser runs at the ball itself) — no instant grab
        const claimant = nearestAny(states, ball.pos);
        if (claimant && dist(claimant.pos, ball.pos) <= AGENT_CAL.ballReceiveRadiusM) {
          ball.carrierId = claimant.id;
          ball.pos = { ...claimant.pos };
          ball.lastTouchSide = claimant.side;
          tracker.turnover(claimant.side);
          // a pass that died in space resolves NOW: collected by a teammate =
          // completed; picked off = failed. Assist chain rides the collection.
          const pf = pending.flight;
          if (pf) {
            const completed = claimant.side === pf.kickerSide;
            settleFlightStats(pf, completed);
            if (completed) {
              chain.passes++;
              chain.passProgressM += (ball.pos.x - pf.from.x) * (claimant.side === 'home' ? 1 : -1);
              chain.lastPasserId = pf.kickerId;
              chain.lastPassReceiverId = claimant.id;
            }
            pending.flight = null;
          }
        }
      } else if (carrier) {
        ball.pos = { ...carrier.pos };
      }

      // ── bookkeeping
      for (const s of states) {
        if (s.sentOff) continue; // clock stopped: fatigue frozen at the red card
        // base metabolic cost + a share that scales with distance actually run;
        // match-rusty players drain condition faster (the visible sharpness cost)
        const work = 1 - AGENT_CAL.fatigueWorkShare + AGENT_CAL.fatigueWorkShare * 2 * (workOf.get(s.id) ?? 0);
        const rust = 1 + AGENT_CAL.sharpnessFatigueGain * (1 - s.sharpness);
        s.fatigue = Math.min(
          1,
          s.fatigue + AGENT_CAL.fatiguePerTick * work * rust * (1 - AGENT_CAL.staminaFatigueRelief * (s.attributes.stamina / 20)),
        );
      }

      // injuries: tiny per-tick hazard, fatigue-scaled — one aggregate draw,
      // then a weighted pick, so adding players never reshuffles other draws
      {
        let totalHazard = 0;
        for (const s of states) {
          if (s.sentOff || s.injured) continue;
          totalHazard += AGENT_CAL.injuryPerTickBase * (1 + AGENT_CAL.injuryFatigueGain * s.fatigue);
        }
        if (totalHazard > 0 && rng.chance(totalHazard, tick, 'injury-any')) {
          let r = rng.float(tick, 'injury-who') * totalHazard;
          for (const s of states) {
            if (s.sentOff || s.injured) continue;
            r -= AGENT_CAL.injuryPerTickBase * (1 + AGENT_CAL.injuryFatigueGain * s.fatigue);
            if (r < 0) {
              s.injured = true;
              events.push({ t: now, type: 'injury', playerId: s.id });
              break;
            }
          }
        }
      }
      // sample on ODD ticks: decisions fire on even ticks, so an aligned
      // sample would systematically catch the just-kicked (carrier-null)
      // instant and misread real possession as loose play
      if (tick % framePeriod === framePeriod - 1) {
        frames.push(frame(now, ball, states));
        heat.sample(states);
      }
    }

    events.push({ t: t0 + HALF_SECONDS, type: 'halfEnd' });

    return {
      events,
      frames,
      stats: buildStats(states, tallies, possessionTicks, { buildupPasses, defActions, tiltTicks, xgSum }, heat),
      endState: buildEndState(states, inactive, score, resume, rng, subsIn),
    };
  }
}

// ── setup ─────────────────────────────────────────────────────────────────────

function setup(
  squads: { home: SquadPlayer[]; away: SquadPlayer[] },
  tactics: { home: Tactics; away: Tactics },
  resume: HalfTimeState | undefined,
) {
  const states: AgentState[] = [];
  const inactive: AgentState[] = [];
  const heights = new Map<string, number>();
  const subsIn: [number, number] = [0, 0];

  for (const side of ['home', 'away'] as Side[]) {
    const squad = squads[side];
    const tac = tactics[side];
    const byId = new Map(squad.map((sp) => [sp.playerId, sp]));
    const gkId = tac.players.reduce((best, pt) => {
      const g = (id: string): number => {
        const a = byId.get(id)!.attributes;
        return a.gkReflexes + a.gkPositioning + a.gkDistribution;
      };
      return g(pt.playerId) > g(best) ? pt.playerId : best;
    }, tac.players[0].playerId);

    for (const pt of tac.players) {
      const sp = byId.get(pt.playerId);
      if (!sp) throw new Error(`tactic references ${pt.playerId} not in squad`);
      heights.set(sp.playerId, sp.physical.heightCm);
      const prev = resume?.playerState[pt.playerId];
      const anchors = {} as Record<Phase, Vec2>;
      for (const phase of Object.keys(pt.anchors) as Phase[]) {
        anchors[phase] = side === 'home' ? pt.anchors[phase] : flip(pt.anchors[phase]);
      }
      const state: AgentState = {
        id: pt.playerId,
        side,
        isGk: pt.playerId === gkId,
        pos: { ...anchors.progression },
        vel: { x: 0, y: 0 },
        attributes: sp.attributes,
        instructions: pt.instructions,
        anchors,
        fatigue: prev?.fatigue ?? sp.fatigue,
        sharpness: sp.sharpness ?? 1, // absent = match-sharp (pre-split blobs)
        yellows: prev?.cards.yellows ?? 0,
        sentOff: prev?.cards.sentOff ?? false,
        injured: prev?.injured ?? false,
        startMinutes: prev?.minutesPlayed ?? 0,
        startFatigue: prev?.fatigue ?? sp.fatigue,
      };
      (state.sentOff ? inactive : states).push(state); // sent-off never re-enter
      // HT subs consumption: an XI player with no half-1 record came off the bench
      if (resume && !prev) subsIn[side === 'home' ? 0 : 1]++;
    }
  }
  return {
    states,
    inactive,
    heights,
    subsIn,
    homeCtx: { side: 'home', tactics: tactics.home, playerIds: states.filter((s) => s.side === 'home').map((s) => s.id) } as TeamContext,
    awayCtx: { side: 'away', tactics: tactics.away, playerIds: states.filter((s) => s.side === 'away').map((s) => s.id) } as TeamContext,
  };
}

// ── movement + lookups ────────────────────────────────────────────────────────

/** Returns the distance actually covered (feeds work-based fatigue). */
function stepToward(s: AgentState, target: Vec2): number {
  const d = dist(s.pos, target);

  // deadzone: already at the target for practical purposes — stand calmly
  // instead of micro-hunting a per-tick jittering attractor (the yoyo fix);
  // velocity bleeds off so the pitch-control arrival model sees a stop
  if (d <= AGENT_CAL.moveDeadzoneM) {
    s.vel = { x: s.vel.x * 0.5, y: s.vel.y * 0.5 };
    return 0;
  }

  // urgency: sprint at distant targets (chases), jog positional shuffles —
  // this is what concentrates fatigue on pressers instead of everyone
  const urgency = Math.min(1, d / AGENT_CAL.urgencyDistM);
  const speed =
    AGENT_CAL.maxSpeedMps * (s.attributes.pace / 20) * (1 - AGENT_CAL.fatigueSpeedPenalty * s.fatigue) *
    (AGENT_CAL.cruiseSpeedShare + (1 - AGENT_CAL.cruiseSpeedShare) * urgency);

  // inertia: blend velocity toward the desired vector instead of snapping to
  // it — direction changes carry momentum, so a flipped target curves the
  // run rather than reversing it instantly
  const desired = { x: ((target.x - s.pos.x) / d) * speed, y: ((target.y - s.pos.y) / d) * speed };
  const blend = AGENT_CAL.accelSmoothing;
  let vx = s.vel.x + (desired.x - s.vel.x) * blend;
  let vy = s.vel.y + (desired.y - s.vel.y) * blend;
  const vMag = Math.hypot(vx, vy);
  if (vMag > speed) {
    vx *= speed / vMag;
    vy *= speed / vMag;
  }

  const prev = s.pos;
  const stepLen = Math.hypot(vx, vy) * AGENT_CAL.tickSeconds;
  s.pos = d <= stepLen
    ? clampToPitch({ ...target }) // arrival: land on the target, no orbiting
    : clampToPitch({ x: s.pos.x + vx * AGENT_CAL.tickSeconds, y: s.pos.y + vy * AGENT_CAL.tickSeconds });
  // velocity feeds the pitch-control arrival model (reaction-window carry)
  const moved = dist(prev, s.pos);
  s.vel = {
    x: (s.pos.x - prev.x) / AGENT_CAL.tickSeconds,
    y: (s.pos.y - prev.y) / AGENT_CAL.tickSeconds,
  };
  return moved;
}

// mid-half send-offs leave the pitch: every active-play lookup skips them
const active = (states: AgentState[]): AgentState[] => states.filter((s) => !s.sentOff);

const snapshots = (states: AgentState[], side: Side): AgentSnapshot[] =>
  active(states).filter((s) => s.side === side).map(snapshotOf);

function snapshotOf(s: AgentState): AgentSnapshot {
  return {
    id: s.id, side: s.side, isGk: s.isGk, pos: { ...s.pos }, vel: { ...s.vel },
    attributes: s.attributes, instructions: s.instructions, fatigue: s.fatigue, sharpness: s.sharpness,
  };
}

const anchorsOf = (states: AgentState[], side: Side): Map<string, Record<Phase, Vec2>> =>
  new Map(states.filter((s) => s.side === side).map((s) => [s.id, s.anchors]));

const nearestTo = (states: AgentState[], side: Side, p: Vec2): AgentState | undefined =>
  active(states).filter((s) => s.side === side).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];

const nearestAny = (states: AgentState[], p: Vec2): AgentState | undefined =>
  active(states).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];

function resetKickoff(ball: BallState, states: AgentState[], tracker: PhaseTracker, to: Side): void {
  ball.pos = { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 };
  ball.flight = 'ground';
  ball.inFlight = null; // restarts kill any live flight
  tracker.turnover(to);
  const receiver = nearestTo(states, to, ball.pos);
  ball.carrierId = receiver?.id ?? null;
  ball.lastTouchSide = to;
}

function giveToKeeper(ball: BallState, states: AgentState[], tracker: PhaseTracker, to: Side): void {
  const gk = states.find((s) => s.side === to && s.isGk) ?? nearestTo(states, to, ball.pos);
  if (!gk) return;
  ball.pos = { ...gk.pos };
  ball.carrierId = gk.id;
  ball.flight = 'ground';
  ball.inFlight = null; // the keeper collects — any live flight is dead
  ball.lastTouchSide = to;
  tracker.turnover(to);
}

// ── emission ──────────────────────────────────────────────────────────────────

function frame(t: number, ball: BallState, states: AgentState[]): ReplayFrame {
  const players: Record<string, Vec2> = {};
  for (const s of active(states)) players[s.id] = { x: round1(s.pos.x), y: round1(s.pos.y) };
  return {
    t: round1(t),
    ball: { x: round1(ball.pos.x), y: round1(ball.pos.y), flight: ball.flight },
    // the sim pins a carried ball to the carrier every tick — emitting WHO
    // lets the viewer keep it at their feet between 6s keyframes instead of
    // interpolating it through open space (DECISIONS: the noted field)
    carrier: ball.carrierId,
    players,
  };
}

class Tallies {
  goals = new Map<string, number>();
  shots = new Map<string, number>();
  sots = new Map<string, number>();
  passesAtt = new Map<string, number>();
  passesOk = new Map<string, number>();
  aerials = new Map<string, number>();
  // per-player stats the season layer aggregates later (assists ride goal
  // events too; these are the per-match emission)
  assists = new Map<string, number>();
  keyPasses = new Map<string, number>();
  saves = new Map<string, number>();
  constructor(ids: string[]) {
    for (const id of ids) {
      this.goals.set(id, 0); this.shots.set(id, 0); this.sots.set(id, 0);
      this.passesAtt.set(id, 0); this.passesOk.set(id, 0); this.aerials.set(id, 0);
      this.assists.set(id, 0); this.keyPasses.set(id, 0); this.saves.set(id, 0);
    }
  }
  private bump(m: Map<string, number>, id: string): void {
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  goal(id: string): void { this.bump(this.goals, id); }
  shot(id: string): void { this.bump(this.shots, id); }
  sot(id: string): void { this.bump(this.sots, id); }
  aerial(id: string): void { this.bump(this.aerials, id); }
  assist(id: string): void { this.bump(this.assists, id); }
  keyPass(id: string): void { this.bump(this.keyPasses, id); }
  save(id: string): void { this.bump(this.saves, id); }
  pass(id: string, ok: boolean): void {
    this.bump(this.passesAtt, id);
    if (ok) this.bump(this.passesOk, id);
  }
  sum(m: Map<string, number>, ids: Set<string>): number {
    let n = 0;
    for (const [id, v] of m) if (ids.has(id)) n += v;
    return n;
  }
}

/** 12×8 team-relative grid, same contract as the aggregate engine. */
class HeatAccumulator {
  private cells = new Map<string, number[]>();
  constructor(ids: string[]) {
    for (const id of ids) this.cells.set(id, new Array<number>(96).fill(0));
  }
  sample(states: AgentState[]): void {
    for (const s of active(states)) {
      const rel = s.side === 'home' ? s.pos : flip(s.pos); // team-relative frame
      const col = Math.min(11, Math.floor((rel.x / PITCH_LENGTH) * 12));
      const row = Math.min(7, Math.floor((rel.y / PITCH_WIDTH) * 8));
      this.cells.get(s.id)![row * 12 + col]++;
    }
  }
  normalized(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [id, cells] of this.cells) {
      const total = cells.reduce((a, b) => a + b, 0) || 1;
      out[id] = cells.map((c) => Math.round((c / total) * 10000) / 10000);
    }
    return out;
  }
}

interface TeamCounters {
  buildupPasses: Record<Side, number>;
  defActions: Record<Side, number>;
  tiltTicks: Record<Side, number>;
  xgSum: Record<Side, number>;
}

function buildStats(
  states: AgentState[],
  tallies: Tallies,
  possessionTicks: Record<Side, number>,
  counters: TeamCounters,
  heat: HeatAccumulator,
): HalfStats {
  const homeIds = new Set(states.filter((s) => s.side === 'home').map((s) => s.id));
  const awayIds = new Set(states.filter((s) => s.side === 'away').map((s) => s.id));
  const totalTicks = possessionTicks.home + possessionTicks.away || 1;
  const possH = round1((possessionTicks.home / totalTicks) * 100);
  const pctOk = (ids: Set<string>): number => {
    const att = tallies.sum(tallies.passesAtt, ids) || 1;
    return round1((tallies.sum(tallies.passesOk, ids) / att) * 100);
  };
  const playerRatings: Record<string, number> = {};
  for (const s of states) {
    const r = 6.4 +
      AGENT_CAL.ratingGoalBonus * (tallies.goals.get(s.id) ?? 0) +
      AGENT_CAL.ratingAerialBonus * (tallies.aerials.get(s.id) ?? 0) -
      AGENT_CAL.ratingCardPenalty * (s.yellows + (s.sentOff ? 2 : 0));
    playerRatings[s.id] = Math.min(9.8, Math.max(4, Math.round(r * 10) / 10));
  }
  const tiltTotal = counters.tiltTicks.home + counters.tiltTicks.away || 1;
  const playerStats: NonNullable<HalfStats['playerStats']> = {};
  for (const s of states) {
    playerStats[s.id] = {
      assists: tallies.assists.get(s.id) ?? 0,
      keyPasses: tallies.keyPasses.get(s.id) ?? 0,
      saves: tallies.saves.get(s.id) ?? 0,
    };
  }
  return {
    possession: [possH, round1(100 - possH)],
    shots: [tallies.sum(tallies.shots, homeIds), tallies.sum(tallies.shots, awayIds)],
    shotsOnTarget: [tallies.sum(tallies.sots, homeIds), tallies.sum(tallies.sots, awayIds)],
    xg: [round1(counters.xgSum.home * 10) / 10, round1(counters.xgSum.away * 10) / 10],
    passAccuracy: [pctOk(homeIds), pctOk(awayIds)],
    aerialsWon: [tallies.sum(tallies.aerials, homeIds), tallies.sum(tallies.aerials, awayIds)],
    // PPDA: opponent build-up passes per own defensive action there
    ppda: [
      round1(counters.buildupPasses.away / Math.max(1, counters.defActions.home)),
      round1(counters.buildupPasses.home / Math.max(1, counters.defActions.away)),
    ],
    fieldTilt: [
      round1((counters.tiltTicks.home / tiltTotal) * 100),
      round1((counters.tiltTicks.away / tiltTotal) * 100),
    ],
    playerRatings,
    heatmaps: heat.normalized(),
    playerStats,
  };
}

function buildEndState(
  states: AgentState[],
  inactive: AgentState[],
  score: Record<Side, number>,
  resume: HalfTimeState | undefined,
  rng: KeyedRng,
  subsIn: [number, number],
): HalfTimeState {
  const prevScore = resume?.score ?? [0, 0];
  const playerState: HalfTimeState['playerState'] = {};
  for (const s of states) {
    playerState[s.id] = {
      fatigue: Math.round(s.fatigue * 1000) / 1000,
      cards: { yellows: s.yellows, sentOff: s.sentOff },
      injured: s.injured,
      minutesPlayed: s.startMinutes + 45, // half-granular, even for mid-half reds (harness contract)
    };
  }
  for (const s of inactive) {
    // sent off in a previous half: frozen — no minutes, no fatigue delta
    playerState[s.id] = {
      fatigue: s.startFatigue,
      cards: { yellows: s.yellows, sentOff: true },
      injured: s.injured,
      minutesPlayed: s.startMinutes,
    };
  }
  if (resume) {
    // subbed-out half-1 players keep their record (server bookkeeping reads it)
    for (const [id, prev] of Object.entries(resume.playerState)) {
      if (!(id in playerState)) playerState[id] = prev;
    }
  }
  return {
    v: 2,
    score: [prevScore[0] + score.home, prevScore[1] + score.away],
    playerState,
    subsUsed: resume
      ? [resume.subsUsed[0] + subsIn[0], resume.subsUsed[1] + subsIn[1]]
      : [0, 0],
    // keyed randomness has no stream to serialize: the namespace IS the
    // state (h2 derives a child namespace from it, so tokens differ per half)
    rngState: rng.token(),
  };
}
