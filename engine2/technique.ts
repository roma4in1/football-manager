/**
 * technique.ts — L3 individual technique (spec §5-L3): first touch, kick
 * execution noise, tackles as physical contests, shielding scale.
 *
 * The v1 invariant carried forward: situation biases WHAT is attempted
 * (scripts now, decisions at L4); attributes govern how well it is EXECUTED.
 * Every stochastic draw is keyed (tick, bodyId, purpose) — same scenario,
 * same seed, byte-identical.
 */

import type { BodyAttributes, Vec2 } from './engine2-types.ts';
import type { KeyedRng } from './keyed-rng.ts';

export const TECH = {
  // ── first touch: control quality vs ball speed/height/pressure ───────────
  /** pop-loose probability baseline at trivial ball speed, no pressure */
  touchPopBase: 0.02,
  /** + per m/s of ball speed above the easy band */
  touchPopPerMps: 0.055,
  touchEasySpeedMps: 4,
  /** a dropping/bouncing ball (height at contact) is harder */
  touchPopPerMeterZ: 0.25,
  /** an opponent within pressure range raises the difficulty */
  touchPressureRangeM: 2.5,
  touchPopPressure: 0.22,
  /** controlling at speed is harder than standing — per m/s of the
   * RECEIVER'S own speed (walking ~+0.03, running ~+0.13, sprint ~+0.19) */
  touchPopPerReceiverMps: 0.025,
  /** skill relief: firstTouch 20 removes this much of the difficulty */
  touchSkillRelief: 0.75,
  /** a popped ball squirts this far, scattered around the arrival direction */
  popSpeedMinMps: 2.2,
  popSpeedMaxMps: 4.5,
  popScatterRad: 0.9,
  /** a KILLED ball still sits slightly off the boot */
  killResidualMps: 0.4,
  /** the DIRECTIONAL first touch: a moving receiver's control redirects the
   * ball into his route at ~his own speed — heavier with poor feet. A
   * standing receiver still kills it dead. */
  directionalTouchBase: 1.02,
  directionalTouchControlGain: 0.2,

  // ── kick execution noise (pass family; shots arrive with goals) ──────────
  /** direction sigma at passing 0, radians (~9°); passing 20 → ~1.5° */
  kickDirSigmaRad: 0.13,
  kickDirSkillFloor: 0.15,
  /** power sigma share at passing 0 (~12%); skill floor keeps elite honest */
  kickVelSigma: 0.12,
  kickVelSkillFloor: 0.2,
  /** a kick needs the ball at the boot — reach-gated (the audit item) */
  kickReachM: 1.1,

  // ── tackles: physical contests for a GLUED ball ──────────────────────────
  /** the tackler must reach the ball (not just the man) */
  tackleReachM: 1.3,
  /** attempts per contest are paced — a lunge, recover, go again */
  tackleCooldownTicks: 12,
  /** logistic scale on the (tackler − carrier) composite edge */
  tackleEdgeScale: 0.11,
  tackleBaseP: 0.42,
  /** a won tackle knocks the ball this fast, away from the carrier */
  tackleKnockMinMps: 3.0,
  tackleKnockMaxMps: 5.5,
  tackleKnockScatterRad: 0.7,
  /** lunging at a MOVING carrier is much harder than a standing one:
   * winP × 1/(1 + this × carrierSpeed) — full sprint ≈ 0.4× */
  tackleCarrierSpeedFactor: 0.2,

  // ── shielding: strength+balance widen the body shield ────────────────────
  shieldBaseM: 0.3,
  shieldPerCompositeM: 0.25, // × (strength+balance)/40 → 0.3–0.55 m

  // ── bodies are solid (the audit item): soft pairwise separation ──────────
  bodyRadiusM: 0.35,
  /** overlap resolves at a bounded speed — solid but soft, never a snap */
  separationSpeedMps: 2.5,
} as const;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** P(the first touch pops loose) — the spec's acceptance line in a formula:
 * a poor touch under pressure pops loose; a great one kills a driven ball. */
export function touchPopProbability(
  receiver: BodyAttributes,
  closingSpeed: number,
  ballZ: number,
  pressured: boolean,
  receiverSpeed = 0,
): number {
  const difficulty =
    TECH.touchPopBase +
    TECH.touchPopPerMps * Math.max(0, closingSpeed - TECH.touchEasySpeedMps) +
    TECH.touchPopPerMeterZ * ballZ +
    TECH.touchPopPerReceiverMps * receiverSpeed +
    (pressured ? TECH.touchPopPressure : 0);
  const relief = 1 - TECH.touchSkillRelief * (receiver.firstTouch / 20);
  return clamp01(difficulty * relief);
}

/** Resolve a trap: either killed at the boot or popped loose. Returns the
 * ball's post-contact velocity; `pop` tells the sim not to award the carry. */
export function resolveFirstTouch(
  rng: KeyedRng,
  tick: number,
  bodyId: string,
  receiver: BodyAttributes,
  arrivalDir: number,
  closingSpeed: number,
  ballZ: number,
  pressured: boolean,
  receiverSpeed = 0,
): { pop: boolean; vel: Vec2 } {
  const p = touchPopProbability(receiver, closingSpeed, ballZ, pressured, receiverSpeed);
  if (rng.chance(p, tick, bodyId, 'first-touch')) {
    const dir = arrivalDir + rng.gauss(0, TECH.popScatterRad, tick, bodyId, 'touch-pop-dir');
    const speed = TECH.popSpeedMinMps +
      (TECH.popSpeedMaxMps - TECH.popSpeedMinMps) * rng.float(tick, bodyId, 'touch-pop-v');
    return { pop: true, vel: { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed } };
  }
  return { pop: false, vel: { x: 0, y: 0 } };
}

/** Kick execution noise: attributes govern the strike's fidelity. */
export function noisyKick(
  rng: KeyedRng,
  tick: number,
  kickerId: string,
  kicker: BodyAttributes,
  target: Vec2,
  from: Vec2,
  speedMps: number,
): { target: Vec2; speedMps: number } {
  const slack = 1 - kicker.passing / 20;
  const dirSigma = TECH.kickDirSigmaRad * (TECH.kickDirSkillFloor + (1 - TECH.kickDirSkillFloor) * slack);
  const velSigma = TECH.kickVelSigma * (TECH.kickVelSkillFloor + (1 - TECH.kickVelSkillFloor) * slack);
  const base = Math.atan2(target.y - from.y, target.x - from.x);
  const dir = base + rng.gauss(0, dirSigma, tick, kickerId, 'kick-dir');
  const d = Math.hypot(target.x - from.x, target.y - from.y);
  const speed = Math.max(1, speedMps * (1 + rng.gauss(0, velSigma, tick, kickerId, 'kick-vel')));
  return {
    target: { x: from.x + Math.cos(dir) * d, y: from.y + Math.sin(dir) * d },
    speedMps: speed,
  };
}

/** P(the tackler wins the ball) — a physical contest, not a dice roll on
 * nothing: tackling+strength vs dribbling+balance (the shield composite). */
export function tackleWinProbability(tackler: BodyAttributes, carrier: BodyAttributes): number {
  const edge = (tackler.tackling + 0.5 * tackler.strength) - (carrier.dribbling + 0.5 * carrier.balance);
  return clamp01(TECH.tackleBaseP + TECH.tackleEdgeScale * edge * 0.5);
}

/** shield radius for a carrier — strength and balance hold defenders off */
export const shieldRadiusM = (carrier: BodyAttributes): number =>
  TECH.shieldBaseM + TECH.shieldPerCompositeM * ((carrier.strength + carrier.balance) / 40);
