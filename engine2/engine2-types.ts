/**
 * engine2-types.ts — Engine V2 shared types, Layer 1 (movement kinematics).
 *
 * L1 world: kinematic bodies on a real-dimensioned pitch following movement
 * COMMANDS. No ball, no perception, no decisions, no opponents-as-AI — those
 * are later layers (ENGINE-V2-BEHAVIORAL-SPEC §5). Attributes are the same
 * 0–20 scale as the v1 pool; only the movement-relevant subset exists yet.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Real pitch dimensions in meters — the only pitch L1 knows. */
export const PITCH = { length: 105, width: 68 } as const;

export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ; // 100 ms — spec §3, revisit only after profiling

/** Effort regimes — distinct, speed-ordered gaits (spec §5-L1). The full
 * stamina model lands later; the regime STRUCTURE (an explicit effort state
 * every layer above can read) lands now. */
export type EffortRegime = 'walk' | 'jog' | 'run' | 'sprint';

export const REGIMES: readonly EffortRegime[] = ['walk', 'jog', 'run', 'sprint'];

/** Movement-relevant attributes, 0–20 (same scale/pool as v1's pipeline). */
export interface BodyAttributes {
  pace: number; // top speed
  acceleration: number; // how fast speed builds (and, scaled, braking)
  agility: number; // lateral grip → turning radius as f(speed)
  stamina: number; // reserved: the effort model reads it in the later pass
}

/** Derived stance — read-only presentation/debug signal, never an input. */
export type Stance = 'settled' | 'moving' | 'turning';

export interface BodyInit {
  id: string;
  team: 'home' | 'away';
  pos: Vec2;
  /** radians, 0 = +x; defaults to facing the pitch centre */
  facing?: number;
  attributes: BodyAttributes;
}

/** Movement commands — the whole L1 action vocabulary (scenario scripts
 * issue these; later layers' decisions will). */
export type MovementCommand =
  | { type: 'moveTo'; target: Vec2; regime: EffortRegime }
  | { type: 'followPath'; points: Vec2[]; regime: EffortRegime; stopAtEach?: boolean }
  | { type: 'hold'; facing?: number };

export interface BodyState {
  readonly id: string;
  readonly team: 'home' | 'away';
  readonly attributes: BodyAttributes;
  pos: Vec2;
  vel: Vec2;
  /** cached |vel| — recomputed by the integrator each tick */
  speed: number;
  /** radians, 0 = +x, normalized (−π, π] */
  facing: number;
  regime: EffortRegime;
  stance: Stance;
  command: MovementCommand;
  /** followPath progress */
  pathIndex: number;
  /** true once the current command's motion is complete (arrived / holding) */
  arrived: boolean;
  /** tick of first arrival on the current command (−1 while en route) */
  arrivedAtTick: number;
}

/** One full-rate frame — the internal record, emitted every tick. */
export interface Frame {
  tick: number;
  /** sim seconds */
  t: number;
  bodies: FrameBody[];
}

export interface FrameBody {
  id: string;
  team: 'home' | 'away';
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  regime: EffortRegime;
  stance: Stance;
  /** current movement target (debug overlay), absent when holding */
  tx?: number;
  ty?: number;
}

/** Scenario file format — versioned (spec §6). Version bumps on any shape
 * change; loaders throw on unknown versions rather than guessing. */
export interface ScenarioDef {
  version: 1;
  name: string;
  description: string;
  /** total sim length */
  durationTicks: number;
  bodies: BodyInit[];
  script: ScriptEvent[];
}

/** Script events either fire at an absolute tick (clearing the body's queue —
 * a re-target) or chain after the body's previous command completes. */
export type ScriptEvent =
  | { atTick: number; bodyId: string; command: MovementCommand }
  | { afterPrevious: true; bodyId: string; command: MovementCommand };
