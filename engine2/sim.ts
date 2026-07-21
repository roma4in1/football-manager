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
import { BALL, kickBall, predictBall, stepBall, type BallState } from './ball.ts';
import { currentTarget, KIN, regimeCapMps, stepBody, topSpeedMps } from './kinematics.ts';
import { noisyKick, resolveFirstTouch, shieldRadiusM, tackleWinProbability, TECH } from './technique.ts';
import { decide, DECIDE, pressApproach, pressCoverSpots, pressScore, runPlan, shadowSpot, shapeSpot, supportSpot, type Intent, type PlayInstructions } from './decide.ts';
import { KeyedRng } from './keyed-rng.ts';

export class Sim {
  readonly bodies: BodyState[];
  readonly ball: BallState;
  readonly rng: KeyedRng;
  tick = 0;
  private readonly byId = new Map<string, BodyState>();
  private readonly atTick = new Map<number, Array<{ bodyId: string; command: MovementCommand }>>();
  private readonly kicksAt = new Map<number, Array<{ bodyId: string; kick: { target: Vec2; speedMps: number; loftDeg: number } }>>();
  private readonly queues = new Map<string, MovementCommand[]>();
  /** per-tick live steering targets (intercepts/fetches) — the frame's debug
   * overlay shows what the body is ACTUALLY running to */
  private readonly liveTargets = new Map<string, Vec2>();
  /** L4: bodies that run the on-ball decision loop, their instructions,
   * their current intent, and the action label shown in the workbench */
  private readonly brains = new Set<string>();
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
  private readonly pendingKicks = new Map<string, { dest: Vec2; speedMps: number; receiverId?: string }>();

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
      phase: carrier ? 'carried' : 'rolling',
      carrierId: carrier ? carrier.id : null,
      kickerId: null,
      kickerLockUntilTick: 0,
      touchParity: false,
    };
  }

  /** advance one tick; returns the full-rate frame for it */
  step(): Frame {
    // 1. scripted re-targets (replace the current command, keep the queue)
    const events = this.atTick.get(this.tick);
    if (events) {
      for (const ev of events) this.assign(this.byId.get(ev.bodyId)!, ev.command);
    }

    // 1b. L4 — the on-ball decision loop (after scripts: a scripted re-target
    // on a brainless body stands; the carrier's OWN command is decision-owned)
    this.decidePhase();

    // 2. bodies move; chaseBall runs to the INTERCEPT point (players
    // anticipate where a ball is going, they don't chase its tail), and a
    // carrier whose touch ran beyond reach STEERS to fetch it — the route is
    // the intent, the ball is the path
    this.liveTargets.clear();
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
      if (body.command.type === 'chaseBall' || fetching) {
        const icept = this.interceptPoint(body);
        live = icept.pMeet;
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
            const vcap = Math.max(regimeCapMps(body.attributes.pace, body.command.regime), 0.5);
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
              live = icept.pMeet;
              const d = Math.hypot(live.x - body.pos.x, live.y - body.pos.y);
              const need = d / Math.max(icept.tMeet, 0.2);
              if (need < vcap * 0.95) timedCap = Math.max(need, 0.6);
              if (d <= 0.5) standing = true;
            }
          }
        }
        // CONTAIN at contact: a hunter already within lunging reach of a
        // GLUED ball stands his ground and works the tackle cooldown —
        // driving on converts to tangential slide around the carrier's
        // collision disc (the judged 360° orbit)
        if (body.command.type === 'chaseBall' && this.ball.carrierId !== null && !isCarrier) {
          const carrierB = this.byId.get(this.ball.carrierId)!;
          const gapBC = Math.hypot(this.ball.pos.x - carrierB.pos.x, this.ball.pos.y - carrierB.pos.y);
          const dToCar = Math.hypot(body.pos.x - carrierB.pos.x, body.pos.y - carrierB.pos.y);
          const containing = this.containBearing.has(body.id);
          // hysteresis: enter the press close-in, leave only when knocked
          // well out — a single threshold FLAPS (charge → bounce → charge),
          // thrashing a rotating bearing (the judged 360°)
          const engage = gapBC <= BALL.controlRadiusM && (dToCar <= 1.9 || (containing && dToCar <= 2.6));
          if (engage) {
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
          }
        }
        this.liveTargets.set(body.id, live);
      }
      stepBody(body, this.tick, {
        external: body.command.type === 'chaseBall' ? live : undefined,
        steer: fetching ? live : undefined,
        carrying: isCarrier,
        carrySpeedCapMps: isCarrier ? this.dribbleArriveCap(body) : undefined,
        stand: standing,
        brakeAtTarget: timedCap !== undefined || brakeIntoLine,
        speedCapMps: timedCap,
      });
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
          kickBall(this.ball, noisy.target, noisy.speedMps, k.kick.loftDeg, k.bodyId, this.tick);
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
    stepBall(this.ball);
    // a ball over any boundary is DEAD where it crossed (restarts are L8's;
    // until then it must not roll to infinity — the L4 shot exposed this).
    // Drill BOUNDS count as boundaries too (positional grids).
    const ob = this.bounds;
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
      BALL.touchArriveResidualMps ** 2 + 2 * BALL.rollDecelMps2 * Math.max(0, distToDest),
    );
    return cap * 1.05;
  }

  private resolveTackles(): void {
    const carrier = this.ball.carrierId ? this.byId.get(this.ball.carrierId) : undefined;
    if (!carrier) return;
    const gap = Math.hypot(this.ball.pos.x - carrier.pos.x, this.ball.pos.y - carrier.pos.y);
    if (gap > BALL.controlRadiusM) return; // a running touch is the pinch's domain
    for (const b of this.bodies) {
      if (b.id === carrier.id || b.team === carrier.team) continue;
      if (b.command.type !== 'chaseBall') continue; // intent to win the ball
      if ((this.tackleCooldown.get(b.id) ?? -1) > this.tick) continue;
      const reach = Math.hypot(this.ball.pos.x - b.pos.x, this.ball.pos.y - b.pos.y);
      if (reach > TECH.tackleReachM) continue;
      this.tackleCooldown.set(b.id, this.tick + TECH.tackleCooldownTicks);
      const winP = tackleWinProbability(b.attributes, carrier.attributes) /
        (1 + TECH.tackleCarrierSpeedFactor * carrier.speed);
      if (this.rng.chance(winP, this.tick, b.id, 'tackle')) {
        // knocked loose AWAY from the carrier, scattered
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
    if (this.ball.z > BALL.claimMaxZ || d > BALL.controlRadiusM) return; // chasing his own touch
    // a decided kick releases ON THIS TOUCH — the ball is at the boot for
    // one contact and that contact is the pass/shot/clear
    const pending = this.pendingKicks.get(carrier.id);
    const pendingAligned = pending !== undefined && (() => {
      const d = Math.atan2(pending.dest.y - carrier.pos.y, pending.dest.x - carrier.pos.x);
      return Math.abs(((d - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) <= DECIDE.strikeTurnThresholdRad;
    })();
    if (pending && pendingAligned) {
      const noisy = noisyKick(this.rng, this.tick, carrier.id, carrier.attributes, pending.dest, this.ball.pos, pending.speedMps, carrier.facing);
      kickBall(this.ball, noisy.target, noisy.speedMps, 0, carrier.id, this.tick);
      if (pending.receiverId) {
        this.intendedReceiverId = pending.receiverId;
        this.lastGiveTick.set(carrier.id, this.tick);
      }
      this.pendingKicks.delete(carrier.id);
      this.intents.delete(carrier.id);
      this.assign(carrier, { type: 'hold' });
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
        BALL.touchArriveResidualMps ** 2 + 2 * BALL.rollDecelMps2 * Math.max(0, distToDest),
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
        BALL.touchArriveResidualMps ** 2 + 2 * BALL.rollDecelMps2 * rollMax,
      ));
    }
    this.ball.vel = { x: Math.cos(heading) * push, y: Math.sin(heading) * push };
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.phase = 'carried';
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
    this.actionLabels.clear();
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
            });
            const aim = ahead.kind === 'pass' || ahead.kind === 'shoot' || ahead.kind === 'clear'
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
            const pressing = this.instructions.get(id)?.pressing ?? 0;
            const justReceived = this.tick - this.carrierSince <= 8;
            // first-defender election: the nearest eligible defending brain
            const defBrains = [...this.brains].filter((bid) => {
              const b2 = this.byId.get(bid)!;
              return b2.team === body.team && this.tick > (this.scriptedUntil.get(bid) ?? -1) &&
                (this.instructions.get(bid)?.objective) !== 'keep';
            });
            let nearest = defBrains.reduce((best, bid) => {
              const b2 = this.byId.get(bid)!;
              const d2 = Math.hypot(carrierBody.pos.x - b2.pos.x, carrierBody.pos.y - b2.pos.y);
              return d2 < best.d ? { id: bid, d: d2 } : best;
            }, { id: '', d: Infinity });
            // STICKY election: the engaged presser keeps the job unless he
            // is clearly beaten (flapping first/second made both look like
            // ball-chasers — the judged no-coordination)
            const incumbent = defBrains.find((bid) => this.pressingIds.has(bid));
            if (incumbent && incumbent !== nearest.id) {
              const bi = this.byId.get(incumbent)!;
              const di = Math.hypot(carrierBody.pos.x - bi.pos.x, carrierBody.pos.y - bi.pos.y);
              if (di < nearest.d + 4 && di < 14) nearest = { id: incumbent, d: di };
            }
            const iAmFirst = nearest.id === id;
            const score = pressScore(body, carrierBody, this.bodies, justReceived, pressing);
            const pressNow = inCounterpress || (iAmFirst && pressing > 0 && score >= 0.75 - 0.3 * pressing);
            const firstIsEngaged = this.pressingIds.has(nearest.id) || (iAmFirst && pressNow);
            if (pressNow) {
              // the CURVED approach: close from the denied lane's side
              // (pressing.md: a straight chase leaves the lane open); the
              // last 3 m are the L3 hunt (contain + tackles need the chase)
              const dCar = Math.hypot(carrierBody.pos.x - body.pos.x, carrierBody.pos.y - body.pos.y);
              if (dCar > 3 && !inCounterpress) {
                const ap = pressApproach(body, carrierBody, this.bodies);
                this.assign(body, { type: 'moveTo', target: ap, regime: 'sprint' });
              } else if (body.command.type !== 'chaseBall') {
                this.assign(body, { type: 'chaseBall', regime: 'sprint' });
              }
              this.pressingIds.add(id);
              this.shapeHolding.delete(id);
              this.actionLabels.set(id, inCounterpress ? 'counterpress' : 'press');
            } else if (iAmFirst && pressing > 0 &&
              Math.hypot(carrierBody.pos.x - body.pos.x, carrierBody.pos.y - body.pos.y) < 11) {
              // the DELAY stance (pressing.md's passive band): hold off
              // goal-side ~4.5 m — slow the attack, wait for the trigger
              this.pressingIds.delete(id);
              const gSign = body.team === 'home' ? 1 : -1;
              const gx = gSign > 0 ? 0 : PITCH.length;
              const dx = gx - carrierBody.pos.x;
              const dy = 34 - carrierBody.pos.y;
              const dn = Math.hypot(dx, dy) || 1;
              const hold = { x: carrierBody.pos.x + (dx / dn) * 4.5, y: carrierBody.pos.y + (dy / dn) * 4.5 };
              const dh = Math.hypot(hold.x - body.pos.x, hold.y - body.pos.y);
              if (dh > 1.2) {
                this.assign(body, { type: 'moveTo', target: hold, regime: dh > 7 ? 'run' : 'jog' });
                this.shapeHolding.add(id);
              } else if (body.command.type !== 'hold') {
                this.assign(body, { type: 'hold' });
              }
              this.actionLabels.set(id, 'delay');
            } else {
              this.pressingIds.delete(id);
              // a PRESSING UNIT's non-engaged members take distinct
              // assignments over the carrier's ranked options (a line-shape
              // fallback stacked all four at one depth — the judged
              // overlaps); LINE units (pressing ≤ 0.3) keep L5c shape
              let target: Vec2 | null = null;
              let label = 'shape';
              if (pressing > 0.3 && firstIsEngaged) {
                const coverIds = defBrains.filter((bid) => bid !== nearest.id && bid !== id)
                  .concat([id]).filter((bid) => bid !== nearest.id);
                const spots = pressCoverSpots(carrierBody, this.bodies, coverIds);
                target = spots.get(id) ?? null;
                label = 'cover';
              } else if (!iAmFirst && firstIsEngaged && nearest.d < 6) {
                target = shadowSpot(body, carrierBody, this.bodies);
                label = 'shadow';
              }
              if (!target) {
                target = shapeSpot(body, this.bodies, this.ball, this.homes, defBrains,
                  this.instructions.get(id)?.lineHeight ?? 0.5);
                label = 'shape';
              }
              const d = Math.hypot(target.x - body.pos.x, target.y - body.pos.y);
              if (d > 1.2) {
                this.assign(body, { type: 'moveTo', target, regime: d > 8 ? 'run' : 'jog' });
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
        case 'pass':
        case 'shoot':
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
            kickBall(this.ball, noisy.target, noisy.speedMps, 0, id, this.tick);
            if (intent.kind === 'pass') {
              this.intendedReceiverId = intent.receiverId;
              this.lastGiveTick.set(id, this.tick);
            }
            this.intents.delete(id);
            this.pendingKicks.delete(id);
            this.assign(body, { type: 'hold' });
          } else {
            // mid-touch: release ON THE NEXT TOUCH (coupleCarry fires it) —
            // and close the gap meanwhile
            this.pendingKicks.set(id, {
              dest: intent.dest,
              speedMps: intent.speedMps,
              ...(intent.kind === 'pass' ? { receiverId: intent.receiverId } : {}),
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
    for (let t = 0.2; t <= 6.0; t += 0.2) {
      const p = predictBall(this.ball, t);
      const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
      if (!near || d < near.d) near = { p, d, t };
      if (!meet && 0.3 + d / vcap <= t) meet = { p, tStar: t };
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
