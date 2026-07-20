/**
 * ball.ts — L2 ball physics + possession coupling (spec §3 ball state, §5-L2).
 *
 * The ball is ALWAYS a physical object. "Carried" is not an attachment — it
 * is a coupling loop: the carrier TOUCHES the ball (pushing it ahead along
 * his heading), the ball rolls free under friction, the carrier chases and
 * touches again. Touch length scales with speed (faster runs push longer
 * touches) and with dribbling (heavy feet push longer than close control),
 * so the control-vs-speed tension is emergent: a low-dribbling sprinter's
 * ball runs away from him by construction, and a sharp turn can leave the
 * ball behind — physics, not scripted possession loss.
 *
 * Phases: carried (a body owns the coupling loop) / rolling (free on the
 * ground) / airborne (gravity flight, bounces on landing) / dead (reserved
 * for L8 restarts — unused until then). Spin/curve explicitly deferred.
 * All motion is deterministic; execution noise on kicks arrives at L3.
 */

import { DT, type Vec2 } from './engine2-types.ts';

export type BallPhase = 'carried' | 'rolling' | 'airborne' | 'dead';

export interface BallState {
  pos: Vec2;
  /** height above the turf, meters */
  z: number;
  vel: Vec2;
  vz: number;
  phase: BallPhase;
  carrierId: string | null;
  /** a kicker cannot claim his own strike for a beat — a kicked ball has
   * LEFT him; without this a sub-9 m/s kick is instantly re-claimed by its
   * own kicker standing at the strike point */
  kickerId: string | null;
  kickerLockUntilTick: number;
  /** alternating-foot texture: flips each touch */
  touchParity: boolean;
}

export const BALL = {
  /** grass drag on a rolling ball — a firm 16 m/s pass reaches ~20 m at ~13 m/s */
  rollDecelMps2: 1.7,
  /** below this a roll is at rest (still 'rolling' — i.e. loose, claimable) */
  stopSpeedMps: 0.15,
  gravity: 9.81,
  /** vertical speed kept per bounce (grass ~0.5–0.6) */
  bounceRestitution: 0.55,
  /** horizontal speed kept through a bounce (turf scrubs pace off) */
  bounceGroundFriction: 0.75,
  /** below this vertical speed a landing stops bouncing and rolls */
  bounceMinVz: 1.2,
  /** a body this close to a ground ball can touch/claim it */
  controlRadiusM: 0.9,
  /** ball must be below knee height to claim on the move */
  claimMaxZ: 0.5,
  /** touch push: ball speed = carrier speed × (base + speedGain·(v/vmax) +
   * controlGain·(1 − dribbling/20)) — the ball leaves the boot only slightly
   * faster than the runner. SPEED is the dominant trend (the L2 judgment
   * note): how fast you run moves touch length more than how good your feet
   * are; control tightens it within a speed. */
  touchPushBase: 1.04,
  touchPushSpeedGain: 0.18,
  touchPushControlGain: 0.22,
  /** dribble-to-arrive: a touch is never weighted to outrun the carrier's own
   * destination — push ≤ √(residual² + 2·roll·distToTarget). This is the
   * dribbler's craft (touch weight anticipates the stop); how WELL it is
   * executed becomes noisy with L3. */
  touchArriveResidualMps: 1.0,
  /** a carrier slower than this keeps the ball at his feet (no push) */
  standingSpeedMps: 0.35,
  /** the coupling breaks when the ball escapes this far — possession lost */
  maxDribbleGapM: 4.0,
  /** ticks after a kick during which the kicker cannot claim his own ball */
  kickerLockTicks: 8,
  /** touches alternate feet: lateral push offset per touch (radians, ~7°) —
   * the left-right texture of a real dribble */
  touchAlternateRad: 0.12,
  /** a mid-touch ball (farther than controlRadius from its carrier) is
   * PINCHABLE: the stealer must be in claim reach AND this much closer to
   * the ball than its carrier — the touch is an arrival race. Heavy touches
   * at speed get stolen; a glued ball cannot be pinched (L3's tackle). */
  pinchMarginM: 0.1,
  /** the carrier's body SHIELDS his touch: a pinch needs a clear line —
   * if the carrier stands within this of the stealer→ball line, the steal
   * is blocked (minimal body-blocking; full shielding contests are L3) */
  shieldRadiusM: 0.5,
} as const;

/** Predict the free ball's position `seconds` ahead by cloning and stepping
 * the real physics (bounces included) — the anticipation chasers run to. */
export function predictBall(ball: BallState, seconds: number): Vec2 {
  const clone: BallState = {
    pos: { ...ball.pos }, z: ball.z, vel: { ...ball.vel }, vz: ball.vz,
    phase: ball.phase === 'carried' ? 'rolling' : ball.phase,
    carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
  };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepBall(clone);
  return clone.pos;
}

/** One physics tick for the free ball (rolling or airborne). Carried-ball
 * coupling lives in the sim loop (it needs the carrier's body). */
export function stepBall(ball: BallState): void {
  if (ball.phase === 'airborne') {
    ball.pos = { x: ball.pos.x + ball.vel.x * DT, y: ball.pos.y + ball.vel.y * DT };
    ball.vz -= BALL.gravity * DT;
    ball.z += ball.vz * DT;
    if (ball.z <= 0 && ball.vz < 0) {
      ball.z = 0;
      const vzOut = -ball.vz * BALL.bounceRestitution;
      ball.vel = { x: ball.vel.x * BALL.bounceGroundFriction, y: ball.vel.y * BALL.bounceGroundFriction };
      if (vzOut < BALL.bounceMinVz) {
        ball.vz = 0;
        ball.phase = 'rolling';
      } else {
        ball.vz = vzOut;
      }
    }
    return;
  }
  if (ball.phase === 'rolling' || ball.phase === 'carried') {
    // carried balls between touches ARE rolling balls — same friction
    const speed = Math.hypot(ball.vel.x, ball.vel.y);
    if (speed <= BALL.stopSpeedMps) {
      ball.vel = { x: 0, y: 0 };
      return;
    }
    const next = Math.max(0, speed - BALL.rollDecelMps2 * DT);
    const k = next / speed;
    ball.vel = { x: ball.vel.x * k, y: ball.vel.y * k };
    ball.pos = { x: ball.pos.x + ball.vel.x * DT, y: ball.pos.y + ball.vel.y * DT };
  }
}

/** Strike the ball: direction toward `target`, `speedMps` along the flight
 * chord, lofted by `loftDeg`. Releases any carry. Scenario-exact at L2 —
 * execution noise is L3's. */
export function kickBall(ball: BallState, target: Vec2, speedMps: number, loftDeg: number, kickerId: string, tick: number): void {
  const dx = target.x - ball.pos.x;
  const dy = target.y - ball.pos.y;
  const d = Math.max(Math.hypot(dx, dy), 1e-6);
  const loft = (loftDeg * Math.PI) / 180;
  const vGround = speedMps * Math.cos(loft);
  ball.vel = { x: (dx / d) * vGround, y: (dy / d) * vGround };
  ball.vz = speedMps * Math.sin(loft);
  ball.z = ball.vz > 0 ? 0.01 : 0;
  ball.phase = ball.vz > 0 ? 'airborne' : 'rolling';
  ball.carrierId = null;
  ball.kickerId = kickerId;
  ball.kickerLockUntilTick = tick + BALL.kickerLockTicks;
}
