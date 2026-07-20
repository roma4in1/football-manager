/**
 * kinematics.ts — the L1 movement integrator. Pure per-body, per-tick.
 *
 * The model (spec §3/§5-L1): bodies carry momentum. Speed builds along a
 * force–velocity curve (available acceleration falls off linearly as speed
 * approaches top speed — the classic sprint model), braking is stronger than
 * accelerating, and heading changes are bounded by lateral grip: the maximum
 * turn rate at speed v is ω = a_lat / v, i.e. turning radius r = v²/a_lat
 * GROWS with the square of speed. A sprinting player asked to reverse
 * therefore brakes, carves a tight low-speed turn, and re-accelerates —
 * never pivots in place at speed. At near-standstill a pivot IS allowed
 * (humans do), rate-limited by the same grip number.
 *
 * Attribute mapping (0–20 → physical units) targets real football ranges:
 *   pace 20 → 10.2 m/s top speed (elite), pace 10 → 7.6 (journeyman);
 *   accel 20 → 8.0 m/s² peak (reaches ~90% top speed in ~2.5–3 s ≈ 30–40 m);
 *   agility 20 → 9.1 m/s² lateral grip (sprint turning radius ~11 m,
 *   jog radius ~1.5 m). Extremes (1) stay human: 5.3 m/s / 3.4 m/s² / 3.8.
 *
 * Everything here is deterministic — no RNG in L1 motion.
 */

import { DT, type BodyState, type EffortRegime, type Vec2 } from './engine2-types.ts';

export const KIN = {
  /** top speed: 5.0 + 0.26 × pace (m/s) */
  topSpeedBase: 5.0,
  topSpeedPerPoint: 0.26,
  /** peak acceleration: 3.2 + 0.24 × acceleration (m/s²), available in full
   * only from standstill — see forceVelocityFloor */
  accelBase: 3.2,
  accelPerPoint: 0.24,
  /** braking beats accelerating (studs in the ground) */
  brakeFactor: 1.3,
  /** lateral grip: 3.5 + 0.28 × agility (m/s²) — bounds turn rate ω = grip/v */
  gripBase: 3.5,
  gripPerPoint: 0.28,
  /** force–velocity: available accel = peak × max(floor, 1 − v/vmax) */
  forceVelocityFloor: 0.06,
  /** regime caps as shares of personal top speed (walk is absolute-capped —
   * walking pace barely varies with sprint pace) */
  regimeShare: { walk: 0.25, jog: 0.5, run: 0.78, sprint: 1.0 } as Record<EffortRegime, number>,
  walkCapMps: 1.6,
  /** arrival: inside this of the target with speed below settle = arrived */
  arriveTolM: 0.35,
  settleSpeedMps: 0.25,
  /** deceleration profile aims to hit the target at this residual speed —
   * a real stop is a firm plant, not an asymptote */
  arriveResidualMps: 0.4,
  /** misalignment beyond which a mover brakes hard to turn (radians, ~50°) */
  hardTurnRad: 0.9,
  /** the speed floor used for turn-rate math — prevents ω → ∞ at v → 0 and
   * sets the standstill pivot rate (grip / this ≈ 4–7 rad/s) */
  pivotSpeedFloor: 1.3,
  /** facing turns toward the velocity direction at this rate (rad/s) */
  facingTurnRate: 7.0,
  /** stance: 'turning' when the commanded heading is off by more than this */
  turningStanceRad: 0.35,
} as const;

export const topSpeedMps = (pace: number): number => KIN.topSpeedBase + KIN.topSpeedPerPoint * pace;
export const accelPeakMps2 = (acceleration: number): number => KIN.accelBase + KIN.accelPerPoint * acceleration;
export const brakePeakMps2 = (acceleration: number): number => KIN.brakeFactor * accelPeakMps2(acceleration);
export const lateralGripMps2 = (agility: number): number => KIN.gripBase + KIN.gripPerPoint * agility;

export const regimeCapMps = (pace: number, regime: EffortRegime): number => {
  const vmax = topSpeedMps(pace);
  const cap = vmax * KIN.regimeShare[regime];
  return regime === 'walk' ? Math.min(KIN.walkCapMps, cap) : cap;
};

/** turning radius at speed v — exported for assertions/overlays */
export const turningRadiusM = (agility: number, v: number): number =>
  (v * v) / lateralGripMps2(agility);

export const normalizeAngle = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
};

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** current waypoint of the command, or null when holding/done */
export function currentTarget(body: BodyState): Vec2 | null {
  const c = body.command;
  if (c.type === 'moveTo') return c.target;
  if (c.type === 'followPath') return c.points[body.pathIndex] ?? null;
  return null;
}

/**
 * Advance one body one tick. Mutates in place (the sim owns its states;
 * frames snapshot). Returns nothing — arrival is body.arrived.
 */
export function stepBody(body: BodyState, tick: number): void {
  const c = body.command;
  const target = currentTarget(body);
  const vmax = topSpeedMps(body.attributes.pace);
  const accel = accelPeakMps2(body.attributes.acceleration);
  const brake = brakePeakMps2(body.attributes.acceleration);
  const grip = lateralGripMps2(body.attributes.agility);

  if (target === null) {
    // hold: bleed residual speed with the brake, settle, rotate to any
    // commanded facing
    decayToStop(body, brake);
    if (c.type === 'hold' && c.facing !== undefined) rotateFacing(body, c.facing);
    else if (body.speed > KIN.settleSpeedMps) rotateFacing(body, Math.atan2(body.vel.y, body.vel.x));
    body.stance = body.speed > KIN.settleSpeedMps ? 'moving' : 'settled';
    if (!body.arrived) {
      body.arrived = true;
      body.arrivedAtTick = tick;
    }
    return;
  }

  const d = dist(body.pos, target);
  const isFinalPoint = c.type === 'moveTo' ||
    (c.type === 'followPath' && body.pathIndex >= c.points.length - 1);
  const mustStopHere = isFinalPoint || (c.type === 'followPath' && c.stopAtEach === true);

  // ── arrival check ─────────────────────────────────────────────────────────
  if (d <= KIN.arriveTolM && (!mustStopHere || body.speed <= KIN.settleSpeedMps + 0.15)) {
    if (c.type === 'followPath' && body.pathIndex < c.points.length - 1) {
      body.pathIndex++; // next waypoint, momentum carries through
    } else {
      body.command = { type: 'hold' };
      decayToStop(body, brake);
      body.stance = 'settled';
      if (!body.arrived) {
        body.arrived = true;
        body.arrivedAtTick = tick;
      }
      return;
    }
  }

  const regime = c.type === 'hold' ? 'walk' : c.regime;
  const cap = regimeCapMps(body.attributes.pace, regime);

  // ── desired speed: regime cap, shaved by arrival braking and by turn need ─
  let desired = cap;

  // decelerate-to-arrive: from distance d, the speed we can carry and still
  // stop (v² = residual² + 2·brake·d). Only where this leg must end in a stop.
  if (mustStopHere) {
    const vArrive = Math.sqrt(
      KIN.arriveResidualMps * KIN.arriveResidualMps + 2 * brake * Math.max(0, d - KIN.arriveTolM * 0.5),
    );
    desired = Math.min(desired, vArrive);
  }

  // heading the command wants vs the heading momentum has
  const want = Math.atan2(target.y - body.pos.y, target.x - body.pos.x);
  const have = body.speed > 0.05 ? Math.atan2(body.vel.y, body.vel.x) : body.facing;
  const misalign = normalizeAngle(want - have);
  const misalignAbs = Math.abs(misalign);

  // a mover badly misaligned brakes to its cornering speed: grip bounds the
  // arc, so the tighter the needed turn, the slower the body must go. Beyond
  // hardTurnRad the answer approaches "brake right down, carve, re-launch".
  if (misalignAbs > 0.15 && body.speed > 0.5) {
    const alignFactor = misalignAbs >= KIN.hardTurnRad
      ? 0.18
      : 1 - (1 - 0.18) * (misalignAbs / KIN.hardTurnRad) ** 1.5;
    desired = Math.min(desired, Math.max(cap * alignFactor, KIN.pivotSpeedFloor * 0.9));
  }

  // ── turn: heading change bounded by ω = grip / v ──────────────────────────
  const omegaMax = grip / Math.max(body.speed, KIN.pivotSpeedFloor);
  const dTheta = Math.sign(misalign) * Math.min(misalignAbs, omegaMax * DT);
  const heading = have + dTheta;

  // ── speed: accelerate along the force–velocity curve / brake ──────────────
  const accelAvail = accel * Math.max(KIN.forceVelocityFloor, 1 - body.speed / vmax);
  const dv = desired >= body.speed
    ? Math.min(desired - body.speed, accelAvail * DT)
    : -Math.min(body.speed - desired, brake * DT);
  const speed = Math.max(0, body.speed + dv);

  body.vel = { x: Math.cos(heading) * speed, y: Math.sin(heading) * speed };
  body.speed = speed;
  body.pos = { x: body.pos.x + body.vel.x * DT, y: body.pos.y + body.vel.y * DT };
  body.regime = regime;
  body.stance = misalignAbs > KIN.turningStanceRad ? 'turning' : speed > KIN.settleSpeedMps ? 'moving' : 'settled';
  if (speed > KIN.settleSpeedMps) rotateFacing(body, heading);
}

function decayToStop(body: BodyState, brake: number): void {
  const speed = Math.max(0, body.speed - brake * DT);
  if (speed <= 0.02) {
    body.vel = { x: 0, y: 0 };
    body.speed = 0;
    return;
  }
  const h = Math.atan2(body.vel.y, body.vel.x);
  body.vel = { x: Math.cos(h) * speed, y: Math.sin(h) * speed };
  body.speed = speed;
  body.pos = { x: body.pos.x + body.vel.x * DT, y: body.pos.y + body.vel.y * DT };
}

function rotateFacing(body: BodyState, toward: number): void {
  const delta = normalizeAngle(toward - body.facing);
  const step = Math.sign(delta) * Math.min(Math.abs(delta), KIN.facingTurnRate * DT);
  body.facing = normalizeAngle(body.facing + step);
}
