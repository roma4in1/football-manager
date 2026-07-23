/**
 * sim.ts — the L2 simulation loop: fixed 10 Hz tick over kinematic bodies
 * (L1) and one physical ball (L2), driven by scripted commands/kicks.
 *
 * Tick order (fixed — determinism is the contract):
 *   1. scripted command re-targets fire;
 *   2. bodies step (chaseBall reads the ball's pre-step position);
 *   3. scripted kicks fire (carrier-gated);
 *   4. the carry coupling runs (touch / possession loss), then ball physics;
 *   5. loose-ball claims resolve (nearest body in reach, deterministic
 *      tie-break), completing any chaseBall race;
 *   6. the frame snapshots.
 *
 * The sim emits FULL-RATE frames internally; the stored/replayable format is
 * the decimated stream in frames.ts. No wall clock, no unkeyed randomness.
 */

import {
  DT,
  PITCH,
  type BodyState,
  type Frame,
  type FrameBody,
  type MovementCommand,
  type ScenarioDef,
  type Vec2,
} from './engine2-types.ts';
import { BALL, kickBall, loftFlightTimeS, predictBall, predictBallState, rollLaunchForArrival, solveLoftSpeed, stepBall, type BallState } from './ball.ts';
import { currentTarget, KIN, regimeCapMps, stepBody, topSpeedMps } from './kinematics.ts';
import { noisyKick, resolveFirstTouch, shieldRadiusM, tackleWinProbability, TECH } from './technique.ts';
import { aerialCompletion, attackSign, decide, DECIDE, decideDefense, DUEL, GOAL, goalCenter, passCompletion, runPlan, supportSpot, type Intent, type PlayInstructions } from './decide.ts';
import { KeyedRng } from './keyed-rng.ts';

export class Sim {
  readonly bodies: BodyState[];
  readonly ball: BallState;
  readonly rng: KeyedRng;
  tick = 0;
  private readonly byId = new Map<string, BodyState>();
  private readonly atTick = new Map<number, Array<{ bodyId: string; command: MovementCommand }>>();
  private readonly kicksAt = new Map<number, Array<{ bodyId: string; kick: { target: Vec2; speedMps: number; loftDeg: number; spin?: number } }>>();
  private readonly queues = new Map<string, MovementCommand[]>();
  /** per-tick live steering targets (intercepts/fetches) — the frame's debug
   * overlay shows what the body is ACTUALLY running to */
  private readonly liveTargets = new Map<string, Vec2>();
  /** L4: bodies that run the on-ball decision loop, their instructions,
   * their current intent, and the action label shown in the workbench */
  private readonly brains = new Set<string>();
  /** L7: goalkeeper bodies — they self-position (angle play) and stop shots */
  private readonly keepers = new Set<string>();
  /** tick a keeper first SAW the live shot — the dive starts after his
   * reaction (keeperReactTicks); before it he holds his angle */
  private readonly keeperShotSeen = new Map<string, number>();
  /** keepers ATTACKING a ball this tick (the sweep, the claim run) — they
   * sprint full tilt; the shuffle's face-lock is for POSITIONING only */
  private readonly keeperAttacking = new Set<string>();
  /** the keeper HOLDING the ball in his hands (a catch, a claim, a pickup in
   * his box) — UNTOUCHABLE: no tackle, no pinch, until he releases it */
  private keeperHolding: string | null = null;
  /** tick the hold began — distribution follows after a settle */
  private keeperHeldSince = 0;
  /** a DROP-TO-FEET pass in progress: the ball is down (immunity OFF — he is
   * honestly tackleable) and the ground pass strikes after the beat */
  private keeperDropPass: { keeperId: string; mateId: string; strikeTick: number } | null = null;
  /** goals conceded — a ball crossing either goal line between the posts,
   * under the bar. The minimal seam L7 acceptance needs (saved vs beaten);
   * restarts stay L8's. `against` is the team whose goal it crossed. */
  readonly goals: { tick: number; against: 'home' | 'away'; y: number; z: number }[] = [];
  private readonly instructions = new Map<string, PlayInstructions>();
  private readonly intents = new Map<string, Intent>();
  private readonly actionLabels = new Map<string, string>();
  /** the teammate a decided pass is flighted to — gets the receive reflex */
  private intendedReceiverId: string | null = null;
  /** initial positions — the 'keep' objective's drill stations */
  private readonly homes = new Map<string, Vec2>();
  /** drill boundaries, when the scenario defines a positional grid */
  private bounds?: { x0: number; y0: number; x1: number; y1: number };
  /** last scripted atTick per body — a body with a FUTURE scripted command
   * is waiting for his cue, not idle: support must not pre-move him */
  private readonly scriptedUntil = new Map<string, number>();
  /** brains currently making an L5b run (their moveTo is the run, not a
   * script — the run re-plans at cadence) */
  private readonly runningLine = new Set<string>();
  /** the run's phase per runner: RIDE (reload at a jog, level with the
   * line) or DART (sprint diagonally across a defender's blind side into
   * the next seam — the ball is released while the runner is AT PACE) */
  private readonly runPhase = new Map<string, { phase: 'ride' | 'dart'; since: number; dartY: number; lineX: number }>();
  /** tick each brain last RELEASED a pass — the one-two: a giver near the
   * line bursts immediately (the give IS his trigger; no patient ride) */
  private readonly lastGiveTick = new Map<string, number>();
  /** brains currently holding defensive shape (their moveTo is the line's,
   * re-planned at cadence — not a script) */
  private readonly shapeHolding = new Set<string>();
  /** L5d: when each team LOST possession (the counterpress window) and
   * when the current carrier claimed (the press-the-touch trigger) */
  private readonly lostPossessionAt = new Map<'home' | 'away', number>();
  private carrierSince = -1;
  private prevCarrierTeam: 'home' | 'away' | null = null;
  /** brains currently pressing (the first-defender election's memory) */
  private readonly pressingIds = new Set<string>();
  /** the half-turn: the intended receiver's anticipated NEXT-play direction,
   * refreshed during the flight — his receive facing opens toward it */
  private readonly receiveOpenDir = new Map<string, number>();
  /** runners whose thread is in flight: they BEND onto the ball's path at
   * pace instead of turning back to meet it (the judged wrongness: a free
   * runner stopping and coming back for a ball played into his run) */
  private readonly bendReceive = new Set<string>();
  /** a decided kick waiting for the ball to come back into touch reach —
   * released ON THE NEXT TOUCH, not after a dead trap (the 1.1s gather
   * latency closed every lane the decision had correctly picked) */
  private readonly pendingKicks = new Map<string, { dest: Vec2; speedMps: number; receiverId?: string; loftDeg?: number; spin?: number; knock?: boolean }>();

  constructor(def: ScenarioDef, seed: string) {
    if (def.version !== 1) {
      throw new Error(`unsupported scenario version ${String((def as { version: unknown }).version)} — this build reads v1`);
    }
    this.rng = new KeyedRng(`${def.name}|${seed}`);
    this.bodies = def.bodies.map((b) => ({
      id: b.id,
      team: b.team,
      attributes: { ...b.attributes },
      pos: { ...b.pos },
      vel: { x: 0, y: 0 },
      speed: 0,
      facing: b.facing ?? (b.pos.x <= 52.5 ? 0 : Math.PI),
      regime: 'walk',
      stance: 'settled',
      command: { type: 'hold' },
      pathIndex: 0,
      arrived: true,
      arrivedAtTick: 0,
    }));
    for (const b of this.bodies) {
      if (this.byId.has(b.id)) throw new Error(`duplicate body id ${b.id}`);
      this.byId.set(b.id, b);
      this.queues.set(b.id, []);
    }
    for (const b of def.bodies) {
      if (b.brain === 'onBall') this.brains.add(b.id);
      if (b.keeper) this.keepers.add(b.id);
      if (b.instructions) this.instructions.set(b.id, { ...b.instructions });
      this.homes.set(b.id, { ...b.pos });
    }
    for (const ev of def.script) {
      const body = this.byId.get(ev.bodyId);
      if (!body) throw new Error(`script references unknown body ${ev.bodyId}`);
      if ('atTick' in ev) {
        const list = this.atTick.get(ev.atTick) ?? [];
        list.push({ bodyId: ev.bodyId, command: ev.command });
        this.atTick.set(ev.atTick, list);
        this.scriptedUntil.set(ev.bodyId, Math.max(this.scriptedUntil.get(ev.bodyId) ?? -1, ev.atTick));
      } else {
        this.queues.get(ev.bodyId)!.push(ev.command);
      }
    }
    for (const k of def.kicks ?? []) {
      if (!this.byId.has(k.bodyId)) throw new Error(`kick references unknown body ${k.bodyId}`);
      const list = this.kicksAt.get(k.atTick) ?? [];
      list.push({ bodyId: k.bodyId, kick: k.kick });
      this.kicksAt.set(k.atTick, list);
    }
    this.bounds = def.bounds;
    const carrier = def.ball?.carrier ? this.byId.get(def.ball.carrier) : undefined;
    if (def.ball?.carrier && !carrier) throw new Error(`ball.carrier references unknown body ${def.ball.carrier}`);
    this.ball = {
      pos: carrier ? { ...carrier.pos } : { ...(def.ball?.pos ?? { x: PITCH.length / 2, y: PITCH.width / 2 }) },
      z: 0,
      vel: { x: 0, y: 0 },
      vz: 0,
      spin: 0,
      phase: carrier ? 'carried' : 'rolling',
      carrierId: carrier ? carrier.id : null,
      kickerId: null,
      kickerLockUntilTick: 0,
      touchParity: false,
    };
  }

  /** advance one tick; returns the full-rate frame for it */
  step(): Frame {
    // action labels are per-tick — clear them up front so brain-less scenarios
    // (which skip decidePhase) don't carry a stale header/block/handball label
    this.actionLabels.clear();
    // 1. scripted re-targets (replace the current command, keep the queue)
    const events = this.atTick.get(this.tick);
    if (events) {
      for (const ev of events) this.assign(this.byId.get(ev.bodyId)!, ev.command);
    }

    // 1b. L4 — the on-ball decision loop (after scripts: a scripted re-target
    // on a brainless body stands; the carrier's OWN command is decision-owned)
    this.decidePhase();

    // 1c. L7 — keepers self-position on the ball–goal line (after decide so a
    // keeper with the ball at his feet is decision- or script-owned that tick)
    if (this.keeperHolding && this.ball.carrierId !== this.keeperHolding) this.keeperHolding = null;
    if (this.keeperDropPass && this.ball.carrierId !== this.keeperDropPass.keeperId) this.keeperDropPass = null;
    if (this.beatExec && this.ball.carrierId !== this.beatExec.carrierId) this.beatExec = null;
    this.keeperPhase();

    // 2. bodies move; chaseBall runs to the INTERCEPT point (players
    // anticipate where a ball is going, they don't chase its tail), and a
    // carrier whose touch ran beyond reach STEERS to fetch it — the route is
    // the intent, the ball is the path
    // loose-ball claimant election (L5E arbitration)
    if (this.ball.carrierId === null && this.ball.phase !== 'dead') {
      for (const team of ['home', 'away'] as const) {
        let best: { id: string; score: number } | null = null;
        for (const b2 of this.bodies) {
          if (b2.team !== team || b2.command.type !== 'chaseBall') continue;
          const sc = Math.hypot(this.ball.pos.x - b2.pos.x, this.ball.pos.y - b2.pos.y) /
            Math.max(regimeCapMps(b2.attributes.pace, 'sprint'), 1);
          if (!best || sc < best.score) best = { id: b2.id, score: sc };
        }
        const cur = this.looseClaimant.get(team);
        if (!best) this.looseClaimant.delete(team);
        else if (!cur || cur.id === best.id ||
          !this.bodies.some((b2) => b2.id === cur.id && b2.command.type === 'chaseBall') ||
          best.score < cur.score - 0.3) {
          this.looseClaimant.set(team, best);
        } else {
          // the incumbent holds — refresh his score
          const inc = this.bodies.find((b2) => b2.id === cur.id)!;
          this.looseClaimant.set(team, {
            id: cur.id,
            score: Math.hypot(this.ball.pos.x - inc.pos.x, this.ball.pos.y - inc.pos.y) /
              Math.max(regimeCapMps(inc.attributes.pace, 'sprint'), 1),
          });
        }
      }
    } else {
      this.looseClaimant.clear();
    }
    this.liveTargets.clear();
    this.supportSides.clear();
    this.prevPos.clear();
    for (const body of this.bodies) {
      this.prevPos.set(body.id, { x: body.pos.x, y: body.pos.y });
    }
    for (const body of this.bodies) {
      const isCarrier = this.ball.carrierId === body.id;
      const gap = isCarrier
        ? Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y)
        : 0;
      const fetching = isCarrier && gap > BALL.controlRadiusM &&
        body.command.type !== 'chaseBall' && body.command.type !== 'hold';
      let live: Vec2 | undefined;
      let standing = false;
      let timedCap: number | undefined;
      let brakeIntoLine = false;
      let duelFace: Vec2 | undefined; // the jockey squares to the ball
      // machine OWNERSHIP (the principles pass): the elected presser
      // belongs to the duel machine FROM ELECTION — approach, ride, engage
      // as one continuum. The chaseBall gate parked the approaching presser
      // in moveTo where the machine never rode him (the covered-duel hole);
      // now the machine speaks per tick and the moveTo is only the
      // fallback when it stays silent (out of duel range).
      const duelRide = body.command.type !== 'chaseBall' && !fetching && !isCarrier &&
        this.pressingIds.has(body.id) && !this.keepers.has(body.id) &&
        this.ball.carrierId !== null && this.byId.get(this.ball.carrierId)!.team !== body.team;
      if (body.command.type === 'chaseBall' || fetching || duelRide) {
        const icept = this.interceptPoint(body);
        live = duelRide ? undefined : icept.pMeet;
        // the RECEIVE state machine (judged over eight rounds):
        //  off the line → attack the nearest path point (toward the ball),
        //    braking in when receiving; STICKY phase boundary — a threshold
        //    without hysteresis flapped the target every tick (the judged
        //    rapid right-left-right);
        //  on the line, ball near → STEP AT THE BALL for the final stride
        //    (standing a meter off, waiting, is not how touches are taken);
        //  on the line, ball still far → time the meet, set, watch it in.
        if (body.command.type === 'chaseBall') {
          // CONTESTED chases are RACES: an opponent carries the ball or is
          // hunting it too — sprint to be first, no timing, no final-stride
          // politeness (the receive machine cost the knock-past attacker
          // his race). Uncontested chases RECEIVE.
          const contested =
            (this.ball.carrierId !== null && this.byId.get(this.ball.carrierId)!.team !== body.team) ||
            this.bodies.some((o) => o.id !== body.id && o.team !== body.team && o.command.type === 'chaseBall');
          if (contested) {
            // race mode: run flat-out at the meet point (contain below still
            // takes over at contact range against a glued carrier). With the
            // ball ON TOP of him, step AT it — the 0.3 s reaction margin
            // makes imminent meets "unreachable" and pMeet jumps deep,
            // carving the racer off the line as the ball arrives at his feet
            this.receiveOnLine.delete(body.id);
            const dBall = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
            if (dBall <= 2.5) {
              live = { x: this.ball.pos.x, y: this.ball.pos.y };
            } else {
              live = icept.pMeet;
              // racing a LOOSE ball to the meet point: SET at it only when
              // COMFORTABLY early (momentum blew an early racer through the
              // line; but braking on marginal meets made lane-chasers
              // stutter under passes that beat them anyway). Chasers of a
              // CARRIED ball keep flying — braking gave them a
              // set-defender's pinch and broke the judged duel.
              if (this.ball.carrierId === null) {
                const dMeet = Math.hypot(icept.pMeet.x - body.pos.x, icept.pMeet.y - body.pos.y);
                const vcap = Math.max(regimeCapMps(body.attributes.pace, body.command.regime), 0.5);
                if (dMeet / vcap < icept.tMeet - 0.35) brakeIntoLine = true;
              }
            }
          } else if (this.bendReceive.has(body.id) && this.bendMeet(body)) {
            // a RUNNER receives ON THE RUN: bend (≤~70°) onto the ball's
            // path ahead at pace — never stop, never turn back for a ball
            // played into the run (hold-up is a pressured behavior)
            live = this.bendMeet(body)!;
            this.receiveOnLine.delete(body.id);
          } else if (this.inStrideMeet(body)) {
            // the RUNNER'S receive: his continued run meets the ball — take
            // it in stride, no timing, no brake (the judged check-and-wait:
            // the receiver anticipated at the meet point and the through
            // ball ran on behind him). Self-selecting: if full pace along
            // the current run does NOT meet the ball, the machine below
            // times it as before.
            live = this.inStrideMeet(body)!;
            this.receiveOnLine.delete(body.id);
          } else {
            let onLine = this.receiveOnLine.get(body.id) ?? false;
            if (!onLine && icept.lineDist <= 1.2) onLine = true;
            else if (onLine && icept.lineDist > 1.8) onLine = false;
            this.receiveOnLine.set(body.id, onLine);
            if (!onLine) {
              live = icept.pNear;
              // brake in when the meet is still ahead in TIME — or when the
              // ball is (near-)static: tNear is meaningless for a waiting
              // ball (first scan sample), and charging a sitting ball at
              // full speed was the judged 2.75 m overrun-and-return
              const ballV = Math.hypot(this.ball.vel.x, this.ball.vel.y);
              if (icept.tNear > 0.5 || ballV < 1.0) brakeIntoLine = true;
            } else if (icept.tMeet <= 1.2) {
              // the final stride: step INTO the arriving ball — aimed at the
              // CROSSING point nudged up-line (aiming at the ball's current
              // spot left a noisy pass's lateral gap unclosed: a judged
              // 3 cm miss at closest approach)
              const ux = this.ball.pos.x - icept.pNear.x;
              const uy = this.ball.pos.y - icept.pNear.y;
              const un = Math.hypot(ux, uy) || 1;
              live = { x: icept.pNear.x + (ux / un) * 0.5, y: icept.pNear.y + (uy / un) * 0.5 };
              timedCap = 2.4;
            } else {
              // EARLY on the line: COME TO the ball — advance along the path
              // toward it at a controlled pace. Timing the meet (slow, set,
              // stand, watch it in) was the judged wait-for-it-backwards: a
              // receiver shortens the pass, he doesn't spectate it. The final
              // stride above takes over as the ball arrives.
              const ux = this.ball.pos.x - body.pos.x;
              const uy = this.ball.pos.y - body.pos.y;
              const un = Math.hypot(ux, uy) || 1;
              live = { x: body.pos.x + (ux / un) * 2.0, y: body.pos.y + (uy / un) * 2.0 };
              timedCap = 2.4; // controlled — meeting a pass is not charging it
            }
          }
        }
        // loose-ball SUPPORT (L5E arbitration): the non-claimant does not
        // race his own mate onto the ball — he takes an offset spot to the
        // side, an outlet instead of a second pair of feet in the same yard
        if (body.command.type === 'chaseBall' && this.ball.carrierId === null) {
          const cl = this.looseClaimant.get(body.team);
          if (cl && cl.id !== body.id) {
            const claimant = this.byId.get(cl.id);
            if (claimant) {
              const lx = this.ball.pos.x - claimant.pos.x;
              const ly = this.ball.pos.y - claimant.pos.y;
              const ln = Math.hypot(lx, ly) || 1;
              // the side of the claimant→ball line this supporter is on
              const sside = Math.sign(-(body.pos.x - claimant.pos.x) * (ly / ln) +
                (body.pos.y - claimant.pos.y) * (lx / ln)) || 1;
              const dClaim = Math.hypot(body.pos.x - claimant.pos.x, body.pos.y - claimant.pos.y);
              let off = dClaim < 1.8 ? 6 : 4; // stacked bodies separate harder
              // DISTINCT spots: the second supporter on the same natural side
              // flips; a third extends — no twin runs
              const taken = this.supportSides.get(body.team) ?? [];
              let useSide = sside;
              if (taken.includes(useSide)) {
                if (!taken.includes(-useSide)) useSide = -useSide;
                else off += 3.5;
              }
              taken.push(useSide);
              this.supportSides.set(body.team, taken);
              live = {
                x: this.ball.pos.x - (ly / ln) * useSide * off,
                y: this.ball.pos.y + (lx / ln) * useSide * off,
              };
            }
          }
        }
        // the DUEL (L5E) wraps the judged contain: RECOVER/JOCKEY/TRACK own
        // the 2–8 m shell; ENGAGE commits the close; and inside 1.9 m the
        // contain-at-contact (the 360-orbit fix) stands exactly as judged.
        if ((body.command.type === 'chaseBall' || duelRide) && this.ball.carrierId !== null && !isCarrier) {
          const carrierB = this.byId.get(this.ball.carrierId)!;
          const gapBC = Math.hypot(this.ball.pos.x - carrierB.pos.x, this.ball.pos.y - carrierB.pos.y);
          const dToCar = Math.hypot(body.pos.x - carrierB.pos.x, body.pos.y - carrierB.pos.y);
          const containing = this.containBearing.has(body.id);
          // hysteresis: enter the press close-in, leave only when knocked
          // well out — a single threshold FLAPS (charge → bounce → charge),
          // thrashing a rotating bearing (the judged 360°)
          const contact = gapBC <= BALL.controlRadiusM && (dToCar <= 1.9 || (containing && dToCar <= 2.6));
          // activation LEADS the closing: a carrier driving AT this defender
          // extends the duel range by his closing speed — the defender starts
          // dropping early and meets him already moving goalward, never
          // flat-footed or stepping INTO a full-pace attacker
          const toMe0X = (body.pos.x - carrierB.pos.x) / Math.max(dToCar, 1e-6);
          const toMe0Y = (body.pos.y - carrierB.pos.y) / Math.max(dToCar, 1e-6);
          const closing0 = carrierB.vel.x * toMe0X + carrierB.vel.y * toMe0Y;
          const inDuel = carrierB.team !== body.team && !this.keepers.has(body.id) &&
            dToCar <= DUEL.activeRangeM + Math.max(0, closing0) * DUEL.activeCloseGainS;
          // the STAGGER outranks everything — a planted man is planted, even
          // in contact range (the contain was bypassing the beaten moment)
          const st0 = this.duels.get(body.id);
          if (st0?.state === 'staggered' && this.tick < (st0.plantedUntil ?? 0)) {
            standing = true;
            live = undefined;
            this.containBearing.delete(body.id);
          } else if (contact) {
            // contact IS engagement — promote the record so the tackle gate
            // opens (a stale jockey record was blocking tackles forever) —
            // unless he is in the BEATEN window (shadow, no lunge)
            const dr = this.duels.get(body.id);
            if (dr && this.tick >= (dr.beatenUntil ?? 0)) { dr.state = 'engage'; this.duels.set(body.id, dr); }
            let bearing = this.containBearing.get(body.id);
            if (bearing === undefined) {
              bearing = Math.atan2(body.pos.y - carrierB.pos.y, body.pos.x - carrierB.pos.x);
              this.containBearing.set(body.id, bearing);
            }
            // press point relative to the CARRIER, clear of his collision
            // disc — clipping it creeps the presser around tangentially
            const hold = TECH.bodyRadiusM * 2 + 0.35;
            live = { x: carrierB.pos.x + Math.cos(bearing) * hold, y: carrierB.pos.y + Math.sin(bearing) * hold };
            // at the press point: STAND (stop without completing the chase)
            if (Math.hypot(body.pos.x - live.x, body.pos.y - live.y) <= 0.45) standing = true;
          } else {
            this.containBearing.delete(body.id);
            if (inDuel) {
              const duel = this.duels.get(body.id) ?? { state: 'jockey' as const, pressure: 0, goalSide: false };
              if (duel.state === 'staggered') {
                if (this.tick < (duel.plantedUntil ?? 0)) {
                  standing = true; // planted — beaten, and it must cost
                  live = undefined;
                  this.duels.set(body.id, duel);
                } else {
                  duel.state = duel.goalSide ? 'jockey' : 'recover';
                  duel.pressure = 0;
                }
              }
              if (duel.state !== 'staggered') {
              const ownG = { x: attackSign(body.team) > 0 ? 0 : PITCH.length, y: GOAL.centerY };
              const gdC = Math.hypot(carrierB.pos.x - ownG.x, carrierB.pos.y - ownG.y);
              const gdD = Math.hypot(body.pos.x - ownG.x, body.pos.y - ownG.y);
              // side hysteresis: gain the side clearly, lose it only clearly
              duel.goalSide = duel.goalSide
                ? gdD <= gdC + DUEL.goalSideExitM
                : gdD <= gdC - DUEL.goalSideEnterM;
              // the patience meter — waiting is hoping for support; a
              // STOPPED carrier invites the lunge; cover behind emboldens
              let fill = DT / DUEL.pressureFillS;
              if (carrierB.speed < 0.8) fill *= DUEL.pressureStoppedFactor;
              // a carrier DRIVING AT YOUR GOAL cannot be waited out — urgency
              // scales with his goalward closing speed
              const gwSp = (carrierB.vel.x * (ownG.x - carrierB.pos.x) + carrierB.vel.y * (ownG.y - carrierB.pos.y)) / Math.max(gdC, 1e-6);
              fill *= 1 + Math.max(0, gwSp) / 3;
              if (this.bodies.some((m) => m.team === body.team && m.id !== body.id &&
                Math.hypot(m.pos.x - carrierB.pos.x, m.pos.y - carrierB.pos.y) < DUEL.dCoverM)) {
                fill *= DUEL.pressureSupportFactor;
              }
              duel.pressure = Math.min(1, duel.pressure + fill);
              // counterpress is innate aggression — no patience
              if (this.actionLabels.get(body.id) === 'counterpress') duel.pressure = Math.max(duel.pressure, 0.9);
              // transitions
              if (duel.state === 'engage') {
                if (dToCar > DUEL.engageEscapeM) {
                  duel.state = duel.goalSide ? 'jockey' : 'recover';
                  duel.pressure = DUEL.pressureResetOnEscape;
                }
              } else if (!duel.goalSide) {
                duel.state = 'recover';
              } else if (duel.pressure >= 1 && dToCar <= DUEL.engageM &&
                this.tick >= (duel.beatenUntil ?? 0)) {
                duel.state = 'engage';
              } else {
                // JOCKEY only while a square backpedal can hold the gap. Too
                // hot — the carrier escaping at pace OR closing faster than
                // ~3 m/s (a taxed backpedal is ~2-2.5) — and the hips TURN:
                // TRACK, running the give-ground line at full speed, squaring
                // up again when the closing calms. That alternation IS the
                // visible jockey dance.
                const toMeX = (body.pos.x - carrierB.pos.x) / Math.max(dToCar, 1e-6);
                const toMeY = (body.pos.y - carrierB.pos.y) / Math.max(dToCar, 1e-6);
                const closingSp = carrierB.vel.x * toMeX + carrierB.vel.y * toMeY;
                if (duel.state === 'track') {
                  duel.state = carrierB.speed < DUEL.trackExitMps && closingSp < 2.6 ? 'jockey' : 'track';
                } else {
                  duel.state = carrierB.speed > DUEL.trackEnterMps || closingSp > 3.2 ? 'track' : 'jockey';
                }
              }
              this.duels.set(body.id, duel);
              // targets — computed from the carrier's PROJECTED position
              // (0.4 s ahead): the jockey LEADS the retreat, matching the
              // advance instead of spooling up after the gap has crashed
              const cfx = carrierB.pos.x + carrierB.vel.x * 0.4;
              const cfy = carrierB.pos.y + carrierB.vel.y * 0.4;
              const gdF = Math.max(Math.hypot(cfx - ownG.x, cfy - ownG.y), 1e-6);
              const tgx = (ownG.x - cfx) / gdF;
              const tgy = (ownG.y - cfy) / gdF;
              if (duel.state === 'engage') {
                live = { x: this.ball.pos.x, y: this.ball.pos.y }; // commit — the contain takes it at 1.9
              } else if (duel.state === 'recover') {
                // never duel from the wrong side: cut the path AHEAD to regain it
                const ahead = Math.min(DUEL.recoverAheadM, gdF * 0.5);
                live = { x: cfx + tgx * ahead, y: cfy + tgy * ahead };
              } else {
                // JOCKEY / TRACK: on the carrier→goal line at the CURRENT
                // range, closing to the hold only as the carrier advances —
                // targeting the 2.0 m point directly meant a defender 6 m
                // goal-side ran forward INTO the carrier (the invisible
                // jockey): you GIVE GROUND square-on, you don't charge
                // NEVER approach a closing carrier (an attacker passes a
                // defender who is static or stepping toward him for free —
                // builder judgment): concede ground at a controlled rate and
                // let HIM close the gap to the hold; actively converge only
                // on an escaping/parallel carrier.
                const concede = closing0 > 0.5 ? 0.2 : 0.5;
                const range = Math.max(DUEL.holdM, Math.min(dToCar - concede, gdF - 0.5));
                live = { x: cfx + tgx * range, y: cfy + tgy * range };
                if (duel.state === 'track' && closing0 > 0.5) {
                  // the concede RATE is a speed: give ground at his pace minus
                  // ~1.7 m/s so the gap closes toward the hold under control —
                  // unbounded full-speed retreat was elastic (herded 20 m at a
                  // constant 8 m gap, never engaging)
                  timedCap = Math.min(timedCap ?? Infinity, Math.max(2.5, carrierB.speed - 1.7));
                }
                if (duel.state === 'jockey') {
                  // backpedal-capped, square to the ball (the L1 face-lock);
                  // TRACK is the full-speed escort — the cap alone donated a
                  // permanent 4 m trail vs a carrier at pace
                  timedCap = Math.min(timedCap ?? Infinity, DUEL.jockeyCapMps);
                  duelFace = { x: this.ball.pos.x, y: this.ball.pos.y };
                  if (Math.hypot(body.pos.x - live.x, body.pos.y - live.y) <= 0.4) standing = true;
                }
              }
              } // end !staggered
            } else {
              this.duels.delete(body.id);
            }
          }
        } else {
          this.duels.delete(body.id);
        }
        if (live !== undefined) this.liveTargets.set(body.id, live);
      }
      // the keeper's SHUFFLE: short repositioning stays square to the ball
      // (facing locked, the shuffle tax on speed); a long relocation — the
      // sweep, a big retreat — turns and runs like anyone
      let face: Vec2 | undefined = duelFace;
      if (this.keepers.has(body.id) && !isCarrier && !this.keeperAttacking.has(body.id)) {
        const kt = (body.command.type === 'chaseBall' ? live : undefined) ?? currentTarget(body);
        const goDist = kt ? Math.hypot(kt.x - body.pos.x, kt.y - body.pos.y) : 0;
        if (goDist <= BALL.keeperShuffleMaxM) face = { x: this.ball.pos.x, y: this.ball.pos.y };
      }
      stepBody(body, this.tick, {
        face,
        external: body.command.type === 'chaseBall' || duelRide ? live : undefined,
        steer: fetching ? live : undefined,
        carrying: isCarrier,
        carrySpeedCapMps: isCarrier
          ? (this.beatExec?.carrierId === body.id && this.beatExec.phase === 'approach'
            ? Math.min(this.dribbleArriveCap(body) ?? 4.2, 4.2)
            : this.dribbleArriveCap(body))
          : undefined,
        stand: standing,
        brakeAtTarget: timedCap !== undefined || brakeIntoLine,
        speedCapMps: timedCap,
      });
      // bodies stay on the park (L5E bounds): the playing area clamps them
      body.pos.x = Math.max(0.2, Math.min(PITCH.length - 0.2, body.pos.x));
      body.pos.y = Math.max(0.2, Math.min(PITCH.width - 0.2, body.pos.y));
      if (standing) {
        // a set receiver watches the ball in — a BRAIN receiver takes it on
        // the HALF-TURN: body opened between the incoming ball and his
        // anticipated next play, so the aligned first-time ball needs no
        // turn (the judged rondo truth: the skill is body shape, not trap)
        const toBall = Math.atan2(this.ball.pos.y - body.pos.y, this.ball.pos.x - body.pos.x);
        let want = toBall;
        const open = this.receiveOpenDir.get(body.id);
        if (open !== undefined) {
          const half = ((open - toBall + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          want = toBall + half * 0.5;
        }
        const delta = ((want - body.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        body.facing += Math.sign(delta) * Math.min(Math.abs(delta), 4.0 * DT);
      }
      if (body.arrived) {
        const next = this.queues.get(body.id)!.shift();
        if (next) this.assign(body, next);
      }
      // idle bodies WATCH THE PLAY: a hold with no facing target lazily
      // tracks the ball (a frozen post-pass facing reads as a mannequin)
      if (body.command.type === 'hold' && body.command.facing === undefined &&
        this.ball.carrierId !== body.id && body.speed < 1.0) {
        const toBall = Math.atan2(this.ball.pos.y - body.pos.y, this.ball.pos.x - body.pos.x);
        const d = ((toBall - body.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        body.facing += Math.sign(d) * Math.min(Math.abs(d), 3.0 * DT);
      }
    }

    // 2b. bodies are SOLID (soft): pairwise separation — nobody ghosts
    // through an opponent. Accumulate displacements, then apply (order-free).
    // iterated (a single pass cannot resolve three-body chains: a crowder
    // pushing the middle man INTO a third body squeezed past the floor);
    // total displacement per body per tick is CAPPED — iterations could
    // accumulate a 0.84 m teleport in dense press scrums
    const sepTotal = new Map<string, number>();
    for (let sepIter = 0; sepIter < 3; sepIter++) {
      const minSep = TECH.bodyRadiusM * 2;
      const push = new Map<string, Vec2>();
      for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          const a = this.bodies[i];
          const b = this.bodies[j];
          const dx = b.pos.x - a.pos.x;
          const dy = b.pos.y - a.pos.y;
          const d = Math.hypot(dx, dy);
          if (d >= minSep || d < 1e-9) continue;
          const overlap = Math.min((minSep - d) / 2, TECH.separationSpeedMps * DT);
          const nx = dx / d;
          const ny = dy / d;
          const pa = push.get(a.id) ?? { x: 0, y: 0 };
          const pb = push.get(b.id) ?? { x: 0, y: 0 };
          push.set(a.id, { x: pa.x - nx * overlap, y: pa.y - ny * overlap });
          push.set(b.id, { x: pb.x + nx * overlap, y: pb.y + ny * overlap });
          // velocity resolution: colliding bodies stop CLOSING — remove the
          // approaching components (inelastic shoulder contact, not a bounce)
          const closing = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
          if (closing > 0) {
            a.vel = { x: a.vel.x - nx * closing * 0.5, y: a.vel.y - ny * closing * 0.5 };
            b.vel = { x: b.vel.x + nx * closing * 0.5, y: b.vel.y + ny * closing * 0.5 };
            a.speed = Math.hypot(a.vel.x, a.vel.y);
            b.speed = Math.hypot(b.vel.x, b.vel.y);
          }
        }
      }
      for (const b of this.bodies) {
        const p = push.get(b.id);
        if (!p) continue;
        const used = sepTotal.get(b.id) ?? 0;
        const mag = Math.hypot(p.x, p.y);
        const allowed = Math.max(0, 0.5 - used);
        const k = mag > allowed ? allowed / (mag || 1) : 1;
        b.pos = { x: b.pos.x + p.x * k, y: b.pos.y + p.y * k };
        sepTotal.set(b.id, used + mag * k);
      }
    }

    // 3. scripted kicks — only the current carrier can strike, and only with
    // the ball at the boot (reach-gated — the audit item); execution noise
    // is attribute-driven (L3): the situation picks the kick, the feet decide
    // how faithfully it comes off
    const kicks = this.kicksAt.get(this.tick);
    if (kicks) {
      for (const k of kicks) {
        const kicker = this.byId.get(k.bodyId)!;
        const reach = Math.hypot(this.ball.pos.x - kicker.pos.x, this.ball.pos.y - kicker.pos.y);
        if (this.ball.carrierId === k.bodyId && reach <= TECH.kickReachM) {
          // scripted kicks stay facing-blind: the script IS the player's
          // intent, body shape included — the backheel penalty is for
          // DECIDED kicks (the chooser knows his own facing)
          const noisy = noisyKick(this.rng, this.tick, k.bodyId, kicker.attributes, k.kick.target, this.ball.pos, k.kick.speedMps);
          kickBall(this.ball, noisy.target, noisy.speedMps, k.kick.loftDeg, k.bodyId, this.tick, k.kick.spin ?? 0);
        }
      }
    }

    // 3b. tackles (L3): a hunting body (chaseBall) in reach of a GLUED ball
    // contests it physically — tackling+strength vs dribbling+balance. Won:
    // the ball is knocked loose away from the carrier. Lost: the tackler is
    // beaten and cools down before lunging again. Fouls arrive at L9.
    this.resolveTackles();

    // 4. carry coupling, then free-ball physics
    this.coupleCarry();
    const ballFrom = { x: this.ball.pos.x, y: this.ball.pos.y };
    const zFrom = this.ball.z; // pre-step height — the chest touch is a SWEPT z crossing
    stepBall(this.ball);
    // a ball over any boundary is DEAD where it crossed (restarts are L8's;
    // until then it must not roll to infinity — the L4 shot exposed this).
    // Drill BOUNDS count as boundaries too (positional grids).
    // L7 GOAL seam: a crossing of either END line between the posts, under the
    // bar, is a GOAL — recorded (the save/beaten measurement) before the ball
    // goes dead. Crossing point interpolated along this tick's swept path.
    const ob = this.bounds;
    // a CARRIED ball over a line is out too (L5E bounds): dribbling across
    // the touchline/grid edge does not keep the play alive — strip and kill
    if (this.ball.phase !== 'dead' && this.ball.carrierId !== null &&
      (this.ball.pos.x < 0 || this.ball.pos.x > PITCH.length ||
        this.ball.pos.y < 0 || this.ball.pos.y > PITCH.width ||
        (ob !== undefined && (this.ball.pos.x < ob.x0 || this.ball.pos.x > ob.x1 ||
          this.ball.pos.y < ob.y0 || this.ball.pos.y > ob.y1)))) {
      this.ball.carrierId = null;
    }
    if (this.ball.phase !== 'dead' && this.ball.carrierId === null &&
      (this.ball.pos.x < 0 || this.ball.pos.x > PITCH.length)) {
      const lineX = this.ball.pos.x < 0 ? 0 : PITCH.length;
      const dx = this.ball.pos.x - ballFrom.x;
      const t = Math.abs(dx) < 1e-9 ? 1 : (lineX - ballFrom.x) / dx;
      const yAt = ballFrom.y + (this.ball.pos.y - ballFrom.y) * Math.max(0, Math.min(1, t));
      const zAt = zFrom + (this.ball.z - zFrom) * Math.max(0, Math.min(1, t));
      if (Math.abs(yAt - GOAL.centerY) <= GOAL.mouthHalfWidthM && zAt <= GOAL.barZ) {
        // the team DEFENDING this end conceded (home attacks +x, defends x=0)
        this.goals.push({ tick: this.tick, against: lineX === 0 ? 'home' : 'away', y: yAt, z: zAt });
      }
    }
    if (this.ball.phase !== 'dead' && this.ball.carrierId === null &&
      (this.ball.pos.x < 0 || this.ball.pos.x > PITCH.length ||
        this.ball.pos.y < 0 || this.ball.pos.y > PITCH.width ||
        (ob !== undefined && (this.ball.pos.x < ob.x0 || this.ball.pos.x > ob.x1 ||
          this.ball.pos.y < ob.y0 || this.ball.pos.y > ob.y1)))) {
      this.ball.phase = 'dead';
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
    }

    // 5. loose-ball claims (and the chaseBall race resolution) — against the
    // ball's SWEPT PATH this tick, not its sampled endpoint: a 16 m/s ball
    // moves 1.6 m per tick and would otherwise tunnel through a claimant's
    // control disc without ever interacting
    // the keeper's HANDS come before anyone's head — he never heads a ball he
    // can hold (a dropping sweep was being weakly nodded into the arriving
    // runner by the header contest); above his catch ceiling the ball falls
    // through to the header contest, which is his punch
    this.resolveSaves(ballFrom);
    this.resolveHeaders(ballFrom);
    this.resolveChestControl(ballFrom, zFrom);
    this.resolveBlocks(ballFrom);
    this.resolveClaims(ballFrom);

    // L5d bookkeeping: possession flips arm the counterpress window; a
    // fresh carrier arms the press-the-touch trigger
    {
      const cb2 = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
      if (cb2) {
        if (this.prevCarrierTeam !== null && cb2.team !== this.prevCarrierTeam) {
          this.lostPossessionAt.set(this.prevCarrierTeam, this.tick);
        }
        if (this.prevCarrierTeam !== cb2.team || this.carrierSince < 0) this.carrierSince = this.tick;
        this.prevCarrierTeam = cb2.team;
      }
    }

    const frame = this.snapshot();
    this.tick++;
    return frame;
  }

  private readonly tackleCooldown = new Map<string, number>();
  /** contain bearings anchor when a press starts — re-deriving them each
   * tick is a feedback loop that walks the presser around the carrier */
  private readonly containBearing = new Map<string, number>();
  /** L5E — the duel state machine (design: L5E-DESIGN.md): per-defender state
   * vs the carrier he confronts. RECOVER (regain the side) / JOCKEY (hold
   * goal-side, capped, square to the ball) / TRACK (full-speed goal-side
   * escort of a carrier at pace) / ENGAGE (the committed close, resolved by
   * the contain + tackle machinery inside 1.9 m). The pressure meter is the
   * patience: it fills with jockey time, spikes on a stopped carrier. */
  /** L5E — loose-ball pursuit arbitration: ONE claimant per team per loose
   * ball (earliest arrival, 0.3 s re-election hysteresis); everyone else
   * SUPPORTS at an offset and stacked bodies separate. Two teammates racing
   * the same loose ball ended 0.7 m apart and each then intercepted the
   * other's pass to a third man (the corner flap's residual). */
  private readonly looseClaimant = new Map<'home' | 'away', { id: string; score: number }>();
  /** the BEAT in execution (L5E): approach (throttled, at the rider) →
   * feint (a step to the FAKE side, selling it to his smoothed read) →
   * burst (the knock through the real side). One carrier at a time. */
  private beatExec: { carrierId: string; fmId: string; phase: 'approach' | 'feint' | 'burst'; side: number; until: number } | null = null;
  /** support sides taken this tick — two supporters must NOT share a spot
   * (both computed the same natural side and made twin runs, judged) */
  private readonly supportSides = new Map<'home' | 'away', number[]>();
  private readonly duels = new Map<string, { state: 'recover' | 'jockey' | 'track' | 'engage' | 'staggered'; pressure: number; goalSide: boolean; plantedUntil?: number; beatenUntil?: number }>();
  /** pre-movement positions this tick — claims sweep the ball's path in the
   * RECEIVER'S FRAME (a charging receiver adds his own ~0.6 m/tick; testing
   * against his end position alone skips the reach window) */
  private readonly prevPos = new Map<string, Vec2>();
  /** sticky receive-phase state per chaser (hysteresis on the line band) */
  private readonly receiveOnLine = new Map<string, boolean>();

  /** the dribble-to-arrive push cap for this carrier's current stop-leg —
   * also the speed HE should ride at (you decelerate WITH your touch; a
   * probe showed a sprinter overrunning his dying touch straight into the
   * trailing defender's lap) */
  private dribbleArriveCap(carrier: BodyState): number | undefined {
    const cc = carrier.command;
    const legStops = cc.type === 'moveTo' ||
      (cc.type === 'followPath' && (cc.stopAtEach === true || carrier.pathIndex >= cc.points.length - 1));
    if (!legStops) return undefined;
    const dest = currentTarget(carrier);
    if (!dest) return undefined;
    const distToDest = Math.hypot(dest.x - this.ball.pos.x, dest.y - this.ball.pos.y);
    const cap = Math.sqrt(
      BALL.touchArriveResidualMps ** 2 + 2 * BALL.dribbleRollDecelMps2 * Math.max(0, distToDest),
    );
    return cap * 1.05;
  }

  /** the defenders currently planted by a failed lunge — the knock's window */
  private staggeredSet(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const [id, d] of this.duels) {
      if (d.state === 'staggered' && this.tick < (d.plantedUntil ?? 0)) out.add(id);
    }
    return out;
  }

  private resolveTackles(): void {
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    if (!carrier) return;
    // a keeper with the ball IN HIS HANDS is untouchable — no tackle exists
    // against a held ball (the pinch already cannot reach a glued ball)
    if (this.keeperHolding === carrier.id) return;
    const gap = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
    if (gap > BALL.controlRadiusM) return; // a running touch is the pinch's domain
    for (const b of this.bodies) {
      if (b.id === carrier.id || b.team === carrier.team) continue;
      if (b.command.type !== 'chaseBall') continue; // intent to win the ball
      if ((this.tackleCooldown.get(b.id) ?? -1) > this.tick) continue;
      // a DUELIST tackles only from ENGAGE — the committed close. Proximity
      // alone lunged on contact and skipped the jockey entirely (the machine
      // never got to be seen; bodies without a duel record tackle as before)
      const dst = this.duels.get(b.id);
      if (dst && dst.state !== 'engage') continue;
      const reach = Math.hypot(this.ball.pos.x - b.pos.x, this.ball.pos.y - b.pos.y);
      if (reach > TECH.tackleReachM) continue;
      this.tackleCooldown.set(b.id, this.tick + TECH.tackleCooldownTicks);
      const winP = tackleWinProbability(b.attributes, carrier.attributes) /
        (1 + TECH.tackleCarrierSpeedFactor * carrier.speed);
      // the failed lunge is the BEATEN moment (L5E): planted, and the
      // carrier's window to break past is real — without it the same 27%
      // tackle re-rolls into inevitability over any crawl
      if (!this.rng.chance(winP, this.tick, b.id, 'tackle')) {
        const st = this.duels.get(b.id) ?? { state: 'staggered' as const, pressure: 0, goalSide: false };
        st.state = 'staggered';
        st.pressure = 0;
        st.plantedUntil = this.tick + DUEL.staggerTicks;
        st.beatenUntil = this.tick + DUEL.beatenTicks;
        this.duels.set(b.id, st);
        this.containBearing.delete(b.id);
        this.actionLabels.set(b.id, 'staggered');
        continue;
      }
      {
        // the WON tackle: knocked loose AWAY from the carrier, scattered
        const away = Math.atan2(this.ball.pos.y - carrier.pos.y + (b.pos.y - carrier.pos.y) * -1,
          this.ball.pos.x - carrier.pos.x + (b.pos.x - carrier.pos.x) * -1);
        const dir = away + this.rng.gauss(0, TECH.tackleKnockScatterRad, this.tick, b.id, 'tackle-dir');
        const speed = TECH.tackleKnockMinMps +
          (TECH.tackleKnockMaxMps - TECH.tackleKnockMinMps) * this.rng.float(this.tick, b.id, 'tackle-v');
        this.ball.carrierId = null;
        this.ball.phase = 'rolling';
        this.ball.vel = { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed };
        // the DISPOSSESSED man cannot instantly re-claim the knock (the
        // kicker-refractory class of bug: without this the standing carrier
        // swept-claims the ball back within a tick and the win is undone)
        this.ball.kickerId = carrier.id;
        this.ball.kickerLockUntilTick = this.tick + 8;
      }
    }
  }

  /** the dribble loop: standing keeps the ball at the feet; a mover TOUCHES
   * the ball ahead along his heading whenever it is in reach; a ball that
   * escapes the gap is lost (possession is physics, not a flag) */
  private coupleCarry(): void {
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    if (!carrier) return;
    const d = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
    if (d > BALL.maxDribbleGapM) {
      this.ball.carrierId = null;
      this.ball.phase = 'rolling';
      return;
    }
    // the BALL clears the carrier's gates (checked every tick, in reach or
    // not): a touch leads the body through a waypoint, and a gate is served
    // when the ball reaches it OR has passed it relative to the onward route
    // — otherwise the next touch aims backward at a gate already behind
    const ccGate = carrier.command;
    if (ccGate.type === 'followPath') {
      while (carrier.pathIndex < ccGate.points.length - 1) {
        const wp = ccGate.points[carrier.pathIndex];
        const nxt = ccGate.points[carrier.pathIndex + 1];
        const near = Math.hypot(this.ball.pos.x - wp.x, this.ball.pos.y - wp.y) <= KIN.waypointTolM;
        const passed = (wp.x - this.ball.pos.x) * (nxt.x - wp.x) + (wp.y - this.ball.pos.y) * (nxt.y - wp.y) < 0;
        if (near || passed) carrier.pathIndex++;
        else break;
      }
    }
    // a decided kick releases ON THIS TOUCH — the ball is at the boot for one
    // contact and that contact is the pass/shot/clear. The reach for a PENDING
    // kick is a STRIDE (kickReachM), not the dribble's control disc: a man
    // running onto his own rolling touch strikes it FIRST-TIME as he meets it.
    // Gating it on the tighter control radius made a driving striker chase a
    // 6.8 m/s ball for a full second — carrying his decided shot from 16 m out
    // to point-blank into the keeper's gloves (the shot-angle finding).
    const pending = this.pendingKicks.get(carrier.id);
    const pendingAligned = pending !== undefined && (() => {
      const d = Math.atan2(pending.dest.y - carrier.pos.y, pending.dest.x - carrier.pos.x);
      return Math.abs(((d - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) <= DECIDE.strikeTurnThresholdRad;
    })();
    if (this.ball.z > BALL.claimMaxZ ||
      d > (pending && pendingAligned ? TECH.kickReachM : BALL.controlRadiusM)) return; // chasing his own touch
    if (pending && pendingAligned) {
      const noisy = noisyKick(this.rng, this.tick, carrier.id, carrier.attributes, pending.dest, this.ball.pos, pending.speedMps, carrier.facing);
      kickBall(this.ball, noisy.target, noisy.speedMps, pending.loftDeg ?? 0, carrier.id, this.tick, pending.spin ?? 0);
      if (pending.receiverId) {
        this.intendedReceiverId = pending.receiverId;
        this.lastGiveTick.set(carrier.id, this.tick);
      }
      this.pendingKicks.delete(carrier.id);
      this.intents.delete(carrier.id);
      this.assign(carrier, pending.knock ? { type: 'chaseBall', regime: 'sprint' } : { type: 'hold' });
      return;
    }
    // a GATHERING carrier (chaseBall) traps the ball dead instead of touching
    // it on — without this the coupling is a donkey-and-carrot: every close
    // knocks the ball ahead again and the chase never ends
    if (carrier.command.type === 'chaseBall') {
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
      this.ball.phase = 'carried';
      carrier.command = { type: 'hold' };
      carrier.arrived = true;
      carrier.arrivedAtTick = this.tick;
      const next = this.queues.get(carrier.id)!.shift();
      if (next) this.assign(carrier, next);
      return;
    }
    if (carrier.speed <= BALL.standingSpeedMps) {
      this.ball.vel = { x: 0, y: 0 };
      this.ball.vz = 0;
      this.ball.z = 0;
      this.ball.phase = 'carried';
      // shield bracing: rotate to put the body between ball and the nearest
      // presser (back-on) — the visible truth of a shield
      let brace: BodyState | null = null;
      let braceD = 2.2;
      for (const o of this.bodies) {
        if (o.team === carrier.team) continue;
        const od = Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y);
        if (od < braceD) {
          braceD = od;
          brace = o;
        }
      }
      if (brace) {
        const away = Math.atan2(carrier.pos.y - brace.pos.y, carrier.pos.x - brace.pos.x);
        const delta = ((away - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        carrier.facing += Math.sign(delta) * Math.min(Math.abs(delta), 3.5 * DT);
      }
      return;
    }
    // a touch is AIMED AT THE ROUTE (you push the ball toward where you are
    // going, not along your momentary velocity — otherwise a fetch-steering
    // carrier and his own touch run in a straight line forever), with the
    // alternating-feet nudge for the left-right texture of a real dribble
    const routeTarget = currentTarget(carrier);
    const baseHeading = routeTarget
      ? Math.atan2(routeTarget.y - this.ball.pos.y, routeTarget.x - this.ball.pos.x)
      : Math.atan2(carrier.vel.y, carrier.vel.x);
    // far-foot dribbling: near a marker the touch biases AWAY from him
    // (alternating feet would play every second ball into his reach); free
    // of pressure, the feet alternate for the natural weave
    let lateral = (this.ball.touchParity ? 1 : -1) * BALL.touchAlternateRad;
    this.ball.touchParity = !this.ball.touchParity;
    let nearestOpp: BodyState | null = null;
    let nearestD: number = BALL.touchShieldRangeM;
    for (const o of this.bodies) {
      if (o.team === carrier.team) continue;
      const od = Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y);
      if (od < nearestD) {
        nearestD = od;
        nearestOpp = o;
      }
    }
    if (nearestOpp) {
      // side of the route line the opponent is on → push the other way
      const side = Math.sign(
        Math.cos(baseHeading) * (nearestOpp.pos.y - carrier.pos.y) -
        Math.sin(baseHeading) * (nearestOpp.pos.x - carrier.pos.x),
      ) || 1;
      lateral = -side * BALL.touchShieldRad;
    }
    const heading = baseHeading + lateral;
    const vmax = topSpeedMps(carrier.attributes.pace);
    let push = carrier.speed * (
      BALL.touchPushBase +
      BALL.touchPushSpeedGain * (carrier.speed / vmax) +
      BALL.touchPushControlGain * (1 - carrier.attributes.dribbling / 20)
    );
    // dribble-to-arrive: the touch is weighted for the carrier's own route —
    // a ball pushed at cruise weight into his braking zone would roll meters
    // past the stop he is about to make. Only legs that END IN A STOP are
    // weighted; a slalom gate is dribbled THROUGH, not braked at.
    const cc = carrier.command;
    const legStops = cc.type === 'moveTo' ||
      (cc.type === 'followPath' && (cc.stopAtEach === true || carrier.pathIndex >= cc.points.length - 1));
    const dest = legStops ? currentTarget(carrier) : null;
    if (dest) {
      const distToDest = Math.hypot(dest.x - this.ball.pos.x, dest.y - this.ball.pos.y);
      push = Math.min(push, Math.sqrt(
        BALL.touchArriveResidualMps ** 2 + 2 * BALL.dribbleRollDecelMps2 * Math.max(0, distToDest),
      ));
    }
    // pressure-shortened touches: a defender set AHEAD caps the roll-out to
    // a control-scaled fraction of the gap — you don't push a cruise-weight
    // ball into the man in front of you (riding the shorter dying touch
    // also slows the carrier into the duel, which is the real approach)
    let press: BodyState | null = null;
    let pressD: number = BALL.pressAwareRangeM;
    for (const o of this.bodies) {
      if (o.team === carrier.team) continue;
      const dx = o.pos.x - carrier.pos.x;
      const dy = o.pos.y - carrier.pos.y;
      const od = Math.hypot(dx, dy);
      if (od >= pressD || od < 1e-6) continue;
      if ((dx * Math.cos(heading) + dy * Math.sin(heading)) / od < BALL.pressAwareConeCos) continue;
      press = o;
      pressD = od;
    }
    if (press) {
      const frac = BALL.pressRollFracBase -
        BALL.pressRollFracControlGain * (carrier.attributes.dribbling / 20);
      const rollMax = Math.max(BALL.pressRollMinM, pressD * frac);
      push = Math.min(push, Math.sqrt(
        BALL.touchArriveResidualMps ** 2 + 2 * BALL.dribbleRollDecelMps2 * rollMax,
      ));
    }
    this.ball.vel = { x: Math.cos(heading) * push, y: Math.sin(heading) * push };
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.phase = 'carried';
  }

  /** the AERIAL CONTEST — a ball in the header band is challenged in the AIR:
   * bodies within a leap contest it (closer + stronger + a little agility,
   * with a coin-flip of noise), the winner heads it. A DEFENDER near his own
   * goal clears it upfield; an ATTACKER near the opponent goal heads at goal;
   * otherwise a knock-DOWN drops it at his feet to control. This is what makes
   * a loft OVER a defender honest — one standing under it heads it away. */
  /** closest horizontal approach of a body to the ball's swept path this tick,
   * in the body's own frame so a fast ball can't tunnel past his reach between
   * ticks. Shared by the header and the collision — one detection model. */
  private sweptApproach(body: BodyState, from: Vec2): { d: number; at: Vec2 } {
    const ball = this.ball;
    const prev = this.prevPos.get(body.id) ?? body.pos;
    const fx = from.x - (body.pos.x - prev.x);
    const fy = from.y - (body.pos.y - prev.y);
    const dx = ball.pos.x - fx;
    const dy = ball.pos.y - fy;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((body.pos.x - fx) * dx + (body.pos.y - fy) * dy) / len2));
    const at = { x: fx + dx * t, y: fy + dy * t };
    return { d: Math.hypot(body.pos.x - at.x, body.pos.y - at.y), at };
  }

  private resolveHeaders(from: Vec2): void {
    const ball = this.ball;
    if (ball.phase !== 'airborne' || ball.z < BALL.headMinZ || ball.z > BALL.headMaxZ) return;
    let best: { body: BodyState; score: number } | null = null;
    for (const body of this.bodies) {
      if (body.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      // SWEPT reach, like the collision — a fast ball can't tunnel past the
      // leap between ticks (else a rocket at head height reads as a scrambled
      // block instead of the clean header a man standing under it wins)
      const d = this.sweptApproach(body, from).d;
      if (d > BALL.headReachM) continue;
      if (ball.z > BALL.headStandM + BALL.headJumpPerStr * body.attributes.strength) continue; // can't leap to it
      const score = -d + 0.08 * body.attributes.strength + 0.05 * body.attributes.agility +
        this.rng.gauss(0, BALL.headContestNoise, this.tick, body.id, 'header');
      if (!best || score > best.score) best = { body, score };
    }
    if (!best) return;
    const w = best.body;
    // the header REDIRECTS the ball's pace — power from the BALL, plus a
    // strength term the header EARNS by attacking the ball: his approach/leap
    // speed into it. A passive nod under a weak lob adds almost nothing; a
    // committed header drives through it. A fast cross → a powerful header
    // whichever way, because the ball's pace dominates.
    const incoming = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    const attack = Math.max(BALL.headPassiveFloor, Math.min(1, w.speed / BALL.headAttackRefMps));
    const headed = incoming * BALL.headRedirect + BALL.headPlayerPower * (w.attributes.strength / 20) * attack;
    const sign = attackSign(w.team);
    const ownGoal = { x: sign > 0 ? 0 : PITCH.length, y: PITCH.width / 2 };
    const oppGoal = goalCenter(w.team);
    const dOwn = Math.hypot(ownGoal.x - w.pos.x, ownGoal.y - w.pos.y);
    const dOpp = Math.hypot(oppGoal.x - w.pos.x, oppGoal.y - w.pos.y);
    if (dOwn < 35) {
      // DEFENSIVE clearance — lofted, far, upfield, with wide direction noise
      const ang = (sign > 0 ? 0 : Math.PI) + this.rng.gauss(0, BALL.headClearScatterRad, this.tick, w.id, 'head-clear');
      kickBall(ball, { x: w.pos.x + Math.cos(ang) * 30, y: w.pos.y + Math.sin(ang) * 30 }, headed, BALL.headClearLoftDeg, w.id, this.tick);
      this.actionLabels.set(w.id, 'header-clear');
    } else if (dOpp < 14) {
      // ATTACKING header at goal — a driven strike, slight noise, low
      const ang = Math.atan2(oppGoal.y - w.pos.y, oppGoal.x - w.pos.x) + this.rng.gauss(0, 0.12, this.tick, w.id, 'head-goal');
      kickBall(ball, { x: w.pos.x + Math.cos(ang) * 20, y: w.pos.y + Math.sin(ang) * 20 }, headed, 8, w.id, this.tick);
      this.actionLabels.set(w.id, 'header-goal');
    } else {
      this.actionLabels.set(w.id, 'header-down');
      // KNOCK-DOWN — cushion the pace OUT (a controlled header down to feet:
      // no kicker lock, he plays it next tick; an opponent may still contest)
      ball.z = 0;
      ball.vz = 0;
      ball.phase = 'rolling';
      ball.carrierId = null;
      ball.kickerId = null;
      ball.vel = { x: sign * incoming * BALL.headKnockCushion, y: this.rng.gauss(0, 1, this.tick, w.id, 'head-knock') };
    }
  }

  /** CHEST / THIGH control — the 0.5–0.9 m gap between the ground first touch
   * and the header. A receiver GOING FOR a fast airborne ball takes it on the
   * chest: a good touch cushions it down to his feet (control), a poor one
   * (fast / high / pressured) BOUNCES OFF him loose. This is the receive's
   * middle band — distinct from the header (a deliberate leap, ≥0.9 m), the
   * collision (a PASSIVE obstacle caroming it), and the ground first touch
   * (≤0.5 m). Only a man attacking the ball — the intended man or a chaser —
   * reaches to control it; a passer merely in the way still caroms (collision).
   * Runs after the header, before the collision, so the receiver's touch beats
   * an obstacle's carom on the same ball. */
  private resolveChestControl(from: Vec2, zFrom: number): void {
    const ball = this.ball;
    if (ball.phase === 'dead' || ball.phase === 'carried') return;
    // the ball's z-path this tick CROSSED the chest band — at 10 Hz a fast ball
    // spans it in one tick (rising or falling through), so an instantaneous-z
    // gate never catches it; the swept crossing does. Only a FAST ball is a
    // chest challenge — a slow drop is let fall and controlled on the ground.
    const zLo = Math.min(zFrom, ball.z);
    const zHi = Math.max(zFrom, ball.z);
    const crossedChest = zLo < BALL.headMinZ && zHi > BALL.claimMaxZ;
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    if (!crossedChest || speed < BALL.blockMinSpeedMps) return;
    let best: { body: BodyState; d: number; at: Vec2 } | null = null;
    for (const body of this.bodies) {
      if (body.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      // only a man ATTACKING the ball chests it — the intended man or a chaser
      if (body.id !== this.intendedReceiverId && body.command.type !== 'chaseBall') continue;
      const { d, at } = this.sweptApproach(body, from);
      if (d > BALL.controlRadiusM) continue;
      if (!best || d < best.d) best = { body, d, at };
    }
    if (!best) return;
    const w = best.body;
    const ballSpeed = Math.hypot(ball.vel.x - w.vel.x, ball.vel.y - w.vel.y);
    const rawSpeed = Math.hypot(ball.vel.x, ball.vel.y);
    const arrivalDir = rawSpeed > 0.1 ? Math.atan2(ball.vel.y, ball.vel.x) : w.facing;
    const pressured = this.bodies.some((o) => o.team !== w.team &&
      Math.hypot(o.pos.x - w.pos.x, o.pos.y - w.pos.y) <= TECH.touchPressureRangeM);
    // the first touch, judged at CHEST height (the band midpoint — the ball
    // swept through it this tick even if it ended at his feet). resolveFirstTouch
    // makes a higher, faster ball harder, so a driven pass to the chest pops more
    const chestZ = (BALL.claimMaxZ + BALL.headMinZ) / 2;
    const touch = resolveFirstTouch(
      this.rng, this.tick, w.id, w.attributes, arrivalDir, ballSpeed, chestZ, pressured, w.speed,
    );
    ball.pos = { x: best.at.x, y: best.at.y };
    ball.vz = 0;
    ball.z = 0;
    if (touch.pop) {
      // it BOUNCES OFF his chest — a failed control, loose and low; he cannot
      // instantly re-claim his own miss (the same refractory the ground pop uses)
      ball.carrierId = null;
      ball.phase = 'rolling';
      ball.vel = touch.vel;
      ball.kickerId = w.id;
      ball.kickerLockUntilTick = this.tick + 8;
      this.actionLabels.set(w.id, 'chest-miss');
      return;
    }
    // CUSHIONED down to his feet — controlled
    ball.carrierId = w.id;
    ball.phase = 'carried';
    this.completeChases(w.team);
    this.actionLabels.set(w.id, 'chest');
  }

  /** L7 — ANGLE PLAY: the keeper holds the ball–goal line at depth, shading to
   * the ball's angle, clamped to the frame's shadow. He owns his own movement. */
  private keeperPhase(): void {
    if (this.keepers.size === 0) return;
    for (const id of this.keepers) {
      const k = this.byId.get(id);
      if (!k) continue;
      this.keeperAttacking.delete(id);
      const sign = attackSign(k.team);
      const own = { x: sign > 0 ? 0 : PITCH.length, y: GOAL.centerY };
      if (this.ball.carrierId === id) {
        // OUTSIDE his box he is a defender under pressure — the sweep's
        // ending is a FIRST-TIME clear upfield, not a gather-and-carry
        const outsideBox = Math.abs(this.ball.pos.x - own.x) > GOAL.boxDepthM ||
          Math.abs(this.ball.pos.y - GOAL.centerY) > GOAL.boxHalfWidthM;
        if (outsideBox) {
          const upAng = (sign > 0 ? 0 : Math.PI) +
            this.rng.gauss(0, 0.3, this.tick, id, 'k-clear');
          kickBall(this.ball, { x: k.pos.x + Math.cos(upAng) * 30, y: k.pos.y + Math.sin(upAng) * 30 },
            16, 25, id, this.tick);
          this.actionLabels.set(id, 'keeper-clear');
          continue;
        }
        // a DROP-TO-FEET pass mid-flow: the ball is DOWN (immunity off, he is
        // tackleable) — strike the ground pass after the beat, or pick it
        // straight back up if a presser closes in
        if (this.keeperDropPass?.keeperId === id) {
          const dp = this.keeperDropPass;
          const pressed = this.bodies.some((o) => o.team !== k.team &&
            Math.hypot(o.pos.x - k.pos.x, o.pos.y - k.pos.y) < 3.5);
          if (pressed) {
            this.keeperDropPass = null;
            this.keeperHolding = id; // back into the hands — safety first
            this.keeperHeldSince = this.tick;
          } else if (this.tick >= dp.strikeTick) {
            this.keeperDropPass = null;
            const m = this.byId.get(dp.mateId);
            if (m) {
              const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
              const lead = { x: m.pos.x + m.vel.x * 0.4, y: m.pos.y + m.vel.y * 0.4 };
              // the ground-kick MENU, honestly derived from this pitch's
              // friction: a weighted roll dies by ~20 m; the low GRASS CUTTER
              // (5°, skimming) carries pace to ~30; beyond that only the
              // PINGED 16° driven ball arrives alive (a rolled ball is dead by
              // 38, and an 8° delivery needed an uncontrollable rocket)
              if (dm > 30) {
                kickBall(this.ball, lead, solveLoftSpeed(Math.max(6, dm - 5), 16), 16, id, this.tick);
              } else if (dm > 20) {
                kickBall(this.ball, lead, 26, 5, id, this.tick); // the grass cutter
              } else {
                kickBall(this.ball, lead, Math.max(8, Math.min(19, rollLaunchForArrival(5, dm))), 0, id, this.tick);
              }
              this.intendedReceiverId = m.id;
              this.actionLabels.set(id, 'keeper-pass');
            }
          } else if (k.command.type !== 'hold') {
            this.assign(k, { type: 'hold' });
          }
          continue;
        }
        // INSIDE his box a settled ball at his feet is PICKED UP — held in
        // both hands he is untouchable (no tackle exists against a held ball)
        if (this.keeperHolding !== id) {
          this.keeperHolding = id;
          this.keeperHeldSince = this.tick;
        }
        if (k.command.type !== 'hold') this.assign(k, { type: 'hold' });
        // DISTRIBUTION: a beat to settle, then — the nearest OPEN mate in
        // throw range gets the fast flat THROW; an open mate beyond it (inside
        // kick range, nobody pressing) earns the DROP TO FEET and a ground
        // pass; nobody at all → the PUNT long
        if (this.tick - this.keeperHeldSince >= BALL.keeperHoldTicks) {
          // the throw must SURVIVE moving opponents, not just a static lane —
          // a pressing striker ran down every "clear-at-release" throw. The
          // arrival-race model (passCompletion) is the honest judge.
          const opps = this.bodies.filter((o) => o.team !== k.team);
          let best: { mate: BodyState; d: number } | null = null;
          for (const m of this.bodies) {
            if (m.team !== k.team || m.id === id) continue;
            const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
            if (dm < BALL.keeperThrowMinM || dm > BALL.keeperThrowMaxM) continue;
            const marked = this.bodies.some((o) => o.team !== k.team &&
              Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4);
            if (marked) continue;
            // a throw ARRIVES with pace — weighted like a real pass, not a
            // lob that dies in the middle third as a 50/50 with the presser
            const spd = Math.max(8, Math.min(16, rollLaunchForArrival(5, dm)));
            if (passCompletion(k.pos, m.pos, spd, opps, dm, m, 14) < 0.72) continue;
            if (!best || dm < best.d) best = { mate: m, d: dm };
          }
          // beyond flat-throw range, two long options split by PRESSURE: the
          // LOOPING over-arm throw (from the hands — immunity intact, the
          // pressed keeper's reach, near the halfway line) and the drop-kick
          // (unpressed — composed, more range and pace)
          const safe = !this.bodies.some((o) => o.team !== k.team &&
            Math.hypot(o.pos.x - k.pos.x, o.pos.y - k.pos.y) < BALL.keeperDropSafeM);
          let loop: { mate: BodyState; d: number } | null = null;
          if (!best && !safe) {
            for (const m of this.bodies) {
              if (m.team !== k.team || m.id === id) continue;
              const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
              if (dm <= BALL.keeperThrowMaxM || dm > BALL.keeperLoopThrowMaxM) continue;
              if (solveLoftSpeed(dm, BALL.keeperLoopThrowLoftDeg) > BALL.keeperLoopThrowSpeedMax) continue;
              const marked = this.bodies.some((o) => o.team !== k.team &&
                Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4);
              if (marked) continue;
              const landing = {
                x: m.pos.x - ((m.pos.x - k.pos.x) / dm) * 3,
                y: m.pos.y - ((m.pos.y - k.pos.y) / dm) * 3,
              };
              if (aerialCompletion(landing, m, opps) < 0.6) continue;
              if (!loop || dm < loop.d) loop = { mate: m, d: dm };
            }
          }
          let kickable: { mate: BodyState; d: number } | null = null;
          if (!best && !loop) {
            if (safe) {
              for (const m of this.bodies) {
                if (m.team !== k.team || m.id === id) continue;
                const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
                if (dm <= BALL.keeperThrowMaxM || dm > BALL.keeperKickMaxM) continue;
                const marked = this.bodies.some((o) => o.team !== k.team &&
                  Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4);
                if (marked) continue;
                // the driven low ball FLIES most of the way and skids the last
                // metres — the rolling race model can't represent it (a rolled
                // 19 m/s ball is dead at 37 m and rated near-zero). The gate is
                // the ARRIVAL RACE AT THE LANDING, as crosses use.
                const landing = {
                  x: m.pos.x - ((m.pos.x - k.pos.x) / dm) * 5,
                  y: m.pos.y - ((m.pos.y - k.pos.y) / dm) * 5,
                };
                if (aerialCompletion(landing, m, opps) < 0.6) continue;
                if (!kickable || dm < kickable.d) kickable = { mate: m, d: dm };
              }
            }
          }
          this.keeperHolding = null;
          if (best) {
            // the THROW — flat, fast, to feet, weighted by range
            const lead = { x: best.mate.pos.x + best.mate.vel.x * 0.4, y: best.mate.pos.y + best.mate.vel.y * 0.4 };
            kickBall(this.ball, lead, Math.max(8, Math.min(16, rollLaunchForArrival(5, best.d))), BALL.keeperThrowLoftDeg, id, this.tick);
            this.intendedReceiverId = best.mate.id;
            this.actionLabels.set(id, 'throw');
          } else if (loop) {
            // the LOOPING throw — over-arm, arcing to the far man, released
            // from the hands under press
            const lead = { x: loop.mate.pos.x + loop.mate.vel.x * 0.6, y: loop.mate.pos.y + loop.mate.vel.y * 0.6 };
            const dl = Math.hypot(lead.x - k.pos.x, lead.y - k.pos.y);
            kickBall(this.ball, lead, Math.min(BALL.keeperLoopThrowSpeedMax, solveLoftSpeed(dl, BALL.keeperLoopThrowLoftDeg)),
              BALL.keeperLoopThrowLoftDeg, id, this.tick);
            // an over-arm throw RELEASES HIGH (~2.3 m): launched from the
            // grass, the arc passed through head height exactly where the
            // presser stood — he nodded the fresh throw straight back at goal
            this.ball.z = 2.3;
            this.intendedReceiverId = loop.mate.id;
            this.actionLabels.set(id, 'loop-throw');
          } else if (kickable) {
            // the DROP — ball to his feet (tackleable now), the pass follows
            this.keeperDropPass = { keeperId: id, mateId: kickable.mate.id, strikeTick: this.tick + BALL.keeperDropTicks };
            this.actionLabels.set(id, 'drop');
          } else {
            // the PUNT — kicked from the hands, AIMED: the most advanced OPEN
            // mate (a runner breaking for the counter) is led by the punt's
            // hang time; only with nobody upfield does it go long to space
            let counter: { mate: BodyState; d: number } | null = null;
            for (const m of this.bodies) {
              if (m.team !== k.team || m.id === id) continue;
              const up = (m.pos.x - k.pos.x) * sign;
              if (up < 15) continue; // a counter target is genuinely upfield
              const dm = Math.hypot(m.pos.x - k.pos.x, m.pos.y - k.pos.y);
              if (dm > 68) continue;
              const open = !this.bodies.some((o) => o.team !== k.team &&
                Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 5);
              if (!open) continue;
              if (!counter || up > (counter.mate.pos.x - k.pos.x) * sign) counter = { mate: m, d: dm };
            }
            if (counter) {
              // a flatter, faster punt for the counter — led into the run
              const spd0 = solveLoftSpeed(counter.d, 28);
              const hang = loftFlightTimeS(spd0, 28);
              const lead = {
                x: counter.mate.pos.x + counter.mate.vel.x * hang,
                y: Math.max(4, Math.min(PITCH.width - 4, counter.mate.pos.y + counter.mate.vel.y * hang)),
              };
              const dLead = Math.hypot(lead.x - k.pos.x, lead.y - k.pos.y);
              kickBall(this.ball, lead, Math.min(32, solveLoftSpeed(dLead, 28)), 28, id, this.tick);
              this.intendedReceiverId = counter.mate.id;
              this.actionLabels.set(id, 'punt');
            } else {
              const upAng = (sign > 0 ? 0 : Math.PI) +
                this.rng.gauss(0, BALL.keeperPuntScatterRad, this.tick, id, 'punt');
              const target = {
                x: k.pos.x + Math.cos(upAng) * 55,
                y: Math.max(8, Math.min(PITCH.width - 8, k.pos.y + Math.sin(upAng) * 55)),
              };
              kickBall(this.ball, target, BALL.keeperPuntSpeed, BALL.keeperPuntLoftDeg, id, this.tick);
              this.actionLabels.set(id, 'punt');
            }
          }
        }
        continue;
      }
      // the DIVE: a live shot at his goal — after his reaction, he attacks the
      // shot's LINE (its closest point to him) flat out; corners beat the
      // reaction, straight ones don't (why placement matters). A shot is
      // MOUTH-BOUND: its line crosses the goal plane between the posts — a
      // fast through ball rolling for the corner is a ball to SWEEP, not dive at
      const towardGoal = this.ball.vel.x * (own.x - this.ball.pos.x) > 0;
      const yAtGoal = towardGoal && Math.abs(this.ball.vel.x) > 0.5
        ? this.ball.pos.y + this.ball.vel.y * ((own.x - this.ball.pos.x) / this.ball.vel.x)
        : Infinity;
      // ...and IMMINENT: reaching the goal line within ~1.3 s. A 55 m diagonal
      // whose line happens to cross the mouth is a ball to sweep, not a shot.
      const tToGoal = towardGoal && Math.abs(this.ball.vel.x) > 0.5
        ? (own.x - this.ball.pos.x) / this.ball.vel.x : Infinity;
      const shotThreat = this.ball.carrierId === null && this.ball.phase !== 'dead' &&
        Math.hypot(this.ball.vel.x, this.ball.vel.y, this.ball.vz) >= BALL.blockMinSpeedMps &&
        Math.hypot(this.ball.pos.x - own.x, this.ball.pos.y - own.y) <= BALL.keeperEngageM &&
        towardGoal && this.ball.z <= GOAL.barZ && tToGoal < 1.3 &&
        Math.abs(yAtGoal - GOAL.centerY) <= GOAL.mouthHalfWidthM + 1.2;
      if (shotThreat) {
        const seen = this.keeperShotSeen.get(id) ?? this.tick;
        this.keeperShotSeen.set(id, seen);
        if (this.tick - seen >= BALL.keeperReactTicks) {
          const vx = this.ball.vel.x, vy = this.ball.vel.y;
          const v2 = Math.max(vx * vx + vy * vy, 1e-9);
          const t = Math.max(0, ((k.pos.x - this.ball.pos.x) * vx + (k.pos.y - this.ball.pos.y) * vy) / v2);
          const dive = { x: this.ball.pos.x + vx * t, y: this.ball.pos.y + vy * t };
          const cur = k.command.type === 'moveTo' ? k.command.target : null;
          if (!cur || Math.hypot(cur.x - dive.x, cur.y - dive.y) > 0.2) {
            this.assign(k, { type: 'moveTo', target: dive, regime: 'sprint' });
          }
          continue;
        }
      } else {
        this.keeperShotSeen.delete(id);
      }
      // the CHIP READ: a ball ARCING OVER HIM toward his goal — above the bar
      // right now (so no shot gate sees it) but dropping at the mouth. He
      // turns and SPRINTS for his line to contest the drop; the save races it.
      const dBallGoal = Math.hypot(this.ball.pos.x - own.x, this.ball.pos.y - own.y);
      const ballCarrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
      if (ballCarrier === undefined && this.ball.phase === 'airborne' &&
        this.ball.z > GOAL.barZ && this.ball.vel.x * (own.x - this.ball.pos.x) > 0) {
        const kickerB = this.ball.kickerId ? this.byId.get(this.ball.kickerId) : undefined;
        if (kickerB && kickerB.team !== k.team) {
          const chipPred = predictBall(this.ball, 2.5);
          const dPredMouth = Math.hypot(chipPred.x - own.x, chipPred.y - own.y);
          if (dPredMouth < 8) {
            this.keeperAttacking.add(id); // a flat-out backpedal race, no shuffle
            const spot = { x: own.x + (sign > 0 ? 0.8 : -0.8), y: GOAL.centerY };
            const cur = k.command.type === 'moveTo' ? k.command.target : null;
            if (!cur || Math.hypot(cur.x - spot.x, cur.y - spot.y) > 0.3) {
              this.assign(k, { type: 'moveTo', target: spot, regime: 'sprint' });
            }
            continue;
          }
        }
      }
      // the SWEEP-CHASE: a free ball IN (or dropping into) his zone that is
      // not a shot — the through ball in behind, the loose roll. He leaves his
      // line and attacks it; interceptPoint drives him to the drop and
      // resolveClaims/resolveSaves do the pickup. Gated on the PREDICTED ball
      // (waiting for it to slow or arrive gave the runner a 2 s head start).
      if (ballCarrier === undefined && this.ball.phase !== 'dead') {
        const pred = predictBall(this.ball, 2.0);
        const dPredGoal = Math.hypot(pred.x - own.x, pred.y - own.y);
        if (Math.min(dBallGoal, dPredGoal) < BALL.keeperSweepChaseM) {
          const kD = Math.hypot(this.ball.pos.x - k.pos.x, this.ball.pos.y - k.pos.y);
          // an airborne ball dropping INSIDE HIS BOX is HIS — "keeper's!":
          // he attacks a cross through his own defenders; deference to a
          // nearer mate applies only to ground balls outside his command
          const hisBall = this.ball.phase === 'airborne' &&
            Math.abs(pred.x - own.x) <= GOAL.boxDepthM &&
            Math.abs(pred.y - GOAL.centerY) <= GOAL.boxHalfWidthM;
          const mateNearer = !hisBall && this.bodies.some((m) => m.team === k.team && m.id !== k.id &&
            Math.hypot(this.ball.pos.x - m.pos.x, this.ball.pos.y - m.pos.y) < kD - 1);
          if (!mateNearer) {
            if (kD <= 1.2) {
              this.keeperAttacking.add(id); // full tilt — no shuffle on an attack
              // OUTSIDE his box, arriving on a loose low ball, the sweep ends
              // in a FIRST-TIME boot upfield — no gather (hands are illegal
              // and a bouncing gather loses the race to the arriving runner)
              const outsideBox = Math.abs(this.ball.pos.x - own.x) > GOAL.boxDepthM ||
                Math.abs(this.ball.pos.y - GOAL.centerY) > GOAL.boxHalfWidthM;
              if (outsideBox && kD <= TECH.kickReachM && this.ball.z <= BALL.keeperBootMaxZ &&
                (this.ball.kickerId !== id || this.tick >= this.ball.kickerLockUntilTick)) {
                const upAng = (sign > 0 ? 0 : Math.PI) +
                  this.rng.gauss(0, 0.3, this.tick, id, 'k-boot');
                kickBall(this.ball, { x: k.pos.x + Math.cos(upAng) * 30, y: k.pos.y + Math.sin(upAng) * 30 },
                  16, 25, id, this.tick);
                this.actionLabels.set(id, 'keeper-clear');
                continue;
              }
              // inside the box: claims/saves resolve the pickup
              if (k.command.type !== 'chaseBall') this.assign(k, { type: 'chaseBall', regime: 'sprint' });
              continue;
            } else {
              // the sweep is a RACE, not a receive — the generic chase's
              // receive machine stands on the line and waits (a receiver's
              // politeness) while the bounce drifts past his reach. Attack the
              // EARLIEST ground point on the ball's future path he can beat
              // the ball to, re-read every tick.
              const vcap = Math.max(regimeCapMps(k.attributes.pace, 'sprint'), 0.5);
              const c: BallState = {
                pos: { ...this.ball.pos }, z: this.ball.z, vel: { ...this.ball.vel }, vz: this.ball.vz,
                spin: this.ball.spin, phase: this.ball.phase,
                carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
              };
              // a CROSS in his box he attacks at HANDS' height mid-descent —
              // the earliest claimable point, UPSTREAM of the leapers (aiming
              // at the ground landing always arrived downstream of the header
              // contest: the near-post flick beat him to every corner)
              const zCatch = hisBall ? BALL.keeperClaimMaxZ : BALL.headMinZ;
              let target: Vec2 = { x: this.ball.pos.x, y: this.ball.pos.y };
              for (let i = 1; i <= 30; i++) {
                stepBall(c);
                if (c.z < zCatch) {
                  const dK = Math.hypot(c.pos.x - k.pos.x, c.pos.y - k.pos.y);
                  target = { x: c.pos.x, y: c.pos.y };
                  if (dK / vcap + 0.15 <= i * DT) break; // he beats the ball there
                }
              }
              // a sweep goes FORWARD — out toward the play, where he collects
              // (his box's hands, or feet beyond it). A ball rolling BEHIND
              // him is not a sweep: fall through to the ladder and RETREAT
              // (angle play walks him back goal-side, square to the ball).
              const dTargGoal = Math.hypot(target.x - own.x, target.y - own.y);
              const dKGoal = Math.hypot(k.pos.x - own.x, k.pos.y - own.y);
              if (dTargGoal >= dKGoal - 1) {
                this.keeperAttacking.add(id); // full tilt — no shuffle on an attack
                const cur = k.command.type === 'moveTo' ? k.command.target : null;
                if (!cur || Math.hypot(cur.x - target.x, cur.y - target.y) > 0.3) {
                  this.assign(k, { type: 'moveTo', target, regime: 'sprint' });
                }
                continue;
              }
              // behind him → not a sweep: fall through to the ladder (retreat)
            }
          }
        }
      }
      // NEAR-POST cover: the guarded line runs from the ball to a point shaded
      // toward the post on the ball's side — beaten at the near post is a
      // keeper's sin; the across-goal ball (the long dive) is the honest one
      const shade = Math.max(-1, Math.min(1, (this.ball.pos.y - GOAL.centerY) / 12)) * BALL.keeperNearPostShadeM;
      const anchor = { x: own.x, y: GOAL.centerY + shade };
      const bx = this.ball.pos.x - anchor.x;
      const by = this.ball.pos.y - anchor.y;
      const d = Math.max(Math.hypot(bx, by), 1e-6);
      // the DEPTH is SITUATIONAL — never a fixed post:
      //  · 1v1 RUSH: a lone opponent through (no defending teammate goal-side)
      //    → out to penalty-spot / edge-of-box range to smother it early;
      //  · SWEEPER: own team in possession, or play far upfield → a HIGH line
      //    off his goal, sweeping the space behind the defence;
      //  · else the base angle play, closing down as the ball nears.
      const oppHasBall = ballCarrier !== undefined && ballCarrier.team !== k.team;
      const ownHasBall = ballCarrier !== undefined && ballCarrier.team === k.team;
      const goalSideMates = this.bodies.filter((m) => m.team === k.team && m.id !== k.id &&
        Math.hypot(m.pos.x - own.x, m.pos.y - own.y) < d - 1).length;
      // the breakaway is read EARLY (a lone carrier bearing down from 40 m IS
      // the 1v1) — triggering only inside 30 left the keeper mid-rush when the
      // shot came
      const oneVsOne = oppHasBall && d < 45 && goalSideMates === 0;
      let depth: number;
      if (oneVsOne) {
        // POUNCE vs DELAY — the real 1v1 craft: rush hard only when the ball
        // is AWAY from the striker's feet (a heavy touch, the smother
        // window). At his feet, HOLD ~6 m: stay big, delay — from there the
        // backpedal beats the chip, and from 11 m out nothing does (the chip
        // finding: a keeper that far out cannot recover a good chip, so the
        // craft is not to be there while the striker is in control).
        const cGap = ballCarrier
          ? Math.hypot(this.ball.pos.x - ballCarrier.pos.x, this.ball.pos.y - ballCarrier.pos.y)
          : 99;
        const pounce = ballCarrier === undefined || cGap > 1.6;
        depth = pounce
          ? Math.min(Math.max(d - 7, BALL.keeperCloseGain * (28 - d), BALL.keeperDepthMinM), BALL.keeperRushMaxM)
          : Math.min(Math.max(BALL.keeperCloseGain * (28 - d), BALL.keeperDepthMinM), BALL.keeperDelayDepthM);
      } else if (ownHasBall || d > 45) {
        depth = Math.min(Math.max(BALL.keeperSweepGain * (d - 18), BALL.keeperDepthMinM), BALL.keeperSweepMaxM);
      } else {
        // CLOSING DOWN: come out toward the shooter as the ball nears — the
        // cone narrows toward him, so depth buys coverage (the chip is later)
        depth = Math.min(
          Math.max(BALL.keeperDepthMinM, BALL.keeperCloseGain * (28 - d)),
          BALL.keeperDepthMaxM,
        );
      }
      depth = Math.min(depth, Math.max(0.6, d - 1));
      const spot = { x: anchor.x + (bx / d) * depth, y: anchor.y + (by / d) * depth };
      // near his line he stays in the frame's shadow; further out the guard
      // cone widens with depth (a hard clamp at 16 m would drag him off-line)
      const yRoom = GOAL.mouthHalfWidthM + 0.5 + depth * 0.45;
      spot.y = Math.max(GOAL.centerY - yRoom, Math.min(GOAL.centerY + yRoom, spot.y));
      const cur = k.command.type === 'moveTo' ? k.command.target : null;
      if (!cur || Math.hypot(cur.x - spot.x, cur.y - spot.y) > 0.3) {
        const far = Math.hypot(k.pos.x - spot.x, k.pos.y - spot.y);
        this.assign(k, { type: 'moveTo', target: spot, regime: far > 3 ? 'sprint' : 'run' });
      }
    }
  }

  /** L7 — the SAVE: a free ball THREATENING his goal, within his dive's xyz
   * reach — CAUGHT (held, he becomes the carrier) when slow/low enough for his
   * handling, else PARRIED wide of the mouth. The block's swept footing with a
   * dive's reach (agility) and a catch (firstTouch as handling). Claims on
   * crosses, distribution, and sweeping are later L7 sub-phases. */
  private resolveSaves(from: Vec2): void {
    const ball = this.ball;
    if (ball.carrierId !== null || ball.phase === 'dead') return;
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    if (speed < 3) return; // a dying ball is an ordinary claim
    for (const id of this.keepers) {
      const k = this.byId.get(id);
      if (!k) continue;
      if (k.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      const sign = attackSign(k.team);
      const own = { x: sign > 0 ? 0 : PITCH.length, y: GOAL.centerY };
      // HANDS ARE LEGAL ONLY IN HIS BOX — outside it he is an outfielder
      // (feet: the ordinary claim machinery collects for him out there)
      if (Math.abs(ball.pos.x - own.x) > GOAL.boxDepthM ||
        Math.abs(ball.pos.y - GOAL.centerY) > GOAL.boxHalfWidthM) continue;
      const dGoal = Math.hypot(ball.pos.x - own.x, ball.pos.y - own.y);
      const towardGoal = ball.vel.x * (own.x - ball.pos.x) > 0;
      const shotLike = dGoal <= BALL.keeperEngageM && towardGoal && ball.z <= GOAL.barZ;
      if (!shotLike) {
        // the CROSS in his box — a corner, a whipped ball ACROSS the face
        // (not toward his line, so no shot gate catches it). His hands rule
        // the air: CLAIM (hold) what he can get to and hold; too hot, or
        // contested in the air at height, he PUNCHES it clear — distance
        // over control.
        if (ball.phase !== 'airborne' || ball.z > BALL.keeperClaimMaxZ) continue;
        const { d: dc, at: atc } = this.sweptApproach(k, from);
        if (dc > BALL.keeperClaimReachM) continue;
        const canHold = speed <= BALL.keeperCatchBase + BALL.keeperCatchTouch * k.attributes.firstTouch;
        const contested = this.bodies.some((o) => o.team !== k.team &&
          Math.hypot(o.pos.x - ball.pos.x, o.pos.y - ball.pos.y) <= BALL.keeperPunchContestM);
        if (!canHold || (contested && ball.z >= BALL.keeperPunchMinZ)) {
          // PUNCH — a fist through it, high and far upfield, with scatter
          ball.pos = { x: atc.x, y: atc.y };
          const upAng = (sign > 0 ? 0 : Math.PI) +
            this.rng.gauss(0, BALL.keeperPunchScatterRad, this.tick, k.id, 'punch');
          kickBall(ball, { x: atc.x + Math.cos(upAng) * 25, y: atc.y + Math.sin(upAng) * 25 },
            BALL.keeperPunchSpeed, BALL.keeperPunchLoftDeg, k.id, this.tick);
          this.actionLabels.set(k.id, 'punch');
        } else {
          // CLAIMED — the cross is his, held
          ball.pos = { x: atc.x, y: atc.y };
          ball.z = 0;
          ball.vz = 0;
          ball.spin = 0;
          ball.vel = { x: 0, y: 0 };
          ball.phase = 'carried';
          ball.carrierId = k.id;
          ball.kickerId = null;
          this.keeperHolding = k.id;
          this.keeperHeldSince = this.tick;
          this.completeChases(k.team);
          this.actionLabels.set(k.id, 'claim');
        }
        return; // one pair of hands per tick
      }
      // the SPREAD: point-blank — the SHOOTER right on top of him (the 1v1
      // smother) — he makes himself BIG, arms and legs wide. Gated on the
      // kicker's distance, not the ball's (the ball is always close when a
      // save resolves; gating on it spread him against every 17 m drive).
      const kicker = ball.kickerId ? this.byId.get(ball.kickerId) : undefined;
      const spread = kicker && Math.hypot(kicker.pos.x - k.pos.x, kicker.pos.y - k.pos.y) <= BALL.keeperSpreadRangeM
        ? BALL.keeperSpreadBonusM : 0;
      const reach = BALL.keeperReachBaseM + BALL.keeperReachAgility * k.attributes.agility + spread;
      const { d, at } = this.sweptApproach(k, from);
      if (d > reach) continue;
      const catchable = speed <= BALL.keeperCatchBase + BALL.keeperCatchTouch * k.attributes.firstTouch &&
        ball.z <= BALL.keeperCatchMaxZ;
      ball.pos = { x: at.x, y: at.y };
      ball.vz = 0;
      ball.z = 0;
      ball.spin = 0;
      if (catchable) {
        // held — his ball now
        ball.vel = { x: 0, y: 0 };
        ball.phase = 'carried';
        ball.carrierId = k.id;
        ball.kickerId = null;
        this.keeperHolding = k.id;
        this.keeperHeldSince = this.tick;
        this.completeChases(k.team);
        this.actionLabels.set(k.id, 'save-catch');
      } else {
        // PARRY — turned WIDE: outward through the contact, then rotated away
        // from the centre axis toward the flank (a central palm straight back
        // out tees up the arriving runner — the sweeper finding). Side = the
        // contact's side of goal; dead-central picks the side away from the
        // nearest opponent.
        let side = Math.sign(at.y - own.y);
        if (side === 0 || Math.abs(at.y - own.y) < 0.3) {
          const opp = this.bodies.filter((b) => b.team !== k.team)
            .sort((a, b2) => Math.hypot(a.pos.x - at.x, a.pos.y - at.y) - Math.hypot(b2.pos.x - at.x, b2.pos.y - at.y))[0];
          side = opp ? -Math.sign(opp.pos.y - at.y) || 1 : 1;
        }
        const ang = Math.atan2(at.y - own.y, at.x - own.x) +
          side * BALL.keeperParryWideRad +
          this.rng.gauss(0, 0.35, this.tick, k.id, 'parry');
        const sp = speed * BALL.keeperParryKeep;
        ball.vel = { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp };
        ball.vz = sp * 0.25;
        ball.z = 0.01;
        ball.phase = 'airborne';
        ball.carrierId = null;
        ball.kickerId = k.id;
        ball.kickerLockUntilTick = this.tick + 4;
        this.actionLabels.set(k.id, 'save-parry');
      }
      return; // one pair of hands per tick
    }
  }

  /** the 3-D COLLISION — interception in xyz, not xy: a DRIVEN airborne ball
   * (a shot, a cross, a driven pass) that passes through a body deflects off
   * him; one flighted OVER his reach clears. Reach is PER-PLAYER — the same
   * jump the header uses (headStandM + headJumpPerStr·strength), so a stronger
   * man reaches higher. An OPPONENT in the way is a BLOCK; a teammate who is
   * not the intended man is an accidental COLLISION (a hard ball caroms off
   * him). Only the intended receiver is exempt — he is controlling it, not
   * deflecting his own ball. A slow ball is controlled/headed, not deflected.
   * Runs after the deliberate header, before the ground claim. (The keeper — a
   * higher reach and a catch — is L7; the HANDBALL ruling belongs to the Fouls
   * layer, and cannot be a pure-geometry hook here: a ball merely passing OVER
   * a man's head is not a handball, only one his arm deliberately plays is —
   * that needs intent, not a reach test. The per-player reach below is the
   * foundation that layer will build on.) */
  private resolveBlocks(from: Vec2): void {
    const ball = this.ball;
    if (ball.phase !== 'airborne' || ball.z > BALL.headMaxZ) return; // above any reach → clears
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    if (speed < BALL.blockMinSpeedMps) return; // slow enough to be controlled/headed
    const kicker = ball.kickerId ? this.byId.get(ball.kickerId) : undefined;
    const kickerTeam = kicker?.team;
    let best: { body: BodyState; d: number; at: Vec2 } | null = null;
    for (const body of this.bodies) {
      if (body.id === ball.kickerId && this.tick < ball.kickerLockUntilTick) continue;
      if (body.id === this.intendedReceiverId) continue; // the intended man controls it
      // a teammate ATTACKING the ball (chasing it — a striker onto a cross) is
      // RECEIVING it, not an obstacle; he heads/controls it, he doesn't carom
      if (body.team === kickerTeam && body.command.type === 'chaseBall') continue;
      // PER-PLAYER vertical reach — the same leap the header gates on; a ball
      // above his head passes over (only an arm would reach it — a handball,
      // which is the Fouls layer's call, not here)
      if (ball.z > BALL.headStandM + BALL.headJumpPerStr * body.attributes.strength) continue;
      const { d, at } = this.sweptApproach(body, from);
      if (d > BALL.controlRadiusM) continue;
      if (!best || d < best.d) best = { body, d, at };
    }
    if (!best) return;
    // a BLOCK (opponent, deliberate) or a COLLISION (teammate, accidental) —
    // both deflect loose, but a body not trying to block scrubs less pace off
    const isCollision = kickerTeam !== undefined && best.body.team === kickerTeam;
    const keep = isCollision ? BALL.collisionDeflectKeep : BALL.blockDeflectKeep;
    const ang = Math.atan2(ball.vel.y, ball.vel.x) + Math.PI +
      this.rng.gauss(0, 0.8, this.tick, best.body.id, 'block');
    const sp = speed * keep;
    ball.pos = { x: best.at.x, y: best.at.y };
    ball.vel = { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp };
    ball.vz = sp * 0.3;
    ball.phase = 'airborne';
    ball.carrierId = null;
    ball.kickerId = best.body.id;
    ball.kickerLockUntilTick = this.tick + 4;
    ball.spin = 0;
    this.actionLabels.set(best.body.id, isCollision ? 'collision' : 'block');
  }

  private resolveClaims(from: Vec2): void {
    if (this.ball.z > BALL.claimMaxZ || this.ball.phase === 'dead') return;
    // closest approach of a body to the ball's swept path — in the BODY'S
    // frame: subtract his own displacement so two fast movers crossing
    // cannot tunnel through each other's reach between samples
    const segNearest = (b: BodyState): { d: number; at: Vec2 } => {
      const prev = this.prevPos.get(b.id) ?? b.pos;
      const bdx = b.pos.x - prev.x;
      const bdy = b.pos.y - prev.y;
      const fx = from.x - bdx;
      const fy = from.y - bdy;
      const dx = this.ball.pos.x - fx;
      const dy = this.ball.pos.y - fy;
      const len2 = dx * dx + dy * dy;
      const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1,
        ((b.pos.x - fx) * dx + (b.pos.y - fy) * dy) / len2));
      const at = { x: fx + dx * t, y: fy + dy * t };
      return { d: Math.hypot(b.pos.x - at.x, b.pos.y - at.y), at };
    };
    // a coupled ball is pinchable only MID-TOUCH, and the pinch is an ARRIVAL
    // RACE for the touch: the stealer must be in reach AND meaningfully
    // closer to the ball than its carrier (a tight touch is protected by
    // proximity; body-shielding arrives at L3). A glued ball cannot be
    // claimed — dispossessing it is an L3 tackle.
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    let carrierGap = Infinity;
    if (carrier) {
      carrierGap = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
      if (carrierGap <= BALL.controlRadiusM) return;
    }
    let best: { body: BodyState; d: number; at: Vec2 } | null = null;
    for (const b of this.bodies) {
      if (b.id === this.ball.carrierId) continue; // the carrier re-couples, he does not "claim"
      if (b.id === this.ball.kickerId && this.tick < this.ball.kickerLockUntilTick) continue;
      // a pass in FLIGHT is protected: while it is fresh (the kicker's lock
      // window), a teammate who is NOT the intended receiver stands off and
      // lets it reach its target — otherwise two stacked teammates in the
      // lane trade a ball meant for a THIRD man (the level-audit corner flap:
      // left passes to mid, the stacked right intercepts, repeat). Opponents
      // still intercept freely; past the window an unmet ball is collectable.
      if (this.intendedReceiverId && b.id !== this.intendedReceiverId &&
        this.tick < this.ball.kickerLockUntilTick) {
        const intended = this.byId.get(this.intendedReceiverId);
        if (intended && b.team === intended.team) continue;
      }
      // you never steal the ball off your OWN teammate's feet: only an
      // opponent pinches a carrier's live touch. Without this two stacked
      // teammates trade the carrier's popped touch back and forth every tick
      // — the possession ping-pong the level audit measured (a genuinely
      // loose ball, carrierId null, is unaffected: teammates DO collect it).
      if (carrier && b.team === carrier.team) continue;
      // (the pinch stays UNGATED: it is the rider's natural punishment of a
      // long touch, not a lunge — engage-gating it made heavy feet's 2 m
      // touches SAFE and inverted the skill split, while never helping close
      // control, whose losses are collisions, not pinches. Measured both ways.)
      const { d, at } = segNearest(b);
      if (d > BALL.controlRadiusM) continue;
      if (carrier && d >= carrierGap - BALL.pinchMarginM) continue; // the carrier wins his own touch
      // the carrier's body shields the touch: no pinch without a clear line
      if (carrier) {
        const sx = at.x - b.pos.x;
        const sy = at.y - b.pos.y;
        const len2 = sx * sx + sy * sy;
        const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1,
          ((carrier.pos.x - b.pos.x) * sx + (carrier.pos.y - b.pos.y) * sy) / len2));
        const cx = b.pos.x + sx * t;
        const cy = b.pos.y + sy * t;
        if (Math.hypot(carrier.pos.x - cx, carrier.pos.y - cy) < shieldRadiusM(carrier.attributes)) continue;
      }
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && b.id < best.body.id)) {
        best = { body: b, d, at };
      }
    }
    if (!best) return;
    // the claim is a FIRST TOUCH at the meeting point (L3): control quality
    // vs ball speed/height/pressure — a great touch kills a driven ball
    // dead; a poor one under pressure pops loose, still contested
    // difficulty rides the CLOSING speed: a ball cushioned while running
    // with it is easy; charging into a drive is hard (the moving-receive
    // judgment note)
    const relVx = this.ball.vel.x - best.body.vel.x;
    const relVy = this.ball.vel.y - best.body.vel.y;
    const ballSpeed = Math.hypot(relVx, relVy);
    const rawSpeed = Math.hypot(this.ball.vel.x, this.ball.vel.y);
    const arrivalDir = rawSpeed > 0.1 ? Math.atan2(this.ball.vel.y, this.ball.vel.x) : best.body.facing;
    const pressured = this.bodies.some((o) =>
      o.team !== best.body.team &&
      Math.hypot(o.pos.x - best.body.pos.x, o.pos.y - best.body.pos.y) <= TECH.touchPressureRangeM);
    const touch = resolveFirstTouch(
      this.rng, this.tick, best.body.id, best.body.attributes, arrivalDir, ballSpeed, this.ball.z, pressured,
      best.body.speed,
    );
    this.ball.pos = { x: best.at.x, y: best.at.y };
    this.ball.vz = 0;
    this.ball.z = 0;
    if (touch.pop) {
      // the ball squirts — no possession awarded; the pop is itself loose
      this.ball.carrierId = null;
      this.ball.phase = 'rolling';
      this.ball.vel = touch.vel;
      // the fumbler cannot instantly re-claim the same squirt (his touch IS
      // the miss); the kicker-lock mechanism expresses it
      this.ball.kickerId = best.body.id;
      this.ball.kickerLockUntilTick = this.tick + 8;
      return;
    }
    // a PINCH that steals from a live carrier arms the same refractory lock
    // the won tackle and the fumbled pop use: without it the just-
    // dispossessed man (still standing on the ball) re-pinches next tick and
    // the steal is undone — level touch duels oscillated carrier↔pincher
    // every 1–2 ticks (the level-audit finding). Loose-ball claims (no prior
    // carrier) and re-claims by the same body do not lock.
    const stolenFrom = carrier && carrier.id !== best.body.id ? carrier.id : null;
    this.ball.carrierId = best.body.id;
    this.ball.phase = 'carried';
    if (stolenFrom) {
      this.ball.kickerId = stolenFrom;
      this.ball.kickerLockUntilTick = this.tick + BALL.kickerLockTicks;
    }
    // chaseBall races complete NOW so the winner's NEXT command informs the
    // directional touch below — but only for the WINNING side. A chaser whose
    // OPPONENT came up with the ball is not done: his chase becomes the press
    // (standing down for seven seconds after a defender's sweep was the
    // judged give-up)
    this.completeChases(best.body.team);
    // the DIRECTIONAL first touch: a moving receiver sets the ball into his
    // route in stride — a dead-stop trap made him overrun his own ball and
    // circle back for it (the judged 360). Standing receivers kill it dead.
    const rb = best.body;
    if (rb.speed > BALL.standingSpeedMps + 0.4) {
      const dest = currentTarget(rb);
      const travel = dest
        ? Math.atan2(dest.y - rb.pos.y, dest.x - rb.pos.x)
        : Math.atan2(rb.vel.y, rb.vel.x);
      // a racing claim can resolve with the ball BEHIND the runner (his
      // sweep carried him past it) — an in-stride touch must OVERTAKE him,
      // not trail him like a shadow he can never reach: aim at a lead point
      // ahead of the RUNNER and weight the push to get there
      // control TO THE BOOT, ahead: the contact point can be at the heels
      // or beside mid-stride — the touch always originates just in front
      // (a trailing or lateral origin reads as "controlled behind him")
      this.ball.pos = {
        x: rb.pos.x + Math.cos(travel) * 0.35,
        y: rb.pos.y + Math.sin(travel) * 0.35,
      };
      const dir = dest
        ? Math.atan2(dest.y - this.ball.pos.y, dest.x - this.ball.pos.x)
        : Math.atan2(rb.vel.y, rb.vel.x);
      // a CONTESTED scramble claim (opponent in duel range) is a CONTROL
      // touch, never a stride-weight knock — a sprinting duel winner was
      // launching the ball 15–20 m (the judged duel launches)
      const scrapped = this.bodies.some((o) =>
        o.team !== rb.team && Math.hypot(o.pos.x - rb.pos.x, o.pos.y - rb.pos.y) < 3);
      // weight rides the gait: a RUNNER'S continuation touch is a CARRY
      // touch (a proper stride ahead — the cushion weight died at his feet
      // and checked the run); a stepping receiver still cushions
      let push: number;
      if (!scrapped && rb.speed > 3.5) {
        const vmax = topSpeedMps(rb.attributes.pace);
        push = rb.speed * (
          BALL.touchPushBase +
          BALL.touchPushSpeedGain * (rb.speed / vmax) +
          BALL.touchPushControlGain * (1 - rb.attributes.dribbling / 20)
        );
      } else {
        push = rb.speed * (
          TECH.directionalTouchBase +
          TECH.directionalTouchControlGain * (1 - rb.attributes.firstTouch / 20)
        );
      }
      const cap = this.dribbleArriveCap(rb);
      if (cap !== undefined) push = Math.min(push, cap);
      if (scrapped) push = Math.min(push, 3.0); // keep it in the duel
      this.ball.vel = { x: Math.cos(dir) * push, y: Math.sin(dir) * push };
    } else {
      this.ball.vel = { x: 0, y: 0 };
    }
  }

  /** every chaseBall command completes — the race is over (the winner now
   * carries; losers pull their next command) */
  /** L4 — the carrier's continuous evaluation (decide.ts is pure; this is
   * the harness: cadence, execution, and the receive reflex). Bodies without
   * a brain never enter here — scripts own them entirely. */
  private decidePhase(): void {
    if (this.brains.size === 0) return;
    // the receive reflex ends when ANYONE ends up with the ball
    if (this.intendedReceiverId && this.ball.carrierId !== null) this.intendedReceiverId = null;
    for (const id of this.brains) {
      const body = this.byId.get(id)!;
      if (this.ball.carrierId !== id) {
        this.intents.delete(id);
        if (this.intendedReceiverId === id) {
          if (this.runningLine.has(id)) this.bendReceive.add(id);
          this.runningLine.delete(id);
          this.runPhase.delete(id);
          // go meet your pass (chase semantics take it from here: contested
          // flights are raced, quiet ones are received)
          if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'run' });
          this.actionLabels.set(id, 'receive');
          // scan the field DURING the flight: where does the next ball go?
          // (decide() ignores ball state, so the receiver can evaluate as
          // if he already had it at his feet)
          if (this.tick % DECIDE.reconsiderTicks === 0) {
            const ahead = decide({
              carrier: body,
              bodies: this.bodies,
              ball: this.ball,
              instructions: this.instructions.get(id) ?? {},
              current: null,
              homes: this.homes,
              bounds: this.bounds,
              keepers: this.keepers,
              staggered: this.staggeredSet(),
            });
            const aim = ahead.kind === 'pass' || ahead.kind === 'shoot' || ahead.kind === 'clear' || ahead.kind === 'knock'
              ? Math.atan2(ahead.dest.y - body.pos.y, ahead.dest.x - body.pos.x)
              : ahead.kind === 'carry'
                ? Math.atan2(ahead.target.y - body.pos.y, ahead.target.x - body.pos.x)
                : undefined;
            if (aim !== undefined) this.receiveOpenDir.set(id, aim);
          }
        } else {
          this.receiveOpenDir.delete(id);
          // L5b RUN first, L5a SUPPORT second: an IDLE brain whose team
          // has the ball either attacks the space in behind (riding the
          // last defender's line until the ball is played) or drops to
          // offer an angle. Never overrides a scripted route.
          // "team in possession" includes the ball IN FLIGHT to a teammate
          // — the one-two giver darts DURING his pass's flight, or the
          // wall's instant return beats the run into existence
          const carrierBody = this.ball.carrierId
            ? this.byId.get(this.ball.carrierId)
            : (this.intendedReceiverId && this.intendedReceiverId !== id
              ? this.byId.get(this.intendedReceiverId)
              : undefined);
          if (carrierBody && carrierBody.team === body.team && carrierBody.id !== id &&
            (body.command.type === 'hold' || this.runningLine.has(id)) &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            const objective = (this.instructions.get(id)?.objective) ?? 'score';
            const plan = objective === 'score' ? runPlan(body, carrierBody, this.bodies) : null;
            if (plan) {
              // the RUN CYCLE: approach → RIDE the line (reload, jog) →
              // DART (sprint diagonally across the blind side into the
              // adjacent seam — pace is built BEFORE the ball is played;
              // the release meets the dart, not the other way around) →
              // if no ball comes, drop back to ride and go again
              const sign = body.team === 'home' ? 1 : -1;
              // the runner HOVERS a few meters OFF the line and attacks it
              // in bursts — riding glued to the line left a straight dart
              // nowhere to go (instant termination, zero pace, no breach:
              // the judged stall). The reload depth is what makes pace at
              // the breach possible.
              const hoverX = sign > 0
                ? Math.min(plan.target.x, plan.lineX - 5)
                : Math.max(plan.target.x, plan.lineX + 5);
              // the dart aims THROUGH the line (a target AT it arrive-brakes
              // the runner to a walk at the breach moment — the knock-past
              // lesson's third appearance); the phase ends as he reaches it
              const dartX = sign > 0 ? plan.lineX + 2 : plan.lineX - 2;
              const atHover = Math.abs(body.pos.x - hoverX) < 1.6;
              let st = this.runPhase.get(id);
              if (!st) {
                const gave = this.lastGiveTick.get(id);
                const oneTwo = gave !== undefined && this.tick - gave <= 12;
                st = { phase: oneTwo ? 'dart' : 'ride', since: this.tick, dartY: plan.dartY, lineX: plan.lineX };
                this.runPhase.set(id, st);
              }
              st.lineX = plan.lineX;
              const straight = Math.abs(st.dartY - body.pos.y) < 2;
              const atDartEnd = straight
                ? (sign > 0 ? body.pos.x >= plan.lineX - 0.2 : body.pos.x <= plan.lineX + 0.2)
                : Math.abs(body.pos.y - st.dartY) < 1.2;
              if (st.phase === 'ride' && atHover && this.tick - st.since >= 7) {
                st.phase = 'dart';
                st.since = this.tick;
                st.dartY = plan.dartY;
              } else if (st.phase === 'dart' &&
                (this.tick - st.since >= 26 || atDartEnd)) {
                st.phase = 'ride';
                st.since = this.tick;
              }
              if (st.phase === 'dart') {
                this.assign(body, {
                  type: 'moveTo',
                  target: { x: dartX, y: st.dartY },
                  regime: 'sprint',
                });
                this.actionLabels.set(id, 'dart');
              } else {
                this.assign(body, {
                  type: 'moveTo',
                  target: { x: hoverX, y: plan.target.y },
                  regime: atHover ? 'jog' : 'run',
                });
                this.actionLabels.set(id, 'run');
              }
              this.runningLine.add(id);
            } else {
              this.runPhase.delete(id);
              this.runningLine.delete(id);
              if (body.command.type === 'hold') {
                const spot = supportSpot(
                  body, carrierBody, this.bodies, this.homes.get(id) ?? body.pos, objective,
                );
                const d = Math.hypot(spot.x - body.pos.x, spot.y - body.pos.y);
                if (d > 1.4) {
                  this.assign(body, { type: 'moveTo', target: spot, regime: d > 7 ? 'run' : 'jog' });
                  this.actionLabels.set(id, 'support');
                }
              }
            }
          }
          // L5d COUNTERPRESS (before everything): the 5–8 s transition
          // instinct — chase the ball you just lost (loose OR opponent-
          // carried), overriding stale attack commands; organized defense
          // below still requires idleness
          {
            const lostAt = this.lostPossessionAt.get(body.team) ?? -999;
            const oppHasIt = carrierBody !== undefined && carrierBody.team !== body.team;
            const looseBall = this.ball.carrierId === null && this.intendedReceiverId === null;
            // counterpress is INNATE — even 'keep' brains hunt the ball
            // they just lost (it is literally the rondo's rule); the keep
            // gate below only blocks ORGANIZED defense
            const myBallDist = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
            if (this.tick - lostAt <= 60 && (oppHasIt || looseBall) &&
              this.tick % DECIDE.reconsiderTicks === 0 &&
              this.tick > (this.scriptedUntil.get(id) ?? -1) &&
              myBallDist < 15) {
              // counterpress is ELECTED too: the nearest man (or anyone
              // right on the ball) hunts; the rest keep balance — the
              // swarm re-created the double-chase the shadow exists to fix
              const teamBrains = [...this.brains].filter((bid) => {
                const b2 = this.byId.get(bid)!;
                return b2.team === body.team && this.tick > (this.scriptedUntil.get(bid) ?? -1);
              });
              const nearestCp = teamBrains.reduce((best, bid) => {
                const b2 = this.byId.get(bid)!;
                const d2 = Math.hypot(this.ball.pos.x - b2.pos.x, this.ball.pos.y - b2.pos.y);
                return d2 < best.d ? { id: bid, d: d2 } : best;
              }, { id: '', d: Infinity });
              if (nearestCp.id === id || myBallDist < 6) {
                if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'sprint' });
                this.pressingIds.add(id); // a pressing state — demotable
                this.actionLabels.set(id, 'counterpress');
                continue;
              }
            }
          }
          // L5c/L5d DEFENDING: an idle brain whose OPPONENT has the ball
          // runs the defensive chain — COUNTERPRESS (innate, the 5–8 s
          // transition window) > elected PRESS (instructed, one first
          // defender) > SHADOW (the second man sits on the escape lane) >
          // SHAPE (the line). Contact stays L3's contain/tackle machinery.
          if (carrierBody && carrierBody.team !== body.team &&
            (this.instructions.get(id)?.objective) !== 'keep' &&
            (body.command.type === 'hold' || this.shapeHolding.has(id) || this.pressingIds.has(id)) &&
            this.tick % DECIDE.reconsiderTicks === 0 &&
            this.tick > (this.scriptedUntil.get(id) ?? -1)) {
            const lostAt = this.lostPossessionAt.get(body.team) ?? -999;
            const inCounterpress = this.tick - lostAt <= 60 &&
              Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y) < 15;
            // the DEFENSIVE BRAIN (decide.ts): the sim gathers the unit,
            // the brain runs the hierarchy, the sim EXECUTES the intent
            // (and the duel machine rides what press decides)
            const unit = [...this.brains].filter((bid) => {
              const b2 = this.byId.get(bid)!;
              return b2.team === body.team && this.tick > (this.scriptedUntil.get(bid) ?? -1) &&
                (this.instructions.get(bid)?.objective) !== 'keep';
            }).map((bid) => this.byId.get(bid)!);
            const di = decideDefense({
              defender: body, carrier: carrierBody, bodies: this.bodies, ball: this.ball,
              instructions: this.instructions.get(id) ?? {}, unit,
              pressingIds: this.pressingIds, inCounterpress,
              justReceived: this.tick - this.carrierSince <= 8, homes: this.homes,
            });
            if (di.kind === 'press') {
              if (di.approach) {
                this.assign(body, { type: 'moveTo', target: di.approach, regime: 'sprint' });
              } else if (body.command.type !== 'chaseBall') {
                this.assign(body, { type: 'chaseBall', regime: 'sprint' });
              }
              this.pressingIds.add(id);
              this.shapeHolding.delete(id);
              this.actionLabels.set(id, di.label);
            } else if (di.kind === 'delay') {
              this.pressingIds.delete(id);
              const dh = Math.hypot(di.hold.x - body.pos.x, di.hold.y - body.pos.y);
              if (dh > 1.2) {
                this.assign(body, { type: 'moveTo', target: di.hold, regime: dh > 7 ? 'run' : 'jog' });
                this.shapeHolding.add(id);
              } else if (body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
              this.actionLabels.set(id, 'delay');
            } else {
              this.pressingIds.delete(id);
              const label = di.kind === 'cover' ? 'cover' : di.kind === 'mark' ? 'mark' : di.kind === 'interceptLane' ? 'shadow' : 'shape';
              const d = Math.hypot(di.target.x - body.pos.x, di.target.y - body.pos.y);
              if (d > 1.2) {
                // an URGENT mark (his man darting goalward) tracks at pace
                // from the anticipatory station — jogging the chase was the
                // judged too-late-by-momentum
                const regime = di.kind === 'mark' && di.urgent ? 'sprint' : d > 8 ? 'run' : 'jog';
                this.assign(body, { type: 'moveTo', target: di.target, regime });
                this.shapeHolding.add(id);
                this.actionLabels.set(id, label);
              } else if (this.shapeHolding.has(id) && body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
            }
          } else if (carrierBody && carrierBody.team === body.team) {
            this.shapeHolding.delete(id);
            this.pressingIds.delete(id);
          }
          // a STRAY ball (loose, dying, unclaimed, nobody sent to it) is
          // collected by the nearest idle brain — deflected passes died
          // untouched with players standing over them (the audit)
          if (body.command.type === 'hold' && this.ball.carrierId === null &&
            this.ball.phase !== 'dead' && this.intendedReceiverId === null &&
            Math.hypot(this.ball.vel.x, this.ball.vel.y) < 3) {
            const d = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
            if (d < 8) {
              const nearestBrain = [...this.brains].reduce((best, bid) => {
                const b = this.byId.get(bid)!;
                const bd = Math.hypot(this.ball.pos.x - b.pos.x, this.ball.pos.y - b.pos.y);
                return bd < best.d ? { id: bid, d: bd } : best;
              }, { id: '', d: Infinity });
              if (nearestBrain.id === id) {
                this.assign(body, { type: 'chaseBall', regime: 'run' });
                this.actionLabels.set(id, 'collect');
              }
            }
          }
        }
        continue;
      }
      this.receiveOpenDir.delete(id);
      this.bendReceive.delete(id); // carrier now — the run is received
      let intent = this.intents.get(id) ?? null;
      if (!intent || this.tick % DECIDE.reconsiderTicks === 0) {
        intent = decide({
          carrier: body,
          bodies: this.bodies,
          ball: this.ball,
          instructions: this.instructions.get(id) ?? {},
          current: intent,
          homes: this.homes,
          bounds: this.bounds,
          runners: this.runningLine,
          keepers: this.keepers,
          staggered: this.staggeredSet(),
          waitingRunners: new Set([...this.runningLine].filter((rid) => {
            const rp = this.runPhase.get(rid);
            const rb = this.byId.get(rid)!;
            if (!rp) return true;
            // the thread goes when the runner is ABOUT TO BREACH: darting,
            // at pace, and within a stride of the line (the judged one-two
            // spec — not merely "moving somewhere")
            const rsign = rb.team === 'home' ? 1 : -1;
            const dLine = rsign > 0 ? rp.lineX - rb.pos.x : rb.pos.x - rp.lineX;
            return rp.phase !== 'dart' || rb.speed < 3 || dLine > 4.5;
          })),
        });
        this.intents.set(id, intent);
      }
      switch (intent.kind) {
        case 'carry':
          this.pendingKicks.delete(id);
          if (this.tick % DECIDE.reconsiderTicks === 0 || body.command.type !== 'moveTo') {
            this.assign(body, { type: 'moveTo', target: intent.target, regime: intent.regime });
          }
          this.actionLabels.set(id, 'carry');
          break;
        case 'shield':
          this.pendingKicks.delete(id);
          if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
          this.actionLabels.set(id, 'shield');
          break;
        case 'beat': {
          this.actionLabels.set(id, 'beat');
          const gdirB = Math.atan2(goalCenter(body.team).y - body.pos.y, goalCenter(body.team).x - body.pos.x);
          const ex0 = this.beatExec?.carrierId === id ? this.beatExec : null;
          let fmB: BodyState | undefined = ex0 ? this.byId.get(ex0.fmId) : undefined;
          if (!fmB) {
            let fdB = 8.0;
            for (const o of this.bodies) {
              if (o.team === body.team) continue;
              const d0 = Math.hypot(o.pos.x - body.pos.x, o.pos.y - body.pos.y);
              if (d0 > 8.0) continue;
              const a0 = Math.abs((((Math.atan2(o.pos.y - body.pos.y, o.pos.x - body.pos.x) - gdirB) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
              if (a0 > Math.PI / 3) continue;
              if (d0 < fdB) { fdB = d0; fmB = o; }
            }
          }
          if (!fmB || this.ball.carrierId !== id) {
            this.beatExec = null;
            this.intents.delete(id);
            break;
          }
          if (!ex0) this.beatExec = { carrierId: id, fmId: fmB.id, phase: 'approach', side: intent.side, until: 0 };
          const st = this.beatExec!;
          const dFm = Math.hypot(fmB.pos.x - body.pos.x, fmB.pos.y - body.pos.y);
          if (dFm > 9) { // the duel dissolved — hand back to the EV
            this.beatExec = null;
            this.intents.delete(id);
            break;
          }
          const perpB = gdirB + Math.PI / 2;
          if (st.phase === 'approach') {
            // throttled, straight AT the rider — arrive at the arc in control
            const cur = body.command.type === 'moveTo' ? body.command.target : null;
            if (!cur || Math.hypot(cur.x - fmB.pos.x, cur.y - fmB.pos.y) > 0.5) {
              this.assign(body, { type: 'moveTo', target: { x: fmB.pos.x, y: fmB.pos.y }, regime: 'run' });
            }
            if (dFm <= 3.1) { st.phase = 'feint'; st.until = this.tick + 4; }
          }
          if (st.phase === 'feint') {
            // the step to the FAKE side (opposite the burst) — his smoothed
            // read follows it; the lag is the lane
            const fx = body.pos.x + Math.cos(gdirB) * 0.8 + Math.cos(perpB) * -st.side * 1.7;
            const fy = body.pos.y + Math.sin(gdirB) * 0.8 + Math.sin(perpB) * -st.side * 1.7;
            const cur = body.command.type === 'moveTo' ? body.command.target : null;
            if (!cur || Math.hypot(cur.x - fx, cur.y - fy) > 0.6) {
              this.assign(body, { type: 'moveTo', target: { x: fx, y: fy }, regime: 'run' });
            }
            if (this.tick >= st.until) st.phase = 'burst';
          }
          if (st.phase === 'burst') {
            // the knock through the REAL side, geometry read at burst time —
            // the pending-kick machinery strikes it on the next touch and the
            // knock flag turns the follow-through into the sprint
            const past = {
              x: fmB.pos.x + Math.cos(gdirB) * 2.4 + Math.cos(perpB) * st.side * 1.9,
              y: fmB.pos.y + Math.sin(gdirB) * 2.4 + Math.sin(perpB) * st.side * 1.9,
            };
            const dP = Math.hypot(past.x - body.pos.x, past.y - body.pos.y);
            this.pendingKicks.set(id, {
              dest: past,
              speedMps: Math.max(7, Math.min(15, rollLaunchForArrival(1.2, dP + 3))),
              knock: true,
            });
            if (body.command.type !== 'chaseBall') this.assign(body, { type: 'chaseBall', regime: 'sprint' });
            this.beatExec = null;
            this.intents.delete(id);
          }
          break;
        }
        case 'pass':
        case 'shoot':
        case 'knock':
        case 'clear': {
          this.actionLabels.set(id, intent.kind === 'pass' ? `pass→${intent.receiverId}` : intent.kind);
          const reach = Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y);
          const strikeDir = Math.atan2(intent.dest.y - body.pos.y, intent.dest.x - body.pos.x);
          const strikeMis = Math.abs(((strikeDir - body.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (reach <= TECH.kickReachM && strikeMis > DECIDE.strikeTurnThresholdRad) {
            // TURN, then strike — a misaligned kick is a backheel; the real
            // action is rotate-and-play, and the turn's delay is its honest
            // cost (defenders keep closing while the body comes around)
            if (body.command.type !== 'hold') this.assign(body, { type: 'hold' });
            body.command = { type: 'hold', facing: strikeDir };
          } else if (reach <= TECH.kickReachM) {
            // the strike itself is L3's: noisy by the kicker's feet
            const noisy = noisyKick(this.rng, this.tick, id, body.attributes, intent.dest, this.ball.pos, intent.speedMps, body.facing);
            kickBall(this.ball, noisy.target, noisy.speedMps, intent.kind === 'pass' || intent.kind === 'shoot' ? (intent.loftDeg ?? 0) : 0, id, this.tick, intent.kind === 'pass' ? (intent.spin ?? 0) : 0);
            if (intent.kind === 'pass') {
              this.intendedReceiverId = intent.receiverId;
              this.lastGiveTick.set(id, this.tick);
            }
            this.intents.delete(id);
            this.pendingKicks.delete(id);
            // the KNOCK's second half is the GO — sprint after your own push
            // (the kick freed the ball from carry speed; now win the race)
            this.assign(body, intent.kind === 'knock' ? { type: 'chaseBall', regime: 'sprint' } : { type: 'hold' });
          } else {
            // mid-touch: release ON THE NEXT TOUCH (coupleCarry fires it) —
            // and close the gap meanwhile
            this.pendingKicks.set(id, {
              dest: intent.dest,
              speedMps: intent.speedMps,
              ...((intent.kind === 'pass' || intent.kind === 'shoot') && intent.loftDeg ? { loftDeg: intent.loftDeg } : {}),
              ...(intent.kind === 'pass' && intent.spin ? { spin: intent.spin } : {}),
              ...(intent.kind === 'pass' ? { receiverId: intent.receiverId } : {}),
              ...(intent.kind === 'knock' ? { knock: true } : {}),
            });
            if (body.command.type !== 'chaseBall') {
              this.assign(body, { type: 'chaseBall', regime: 'run' });
            }
          }
          break;
        }
      }
    }
  }

  private completeChases(winningTeam: 'home' | 'away'): void {
    for (const b of this.bodies) {
      if (b.command.type === 'chaseBall' && b.team === winningTeam) {
        b.command = { type: 'hold' };
        b.arrived = true;
        b.arrivedAtTick = this.tick;
        const next = this.queues.get(b.id)!.shift();
        if (next) this.assign(b, next);
      }
    }
  }

  /** earliest point on the ball's predicted path this body can reach — the
   * anticipation runners actually use. Coarse deterministic search: clone-
   * step the real ball physics ahead and take the first reachable horizon. */
  /** the earliest point on the ball's predicted path this body can meet.
   * withMargin: prefer a point he reaches COMFORTABLY early (≥0.55 s) — a
   * receiver sets up on the line and takes the arriving ball; the marginal
   * meet (tStar ≈ his arrival) makes him carry his momentum THROUGH the
   * line and stern-chase the ball he just missed. Fetching your own touch
   * never margins (a dribbler does not stop ahead of his ball and wait). */
  /** the earliest point on the ball's predicted path this body can meet,
   * and when the ball gets there. The APPROACH is time-matched by the
   * caller: run at the ball's meeting point at the speed that arrives WITH
   * it — toward the ball always, through it never. */
  /** Where a chaser should run. Two-phase, like a real receiver:
   *  1. OFF the ball's line → attack the nearest point of the path (this is
   *     visually "moving toward the ball" — the earliest-meet target alone
   *     produces a parallel converging drift that reads as running away);
   *  2. ON the line → the earliest meeting point, approached at the speed
   *     that arrives WITH the ball. */
  /** the in-stride meet: where the ball's predicted path comes onto the
   * body's CONTINUED run (current velocity held) — or null if running
   * through does not meet the ball and the receive must be timed */
  private inStrideMeet(body: BodyState): Vec2 | null {
    if (body.speed < 3.5) return null;
    // a PASS in flight only — a slow or sitting ball must be braked into
    // (the collect), not charged at full stride (the original overrun bug)
    if (Math.hypot(this.ball.vel.x, this.ball.vel.y) < 4) return null;
    const ux = body.vel.x / body.speed;
    const uy = body.vel.y / body.speed;
    let bestGap = Infinity;
    let bestT = 0;
    for (let t = 0.2; t <= 3.0; t += 0.2) {
      const bp = predictBall(this.ball, t);
      const g = Math.hypot(bp.x - (body.pos.x + ux * body.speed * t), bp.y - (body.pos.y + uy * body.speed * t));
      if (g < bestGap) {
        bestGap = g;
        bestT = t;
      }
    }
    if (bestGap > 1.0) return null;
    const bp = predictBall(this.ball, bestT);
    return { x: bp.x, y: bp.y };
  }

  /** the bend-receive meet: the earliest point on the ball's predicted
   * path the runner reaches AT PACE with a forward-ish bend (≤1.2 rad of
   * his current heading) — or null if the ball truly requires turning back */
  private bendMeet(body: BodyState): Vec2 | null {
    if (body.speed < 3) return null;
    if (Math.hypot(this.ball.vel.x, this.ball.vel.y) < 3) return null;
    const hd = Math.atan2(body.vel.y, body.vel.x);
    for (let t = 0.2; t <= 3.0; t += 0.2) {
      const bp = predictBall(this.ball, t);
      const d = Math.hypot(bp.x - body.pos.x, bp.y - body.pos.y);
      if (d > body.speed * t + 0.9) continue; // cannot make it at pace
      const dir = Math.atan2(bp.y - body.pos.y, bp.x - body.pos.x);
      const bend = Math.abs(((dir - hd + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d > 0.6 && bend > 1.2) continue; // that would be a turn-back
      return bp;
    }
    return null;
  }

  private interceptPoint(body: BodyState): {
    pNear: Vec2; tNear: number; lineDist: number; pMeet: Vec2; tMeet: number;
  } {
    const regime = body.command.type === 'chaseBall' ? body.command.regime : 'run';
    const vcap = Math.max(regimeCapMps(body.attributes.pace, regime), 0.5);
    let meet: { p: Vec2; tStar: number } | null = null;
    let near: { p: Vec2; d: number; t: number } | null = null;
    const airborne = this.ball.phase === 'airborne';
    // near EITHER goal a body ATTACKS an aerial ball at head height (a header —
    // a cross to a striker, a defender under a lob) rather than waiting for the
    // ground drop; in open play he lets it drop and controls it. So the ceiling
    // on a "receive" point is the header band near a goal, knee height else.
    const nearGoal = Math.min(body.pos.x, PITCH.length - body.pos.x) < 20;
    const zCap = nearGoal ? BALL.headMaxZ : BALL.claimMaxZ;
    if (airborne) {
      // the FIRST point at catchable height and DESCENDING — the drop for a
      // loft, immediately for a flat cross that never climbs above zCap. Taken
      // EARLIEST at every physics tick: a fast descent crosses the 0.5 m window
      // in ONE tick and by the next it has bounced (vz>0), so the old
      // coarse+nearest scan skipped the real drop and targeted the post-bounce
      // ROLL — walking the receiver clean past it to the sideline. ONE clone
      // stepped incrementally (a fresh predictBallState per sample re-simulates
      // the whole flight each time; DT is the true resolution anyway).
      const c: BallState = {
        pos: { ...this.ball.pos }, z: this.ball.z, vel: { ...this.ball.vel }, vz: this.ball.vz,
        spin: this.ball.spin, phase: 'airborne', carrierId: null, kickerId: null,
        kickerLockUntilTick: 0, touchParity: false,
      };
      let prevZ = c.z;
      for (let i = 1; i <= 60; i++) {
        stepBall(c);
        // catchable height AND coming down to him: descending (flat cross that
        // never climbs above zCap) OR just crossed DOWN through zCap (a steep
        // drop the sample catches only after it has bounced, vz>0)
        if (c.z <= zCap && (c.vz <= 0.2 || prevZ > zCap)) {
          const p = { x: c.pos.x, y: c.pos.y };
          const t = i * DT;
          const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
          near = { p, d, t };
          meet = { p, tStar: t }; // he runs to the drop whether or not he'll beat it
          break;
        }
        prevZ = c.z;
      }
    } else {
      for (let t = 0.2; t <= 6.0; t += 0.2) {
        const s = predictBallState(this.ball, t);
        const p = s.pos;
        const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
        if (!near || d < near.d) near = { p, d, t };
        if (!meet && 0.3 + d / vcap <= t) meet = { p, tStar: t };
      }
    }
    const far = predictBall(this.ball, 6);
    return {
      pNear: near?.p ?? far,
      tNear: near?.t ?? 6,
      lineDist: near?.d ?? 99,
      pMeet: meet?.p ?? far,
      tMeet: meet?.tStar ?? 6,
    };
  }

  private assign(body: BodyState, command: MovementCommand): void {
    this.receiveOnLine.delete(body.id);
    body.command = command;
    body.pathIndex = 0;
    body.arrived = command.type === 'hold' && command.facing === undefined && body.speed <= 0.02;
    body.arrivedAtTick = body.arrived ? this.tick : -1;
  }

  private snapshot(): Frame {
    const bodies: FrameBody[] = this.bodies.map((b) => {
      const target = this.liveTargets.get(b.id) ?? currentTarget(b);
      const fb: FrameBody = {
        id: b.id,
        team: b.team,
        x: b.pos.x,
        y: b.pos.y,
        vx: b.vel.x,
        vy: b.vel.y,
        facing: b.facing,
        regime: b.regime,
        stance: b.stance,
      };
      if (target) {
        fb.tx = target.x;
        fb.ty = target.y;
      }
      const action = this.actionLabels.get(b.id);
      if (action) fb.action = action;
      return fb;
    });
    return {
      tick: this.tick,
      t: this.tick * DT,
      bodies,
      ball: {
        x: this.ball.pos.x,
        y: this.ball.pos.y,
        z: this.ball.z,
        phase: this.ball.phase,
        carrierId: this.ball.carrierId,
      },
    };
  }
}

/** Run a scenario start-to-finish; the full-rate frame list is the result. */
export function runScenario(def: ScenarioDef, seed = 'workbench'): Frame[] {
  const sim = new Sim(def, seed);
  const frames: Frame[] = [];
  for (let i = 0; i < def.durationTicks; i++) frames.push(sim.step());
  return frames;
}
