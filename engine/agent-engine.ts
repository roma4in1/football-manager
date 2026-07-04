/**
 * agent-engine.ts — AgentEngine: pitch-control agent sim behind the SAME
 * frozen SimEngine interface as AggregateEngine (engine-types.ts). Swappable:
 * same signature, same HalfResult contracts, same frame cadence.
 *
 * SCAFFOLD (DECISIONS.md, agent-engine architecture): the tick loop, phase
 * state machine, keyed randomness, emission contracts, and v2 resume
 * semantics are REAL; the three injected sub-models (positioning / decision /
 * execution) are typed stubs. Harness bands are expected to fail — structure
 * over behavior until Wednesday's calibration session.
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

    const { states, inactive, homeCtx, awayCtx, heights } = setup(squads, tactics, resume);
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

    const ticks = Math.floor(HALF_SECONDS / AGENT_CAL.tickSeconds);
    const framePeriod = Math.round(AGENT_CAL.frameEverySeconds / AGENT_CAL.tickSeconds);

    for (let tick = 0; tick < ticks; tick++) {
      const now = t0 + tick * AGENT_CAL.tickSeconds;
      tracker.advance(AGENT_CAL.tickSeconds);
      possessionTicks[tracker.inPossession]++;

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
        });
        for (const s of states) {
          if (s.side !== side) continue;
          stepToward(s, targets.get(s.id) ?? s.pos);
        }
      }

      // ── decide + execute (carrier only, at the decision cadence)
      const carrier = ball.carrierId ? byId.get(ball.carrierId) : undefined;
      if (carrier && tick % AGENT_CAL.decisionEveryTicks === 0) {
        const side = carrier.side;
        const mates = side === 'home' ? homeSnaps : awaySnaps;
        const opps = side === 'home' ? awaySnaps : homeSnaps;
        const nearestOpp = opps.reduce((m, o) => Math.min(m, dist(o.pos, carrier.pos)), Infinity);
        const ctx = {
          carrier: snapshotOf(carrier),
          teammates: mates,
          opponents: opps,
          pitchControl: control,
          attackingGoal: side === 'home' ? { x: PITCH_LENGTH, y: PITCH_WIDTH / 2 } : { x: 0, y: PITCH_WIDTH / 2 },
          side,
          instructions: carrier.instructions,
          team: (side === 'home' ? homeCtx : awayCtx).tactics.team,
          pressure: Math.max(0, 1 - nearestOpp / 10),
        };
        const options = this.decision.generateOptions(ctx);
        const chosen = this.decision.choose(this.decision.scoreOptions(ctx, options), ctx, rng, tick);
        const outcome = this.execution.execute(chosen, ctx.carrier, rng, tick);

        // ── resolve ball + detect events
        if (chosen.type === 'shot') {
          tallies.shot(carrier.id);
          events.push({
            t: now, type: 'shot', playerId: carrier.id,
            from: { ...carrier.pos }, to: outcome.endPoint, flight: outcome.flight,
            meta: { xg: 0.1 }, // STUB xG — Wednesday's shot model owns this
          });
          if (outcome.goal) {
            score[side]++;
            tallies.goal(carrier.id);
            events.push({ t: now + 0.1, type: 'goal', playerId: carrier.id, outcome: 'success' });
            resetKickoff(ball, states, tracker, side === 'home' ? 'away' : 'home');
          } else {
            giveToKeeper(ball, states, tracker, side === 'home' ? 'away' : 'home');
          }
        } else if (chosen.type === 'carry' || chosen.type === 'hold') {
          carrier.pos = outcome.success ? outcome.endPoint : carrier.pos;
          ball.pos = { ...carrier.pos };
          ball.lastTouchSide = side;
        } else {
          // pass-like: lofted/high arrivals may contest an aerial duel
          tallies.pass(carrier.id, outcome.success);
          let receiver: AgentState | undefined;
          if (!outcome.success && (outcome.flight === 'lofted' || outcome.flight === 'high')) {
            const duel = this.execution.resolveAerialDuel(
              { ball: outcome.endPoint, contestants: contestantsNear(states, outcome.endPoint), heightCmById: heights },
              rng, tick,
            );
            tallies.aerial(duel.winnerId);
            receiver = byId.get(duel.winnerId);
          } else if (outcome.success && chosen.receiverId) {
            receiver = byId.get(chosen.receiverId);
          } else {
            receiver = nearestTo(states, side === 'home' ? 'away' : 'home', outcome.endPoint); // turnover
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
        s.fatigue = Math.min(
          1,
          s.fatigue + AGENT_CAL.fatiguePerTick * (1 - AGENT_CAL.staminaFatigueRelief * (s.attributes.stamina / 20)),
        );
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
      stats: buildStats(states, tallies, possessionTicks, score, heat),
      endState: buildEndState(states, inactive, score, resume, rng),
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
    }
  }
  return {
    states,
    inactive,
    heights,
    homeCtx: { side: 'home', tactics: tactics.home, playerIds: states.filter((s) => s.side === 'home').map((s) => s.id) } as TeamContext,
    awayCtx: { side: 'away', tactics: tactics.away, playerIds: states.filter((s) => s.side === 'away').map((s) => s.id) } as TeamContext,
  };
}

// ── movement + lookups ────────────────────────────────────────────────────────

function stepToward(s: AgentState, target: Vec2): void {
  const speed =
    AGENT_CAL.maxSpeedMps * (s.attributes.pace / 20) * (1 - AGENT_CAL.fatigueSpeedPenalty * s.fatigue);
  const step = speed * AGENT_CAL.tickSeconds;
  const d = dist(s.pos, target);
  if (d <= step) {
    s.pos = clampToPitch({ ...target });
    return;
  }
  s.pos = clampToPitch({
    x: s.pos.x + ((target.x - s.pos.x) / d) * step,
    y: s.pos.y + ((target.y - s.pos.y) / d) * step,
  });
}

const snapshots = (states: AgentState[], side: Side): AgentSnapshot[] =>
  states.filter((s) => s.side === side).map(snapshotOf);

function snapshotOf(s: AgentState): AgentSnapshot {
  return {
    id: s.id, side: s.side, isGk: s.isGk, pos: { ...s.pos }, vel: { ...s.vel },
    attributes: s.attributes, instructions: s.instructions, fatigue: s.fatigue,
  };
}

const anchorsOf = (states: AgentState[], side: Side): Map<string, Record<Phase, Vec2>> =>
  new Map(states.filter((s) => s.side === side).map((s) => [s.id, s.anchors]));

const nearestTo = (states: AgentState[], side: Side, p: Vec2): AgentState | undefined =>
  states.filter((s) => s.side === side).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];

const nearestAny = (states: AgentState[], p: Vec2): AgentState | undefined =>
  [...states].sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];

const contestantsNear = (states: AgentState[], p: Vec2): AgentSnapshot[] =>
  [...states].sort((a, b) => dist(a.pos, p) - dist(b.pos, p)).slice(0, 2).map(snapshotOf);

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
  for (const s of states) players[s.id] = { x: round1(s.pos.x), y: round1(s.pos.y) };
  return { t: round1(t), ball: { x: round1(ball.pos.x), y: round1(ball.pos.y), flight: ball.flight }, players };
}

class Tallies {
  goals = new Map<string, number>();
  shots = new Map<string, number>();
  passesAtt = new Map<string, number>();
  passesOk = new Map<string, number>();
  aerials = new Map<string, number>();
  constructor(ids: string[]) {
    for (const id of ids) {
      this.goals.set(id, 0); this.shots.set(id, 0);
      this.passesAtt.set(id, 0); this.passesOk.set(id, 0); this.aerials.set(id, 0);
    }
  }
  private bump(m: Map<string, number>, id: string): void {
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  goal(id: string): void { this.bump(this.goals, id); }
  shot(id: string): void { this.bump(this.shots, id); }
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
    for (const s of states) {
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

function buildStats(
  states: AgentState[],
  tallies: Tallies,
  possessionTicks: Record<Side, number>,
  score: Record<Side, number>,
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
    playerRatings[s.id] = Math.min(9.8, 6 + 0.9 * (tallies.goals.get(s.id) ?? 0)); // STUB ratings
  }
  return {
    possession: [possH, round1(100 - possH)],
    shots: [tallies.sum(tallies.shots, homeIds), tallies.sum(tallies.shots, awayIds)],
    shotsOnTarget: [score.home, score.away], // STUB: only goals counted on target
    xg: [round1(tallies.sum(tallies.shots, homeIds) * 0.1), round1(tallies.sum(tallies.shots, awayIds) * 0.1)],
    passAccuracy: [pctOk(homeIds), pctOk(awayIds)],
    aerialsWon: [tallies.sum(tallies.aerials, homeIds), tallies.sum(tallies.aerials, awayIds)],
    ppda: [12, 12], // STUB — needs the press/defensive-action model
    fieldTilt: [possH, round1(100 - possH)], // STUB: mirrors possession
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
): HalfTimeState {
  const prevScore = resume?.score ?? [0, 0];
  const playerState: HalfTimeState['playerState'] = {};
  for (const s of states) {
    playerState[s.id] = {
      fatigue: Math.round(s.fatigue * 1000) / 1000,
      cards: { yellows: s.yellows, sentOff: s.sentOff },
      injured: s.injured,
      minutesPlayed: s.startMinutes + 45,
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
  return {
    v: 2,
    score: [prevScore[0] + score.home, prevScore[1] + score.away],
    playerState,
    subsUsed: resume?.subsUsed ?? [0, 0],
    // keyed randomness has no stream to serialize: the namespace IS the
    // state (h2 derives a child namespace from it, so tokens differ per half)
    rngState: rng.token(),
  };
}
