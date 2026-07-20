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
    for (const ev of def.script) {
      const body = this.byId.get(ev.bodyId);
      if (!body) throw new Error(`script references unknown body ${ev.bodyId}`);
      if ('atTick' in ev) {
        const list = this.atTick.get(ev.atTick) ?? [];
        list.push({ bodyId: ev.bodyId, command: ev.command });
        this.atTick.set(ev.atTick, list);
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

    // 2. bodies move; chaseBall runs to the INTERCEPT point (players
    // anticipate where a ball is going, they don't chase its tail), and a
    // carrier whose touch ran beyond reach STEERS to fetch it — the route is
    // the intent, the ball is the path
    this.liveTargets.clear();
    for (const body of this.bodies) {
      const isCarrier = this.ball.carrierId === body.id;
      const gap = isCarrier
        ? Math.hypot(this.ball.pos.x - body.pos.x, this.ball.pos.y - body.pos.y)
        : 0;
      const fetching = isCarrier && gap > BALL.controlRadiusM &&
        body.command.type !== 'chaseBall' && body.command.type !== 'hold';
      let live: Vec2 | undefined;
      if (body.command.type === 'chaseBall' || fetching) {
        live = this.interceptPoint(body);
        this.liveTargets.set(body.id, live);
      }
      stepBody(body, this.tick, {
        external: body.command.type === 'chaseBall' ? live : undefined,
        steer: fetching ? live : undefined,
        carrying: isCarrier,
      });
      if (body.arrived) {
        const next = this.queues.get(body.id)!.shift();
        if (next) this.assign(body, next);
      }
    }

    // 3. scripted kicks — only the current carrier can strike
    const kicks = this.kicksAt.get(this.tick);
    if (kicks) {
      for (const k of kicks) {
        if (this.ball.carrierId === k.bodyId) {
          kickBall(this.ball, k.kick.target, k.kick.speedMps, k.kick.loftDeg, k.bodyId, this.tick);
        }
      }
    }

    // 4. carry coupling, then free-ball physics
    this.coupleCarry();
    stepBall(this.ball);

    // 5. loose-ball claims (and the chaseBall race resolution)
    this.resolveClaims();

    const frame = this.snapshot();
    this.tick++;
    return frame;
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
    const heading = baseHeading + (this.ball.touchParity ? 1 : -1) * BALL.touchAlternateRad;
    this.ball.touchParity = !this.ball.touchParity;
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
    this.ball.vel = { x: Math.cos(heading) * push, y: Math.sin(heading) * push };
    this.ball.z = 0;
    this.ball.vz = 0;
    this.ball.phase = 'carried';
  }

  private resolveClaims(): void {
    if (this.ball.z > BALL.claimMaxZ) return;
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
    let best: { body: BodyState; d: number } | null = null;
    for (const b of this.bodies) {
      if (b.id === this.ball.carrierId) continue; // the carrier re-couples, he does not "claim"
      if (b.id === this.ball.kickerId && this.tick < this.ball.kickerLockUntilTick) continue;
      const d = Math.hypot(this.ball.pos.x - b.pos.x, this.ball.pos.y - b.pos.y);
      if (d > BALL.controlRadiusM) continue;
      if (carrier && d >= carrierGap - BALL.pinchMarginM) continue; // the carrier wins his own touch
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && b.id < best.body.id)) {
        best = { body: b, d };
      }
    }
    if (!best) return;
    this.ball.carrierId = best.body.id;
    this.ball.phase = 'carried';
    // the race is over: every chaseBall command completes (winner included —
    // he now holds with the ball at his feet; losers pull their next command)
    for (const b of this.bodies) {
      if (b.command.type === 'chaseBall') {
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
  private interceptPoint(body: BodyState): Vec2 {
    const regime = body.command.type === 'chaseBall' ? body.command.regime : 'run';
    const vcap = Math.max(regimeCapMps(body.attributes.pace, regime), 0.5);
    for (let t = 0.2; t <= 6.0; t += 0.2) {
      const p = predictBall(this.ball, t);
      const reach = 0.3 + Math.hypot(p.x - body.pos.x, p.y - body.pos.y) / vcap;
      if (reach <= t) return p;
    }
    return predictBall(this.ball, 6);
  }

  private assign(body: BodyState, command: MovementCommand): void {
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
