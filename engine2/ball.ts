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
  /** SIDESPIN about the vertical axis (rad/s, signed): a moving ball curves
   * perpendicular to its travel via the Magnus force. + bends to the right of
   * travel, − to the left. Topspin/backspin (dip/float) deferred. */
  spin: number;
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
  // ── physical properties (reference/physics.md) — the roll/drag decel is
  // DERIVED from these below, not hand-tuned: a = μ·g + (½ρ·Cd·A/m)·v². ─────
  /** FIFA regulation ball */
  massKg: 0.43,
  radiusM: 0.11,
  airDensity: 1.225, // kg/m³ at sea level
  dragCoefficient: 0.22, // sphere in the football Reynolds regime
  magnusCoefficient: 0.42, // physics.md baseline 0.18; raised for VISIBLE
  // gameplay curl (a stylised bend, as the pitch friction was raised too)
  spinDecayPerS: 0.08, // spin bleeds ~8%/s (physics.md: smooth decay)
  /** rolling-resistance coefficient of the surface; the constant rolling
   * decel is μ·g. physics.md lists 0.018 (that is an ARTIFICIAL-TURF / smooth
   * value — it makes a soft pass trickle ~70 m, contradicting a real pitch),
   * and separately notes "dry grass: HIGH resistance". A match pitch is
   * grass, so we use a dry-grass μ: with the (physical) v²-drag on top, a
   * firm 16 m/s pass dies in ~30 m, a soft 8 m/s ball in ~10 m — believable. */
  rollingFrictionCoeff: 0.30,
  /** the CARRIED ball between touches rolls on the tuned dribble constant —
   * the judged L2/L3 dribble/knock-past feel was calibrated to it, and a
   * dribbler caresses the ball every stride rather than letting it roll
   * free. Only genuinely FREE balls (passes, shots, loose) get real drag. */
  dribbleRollDecelMps2: 1.7,
  /** below this a roll is at rest (still 'rolling' — i.e. loose, claimable) */
  stopSpeedMps: 0.15,
  gravity: 9.81,
  /** energy retained normal to the pitch per bounce (physics.md: 0.70–0.78) */
  bounceRestitution: 0.72,
  /** horizontal speed kept through a bounce (turf scrubs pace off) */
  bounceGroundFriction: 0.75,
  /** below this vertical speed a landing stops bouncing and rolls */
  bounceMinVz: 1.2,
  /** a body this close to a ground ball can touch/claim it */
  controlRadiusM: 0.9,
  /** ball must be below knee height to claim on the move */
  claimMaxZ: 0.5,
  /** HEADER contest: a ball in this height band (above the foot, up to a
   * leap) is contested in the AIR — the winner heads it. Reach is standing
   * head height plus a strength-scaled jump. */
  headMinZ: 0.9,
  headMaxZ: 2.5,
  headReachM: 1.5, // horizontal reach to leap for it
  /** 3-D COLLISION: a body in the path of a DRIVEN airborne ball deflects it if
   * it passes through his reach — feet up to the leap the header uses
   * (headStandM + headJumpPerStr·strength), so reach is PER-PLAYER. This makes
   * interception xyz, not xy: a shot/cross at body height hits the man in the
   * way; one flighted OVER his reach clears. A leaping header (above) is the
   * deliberate version; this is the reactive deflection. */
  blockMinSpeedMps: 9, // slower than this the ball is CONTROLLED, not deflected
  blockDeflectKeep: 0.35, // an OPPONENT'S block scrubs most of the pace off
  collisionDeflectKeep: 0.55, // a teammate not defending caroms more pace on
  headStandM: 1.9,
  headJumpPerStr: 0.03, // strength 20 → +0.6 m → 2.5 m reach
  headContestNoise: 0.9,
  /** a header REDIRECTS the ball's pace — the power comes mostly from the BALL,
   * not the neck: headed = incoming·headRedirect + headPlayerPower·(str/20)·attack.
   * So a header off a fast cross flies, one off a floated lob is weak. The
   * player term is EARNED by attacking the ball — his approach/leap speed into
   * it (attack = clamp(speed/ref, floor, 1)); a passive nod under a weak lob
   * generates almost nothing, a committed header drives through it. A defensive
   * header CLEARS (lofted, far, upfield); an attacking one is driven at goal;
   * else a knock-DOWN cushions the pace out. */
  headRedirect: 0.7,
  headPlayerPower: 5,
  headAttackRefMps: 5, // approach speed for a FULL player contribution
  headPassiveFloor: 0.2, // a standing header still snaps the neck a little
  headClearLoftDeg: 34,
  headClearScatterRad: 0.35,
  headKnockCushion: 0.2, // a controlled header down keeps only this of the pace
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
  /** far-foot dribbling: with an opponent inside this range, touches stop
   * alternating and bias AWAY from him — you don't play the ball into a
   * marker's side (the L3 duel-rate finding) */
  touchShieldRangeM: 2.4,
  touchShieldRad: 0.16,
  /** PRESSURE shortens the touch: with a defender set AHEAD (inside the
   * awareness range, within the front cone), the touch's roll-out is capped
   * to a fraction of the gap — a cruise-weight push into a closing
   * defender's zone is a gift (the instant pinch that killed the head-on
   * duel). Better feet keep it closer; heavy feet still serve the pinch. */
  pressAwareRangeM: 4.5,
  pressAwareConeCos: 0.5, // ±60° of the touch heading
  pressRollFracBase: 0.55,
  pressRollFracControlGain: 0.15, // dribbling 20 → 0.40·gap; dribbling 0 → 0.55·gap
  pressRollMinM: 0.7,
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

// ── derived physical constants (physics.md) ────────────────────────────────
/** aerodynamic drag deceleration per v²: a_drag = ½·ρ·Cd·A/m · v² (A = πr²).
 * ≈ 0.0119 /m — the dominant slowing term on a struck ball. */
export const DRAG_K = 0.5 * BALL.airDensity * BALL.dragCoefficient *
  (Math.PI * BALL.radiusM * BALL.radiusM) / BALL.massKg;
/** constant rolling-resistance decel of a free ball: μ·g ≈ 0.177 m/s². */
export const ROLL_FRICTION_MPS2 = BALL.rollingFrictionCoeff * BALL.gravity;
/** Magnus lateral accel per (spin·v): a = ½·ρ·A·Cmag·r/m · spin · v_h ≈
 * 0.0011 — so a spin of ~60 rad/s at 25 m/s bends the ball ~1–2 m. Applied
 * perpendicular to the horizontal velocity (the curve). */
export const MAGNUS_K = 0.5 * BALL.airDensity * (Math.PI * BALL.radiusM * BALL.radiusM) *
  BALL.magnusCoefficient * BALL.radiusM / BALL.massKg;

/** apply the sidespin Magnus curve to a moving ball's horizontal velocity and
 * bleed the spin — shared by the airborne and rolling steps. */
function applyMagnus(ball: BallState): void {
  if (Math.abs(ball.spin) < 0.5) return;
  const vh = Math.hypot(ball.vel.x, ball.vel.y);
  if (vh < 0.5) return;
  // force ∝ ω × v: for +spin (about +z) the ball curves to the LEFT of travel
  const a = MAGNUS_K * ball.spin; // × (−vy, vx) below (magnitude a·vh)
  ball.vel = { x: ball.vel.x - a * ball.vel.y * DT, y: ball.vel.y + a * ball.vel.x * DT };
  ball.spin *= 1 - BALL.spinDecayPerS * DT;
}

/** Predict the free ball's position `seconds` ahead by cloning and stepping
 * the real physics (bounces included) — the anticipation chasers run to. */
export function predictBall(ball: BallState, seconds: number): Vec2 {
  const clone: BallState = {
    pos: { ...ball.pos }, z: ball.z, vel: { ...ball.vel }, vz: ball.vz, spin: ball.spin,
    // PRESERVE the phase so the roll friction matches reality: a carried
    // ball is predicted on the dribble constant (the carrier fetching his
    // own touch, a chaser reading a dribble), a free ball on the realistic
    // drag. Converting carried→rolling made the fetch predict a too-short
    // roll and the dribbled ball escaped its own carrier's orbit.
    phase: ball.phase === 'dead' ? 'rolling' : ball.phase,
    carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
  };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepBall(clone);
  return clone.pos;
}

/** predictBall with HEIGHT — a receiver reads not just where the ball goes but
 * whether it is claimable (below knee height) and descending there, so he
 * runs to the DROP, not to a point where it is still over his head. */
export function predictBallState(ball: BallState, seconds: number): { pos: Vec2; z: number; vz: number } {
  const clone: BallState = {
    pos: { ...ball.pos }, z: ball.z, vel: { ...ball.vel }, vz: ball.vz, spin: ball.spin,
    phase: ball.phase === 'dead' ? 'rolling' : ball.phase,
    carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
  };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepBall(clone);
  return { pos: clone.pos, z: clone.z, vz: clone.vz };
}

/** One physics tick for the free ball (rolling or airborne). Carried-ball
 * coupling lives in the sim loop (it needs the carrier's body). */
export function stepBall(ball: BallState): void {
  if (ball.phase === 'airborne') {
    applyMagnus(ball); // the curve — sidespin bends the horizontal path
    // gravity + aerodynamic drag on the FULL 3-D velocity (physics.md flight
    // model): drag opposes the velocity vector, magnitude DRAG_K·|v|² — long
    // shots and crosses lose pace in the air, not only on the ground
    const sp3 = Math.hypot(ball.vel.x, ball.vel.y, ball.vz);
    const kd = DRAG_K * sp3;
    ball.pos = { x: ball.pos.x + ball.vel.x * DT, y: ball.pos.y + ball.vel.y * DT };
    ball.vel = { x: ball.vel.x - kd * ball.vel.x * DT, y: ball.vel.y - kd * ball.vel.y * DT };
    ball.vz -= (BALL.gravity + kd * ball.vz) * DT;
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
    if (ball.phase === 'rolling') applyMagnus(ball); // a curving ground ball (trivela)
    const speed = Math.hypot(ball.vel.x, ball.vel.y);
    if (speed <= BALL.stopSpeedMps) {
      ball.vel = { x: 0, y: 0 };
      return;
    }
    // a FREE ball gets the derived physics (rolling resistance + v²-drag); a
    // carried ball between touches rolls on the tuned dribble constant
    const decel = ball.phase === 'carried'
      ? BALL.dribbleRollDecelMps2
      : ROLL_FRICTION_MPS2 + DRAG_K * speed * speed;
    const next = Math.max(0, speed - decel * DT);
    const k = next / speed;
    ball.vel = { x: ball.vel.x * k, y: ball.vel.y * k };
    ball.pos = { x: ball.pos.x + ball.vel.x * DT, y: ball.pos.y + ball.vel.y * DT };
  }
}

// ── closed-form roll relations for a = A + B·v² (A=rollFriction, B=rollDrag).
// v·dv/dx = −(A+B v²) integrates exactly, so the decision layer can weight a
// pass against the SAME physics stepBall runs — no constant-decel fiction. ──
const rollA = (): number => ROLL_FRICTION_MPS2;
const rollB = (): number => DRAG_K;

/** speed of a ball after it has rolled `d` metres from launch speed `v0`
 * (0 if it comes to rest within `d`). */
export function rollSpeedAfter(v0: number, d: number): number {
  const A = rollA(), B = rollB();
  const s2 = ((A + B * v0 * v0) * Math.exp(-2 * B * d) - A) / B;
  return s2 > 0 ? Math.sqrt(s2) : 0;
}

/** launch speed so the ball ARRIVES at `va` m/s after rolling `d` metres —
 * the inverse of rollSpeedAfter (va=0 gives the speed that just dies at d). */
export function rollLaunchForArrival(va: number, d: number): number {
  const A = rollA(), B = rollB();
  const s2 = ((A + B * va * va) * Math.exp(2 * B * d) - A) / B;
  return Math.sqrt(Math.max(0, s2));
}

/** distance a ball at `v0` needs to slow to `v` (v=0 → roll-out to rest). */
export function rollDistance(v0: number, v = 0): number {
  const A = rollA(), B = rollB();
  return (1 / (2 * B)) * Math.log((A + B * v0 * v0) / (A + B * v * v));
}

/** time for a ball at `v0` to travel `d` metres (∞-safe: if it stops first,
 * the time to stop). dt = −dv/(A+B v²) integrates to an arctangent. */
export function rollTimeToDistance(v0: number, d: number): number {
  const A = rollA(), B = rollB();
  const v = rollSpeedAfter(v0, d);
  const k = Math.sqrt(B / A);
  return (1 / Math.sqrt(A * B)) * (Math.atan(v0 * k) - Math.atan(v * k));
}

/** Launch SPEED (along the flight chord) so a ball lofted at `loftDeg` lands
 * (z→0) at horizontal distance `dist` m — numeric, since drag has no closed
 * form. Binary search over the flight sim. Clamped to a sane kick range; a
 * distance unreachable at this loft returns the ceiling. */
export function solveLoftSpeed(dist: number, loftDeg: number): number {
  const loft = (loftDeg * Math.PI) / 180;
  const cos = Math.cos(loft), sin = Math.sin(loft);
  const landsAt = (speed: number): number => {
    const b: BallState = {
      pos: { x: 0, y: 0 }, z: 0.01, vel: { x: speed * cos, y: 0 }, vz: speed * sin, spin: 0,
      phase: 'airborne', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
    };
    // the FIRST ground contact — where the ball DROPS onto the receiver, not
    // where it comes to rest after bouncing on. A loft/cross/switch is aimed to
    // land ON its man; solving for the post-bounce roll made every one undershoot
    let wasUp = false;
    for (let i = 0; i < 600; i++) {
      stepBall(b);
      if (b.z > 0.1) wasUp = true;
      if (wasUp && b.z <= 0.02) break; // first descent back to the turf
      if (b.phase !== 'airborne') break;
    }
    return b.pos.x;
  };
  let lo = 8, hi = 42;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (landsAt(mid) < dist) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** seconds to the FIRST ground contact (the HANG TIME) for a loft of `speed`
 * at `loftDeg` — so a moving receiver can be led by where he'll be on the
 * drop, not where he stood when it was struck (a long float hangs ~3 s). */
export function loftFlightTimeS(speed: number, loftDeg: number): number {
  const loft = (loftDeg * Math.PI) / 180;
  const b: BallState = {
    pos: { x: 0, y: 0 }, z: 0.01, vel: { x: speed * Math.cos(loft), y: 0 }, vz: speed * Math.sin(loft), spin: 0,
    phase: 'airborne', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
  };
  let wasUp = false;
  for (let i = 0; i < 600; i++) {
    stepBall(b);
    if (b.z > 0.1) wasUp = true;
    if ((wasUp && b.z <= 0.02) || b.phase !== 'airborne') return (i + 1) * DT;
  }
  return 600 * DT;
}

/** apex height of a lofted flight (for the decision's "does it clear him?"). */
export function loftApex(dist: number, loftDeg: number): number {
  const speed = solveLoftSpeed(dist, loftDeg);
  const loft = (loftDeg * Math.PI) / 180;
  const b: BallState = {
    pos: { x: 0, y: 0 }, z: 0.01, vel: { x: speed * Math.cos(loft), y: 0 }, vz: speed * Math.sin(loft), spin: 0,
    phase: 'airborne', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
  };
  let apex = 0;
  for (let i = 0; i < 600 && b.phase === 'airborne'; i++) { stepBall(b); apex = Math.max(apex, b.z); }
  return apex;
}

/** Strike the ball: direction toward `target`, `speedMps` along the flight
 * chord, lofted by `loftDeg`. Releases any carry. Scenario-exact at L2 —
 * execution noise is L3's. */
export function kickBall(ball: BallState, target: Vec2, speedMps: number, loftDeg: number, kickerId: string, tick: number, spin = 0): void {
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
  ball.spin = spin;
}
