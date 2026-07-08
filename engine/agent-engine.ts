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
  clampToPitch,
  dist,
  PITCH_LENGTH,
  PITCH_WIDTH,
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
    };

    const events: MatchEvent[] = [{ t: t0, type: 'kickoff' }];
    const frames: ReplayFrame[] = [];
    const score: Record<Side, number> = { home: 0, away: 0 };
    const tallies = new Tallies(states.map((s) => s.id));
    const heat = new HeatAccumulator(states.map((s) => s.id));
    const possessionTicks: Record<Side, number> = { home: 0, away: 0 };

    const workOf = new Map<string, number>(); // per-tick share of max sprint, feeds fatigue
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
          events.push({ t: now + 0.2, type: 'goal', playerId: att.id, outcome: 'success', meta: { source: 'setPiece', header: 1 } });
          resetKickoff(ball, states, tracker, oppositeOf(side));
          return;
        }
        if (rng.chance(0.4, tick, att.id, 'sp-sot')) tallies.sot(att.id);
        giveToKeeper(ball, states, tracker, oppositeOf(side));
        return;
      }
      // defended: cleared, loose ball outside the box
      const clearPoint = clampToPitch({ x: spot.x + (side === 'home' ? -18 : 18), y: spot.y + rng.gauss(0, 8, tick, def.id, 'sp-clear') });
      const claimant = nearestAny(states, clearPoint);
      if (claimant) {
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
      return Math.max(-AGENT_CAL.stateMax, Math.min(AGENT_CAL.stateMax, -diff * urgency));
    };

    for (let tick = 0; tick < ticks; tick++) {
      const now = t0 + tick * AGENT_CAL.tickSeconds;
      tracker.advance(AGENT_CAL.tickSeconds);
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
          const moved = stepToward(s, targets.get(s.id) ?? s.pos);
          const maxStep = AGENT_CAL.maxSpeedMps * AGENT_CAL.tickSeconds;
          workOf.set(s.id, moved / maxStep);
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
          // crowd effect: the ONE home-advantage mechanism (context, not noise)
          pressure: side === 'home' ? rawPressure * (1 - AGENT_CAL.homePressureRelief) : rawPressure,
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
          if (beyondLine && beyondBall && inOppHalf) {
            events.push({ t: now, type: 'offside', playerId: passReceiver.id, from: { ...passReceiver.pos } });
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
          const xg = xgProxy(carrier.pos, side === 'home' ? PITCH_LENGTH : 0);
          tallies.shot(carrier.id);
          xgSum[side] += xg;
          if (outcome.success) tallies.sot(carrier.id); // success = on target
          events.push({
            t: now, type: 'shot', playerId: carrier.id,
            from: { ...carrier.pos }, to: outcome.endPoint, flight: outcome.flight,
            meta: { xg: Math.round(xg * 1000) / 1000 },
          });
          if (outcome.goal) {
            score[side]++;
            tallies.goal(carrier.id);
            events.push({ t: now + 0.1, type: 'goal', playerId: carrier.id, outcome: 'success' });
            resetKickoff(ball, states, tracker, oppositeOf(side));
          } else if (rng.chance(AGENT_CAL.cornerProb, tick, carrier.id, 'corner')) {
            resolveSetPieceDelivery(side, 'corner', now + 0.2, tick);
          } else {
            giveToKeeper(ball, states, tracker, oppositeOf(side));
          }
        } else if (chosen.type === 'carry' || chosen.type === 'hold') {
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
          // pass-like: lofted/high arrivals may contest an aerial duel.
          // passAccuracy is GROUND passes only (the passing/longPassing split —
          // long-ball completion is measured from pass events instead).
          if (outcome.flight === 'ground' || outcome.flight === 'driven') {
            tallies.pass(carrier.id, outcome.success);
          }
          // PPDA numerator counts every pass attempt, lofted included
          if (inBuildup(side, carrier.pos.x)) buildupPasses[side]++;
          if ((outcome.flight === 'lofted' || outcome.flight === 'high') && chosen.type !== 'cross') {
            // long-ball metrics read these. Crosses are excluded (FBref-style:
            // they read crossing, and would dilute the longPassing signal)
            events.push({
              t: now, type: 'pass', playerId: carrier.id,
              from: { ...carrier.pos }, to: outcome.endPoint, flight: outcome.flight,
              outcome: outcome.success ? 'success' : 'fail',
            });
          }
          let receiver: AgentState | undefined;
          if (!outcome.success && (outcome.flight === 'lofted' || outcome.flight === 'high')) {
            const contestants = contestantsNear(states, outcome.endPoint);
            const duel = this.execution.resolveAerialDuel(
              { ball: outcome.endPoint, contestants, heightCmById: heights },
              rng, tick,
            );
            tallies.aerial(duel.winnerId);
            receiver = byId.get(duel.winnerId);
            // the loser sometimes brings the winner down
            const loser = contestants.find((c) => c.id !== duel.winnerId);
            const loserState = loser ? byId.get(loser.id) : undefined;
            if (loserState && rng.chance(AGENT_CAL.aerialFoulRate, tick, loserState.id, 'foul')) {
              bookFoul(loserState, outcome.endPoint, now + 0.1, tick);
            }
          } else if (outcome.success && chosen.receiverId) {
            receiver = byId.get(chosen.receiverId);
          } else if (outcome.success) {
            receiver = nearestAny(states, outcome.endPoint); // clear: loose ball, nearest body
          } else if (outcome.intercepted) {
            receiver = nearestTo(states, side === 'home' ? 'away' : 'home', outcome.endPoint); // race lost
            if (receiver && (outcome.flight === 'ground' || outcome.flight === 'driven')) {
              events.push({ t: now, type: 'interception', playerId: receiver.id });
              if (inBuildup(side, outcome.endPoint.x)) defActions[receiver.side]++;
            }
          } else {
            receiver = nearestAny(states, outcome.endPoint); // technical miss: loose ball
          }
          if (receiver) {
            receiver.pos = clampToPitch({ ...outcome.endPoint });
            ball.pos = { ...receiver.pos };
            ball.carrierId = receiver.id;
            ball.flight = 'ground';
            ball.lastTouchSide = receiver.side;
            tracker.turnover(receiver.side);
          }
        }
      } else if (!carrier) {
        // loose ball: nearest player claims it (stub — no chasing model yet)
        const claimant = nearestAny(states, ball.pos);
        if (claimant) {
          ball.carrierId = claimant.id;
          ball.pos = { ...claimant.pos };
          tracker.turnover(claimant.side);
        }
      } else {
        ball.pos = { ...carrier.pos };
      }

      // ── bookkeeping
      for (const s of states) {
        if (s.sentOff) continue; // clock stopped: fatigue frozen at the red card
        // base metabolic cost + a share that scales with distance actually run
        const work = 1 - AGENT_CAL.fatigueWorkShare + AGENT_CAL.fatigueWorkShare * 2 * (workOf.get(s.id) ?? 0);
        s.fatigue = Math.min(
          1,
          s.fatigue + AGENT_CAL.fatiguePerTick * work * (1 - AGENT_CAL.staminaFatigueRelief * (s.attributes.stamina / 20)),
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
      if (tick % framePeriod === 0) {
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
  // urgency: sprint at distant targets (chases), jog positional shuffles —
  // this is what concentrates fatigue on pressers instead of everyone
  const urgency = Math.min(1, dist(s.pos, target) / AGENT_CAL.urgencyDistM);
  const speed =
    AGENT_CAL.maxSpeedMps * (s.attributes.pace / 20) * (1 - AGENT_CAL.fatigueSpeedPenalty * s.fatigue) *
    (AGENT_CAL.cruiseSpeedShare + (1 - AGENT_CAL.cruiseSpeedShare) * urgency);
  const step = speed * AGENT_CAL.tickSeconds;
  const d = dist(s.pos, target);
  const prev = s.pos;
  s.pos = d <= step
    ? clampToPitch({ ...target })
    : clampToPitch({
        x: s.pos.x + ((target.x - s.pos.x) / d) * step,
        y: s.pos.y + ((target.y - s.pos.y) / d) * step,
      });
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
    attributes: s.attributes, instructions: s.instructions, fatigue: s.fatigue,
  };
}

const anchorsOf = (states: AgentState[], side: Side): Map<string, Record<Phase, Vec2>> =>
  new Map(states.filter((s) => s.side === side).map((s) => [s.id, s.anchors]));

const nearestTo = (states: AgentState[], side: Side, p: Vec2): AgentState | undefined =>
  active(states).filter((s) => s.side === side).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];

const nearestAny = (states: AgentState[], p: Vec2): AgentState | undefined =>
  active(states).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];

const contestantsNear = (states: AgentState[], p: Vec2): AgentSnapshot[] =>
  active(states).sort((a, b) => dist(a.pos, p) - dist(b.pos, p)).slice(0, 2).map(snapshotOf);

function resetKickoff(ball: BallState, states: AgentState[], tracker: PhaseTracker, to: Side): void {
  ball.pos = { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 };
  ball.flight = 'ground';
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
  ball.lastTouchSide = to;
  tracker.turnover(to);
}

// ── emission ──────────────────────────────────────────────────────────────────

function frame(t: number, ball: BallState, states: AgentState[]): ReplayFrame {
  const players: Record<string, Vec2> = {};
  for (const s of active(states)) players[s.id] = { x: round1(s.pos.x), y: round1(s.pos.y) };
  return { t: round1(t), ball: { x: round1(ball.pos.x), y: round1(ball.pos.y), flight: ball.flight }, players };
}

class Tallies {
  goals = new Map<string, number>();
  shots = new Map<string, number>();
  sots = new Map<string, number>();
  passesAtt = new Map<string, number>();
  passesOk = new Map<string, number>();
  aerials = new Map<string, number>();
  constructor(ids: string[]) {
    for (const id of ids) {
      this.goals.set(id, 0); this.shots.set(id, 0); this.sots.set(id, 0);
      this.passesAtt.set(id, 0); this.passesOk.set(id, 0); this.aerials.set(id, 0);
    }
  }
  private bump(m: Map<string, number>, id: string): void {
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  goal(id: string): void { this.bump(this.goals, id); }
  shot(id: string): void { this.bump(this.shots, id); }
  sot(id: string): void { this.bump(this.sots, id); }
  aerial(id: string): void { this.bump(this.aerials, id); }
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
