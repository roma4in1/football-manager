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

/** Movement-relevant attributes, 0–20 (same scale as v1's pipeline pool).
 * `balance` is engine2-native (the v1 pool doesn't derive it yet — the
 * pipeline mapping is a later session's work; scenario/bench bodies set it
 * explicitly). */
export interface BodyAttributes {
  pace: number; // top speed
  acceleration: number; // how fast speed builds, and (scaled) braking
  agility: number; // with balance: lateral grip → turn rate and cornering speed
  balance: number; // with agility: staying planted through direction change
  dribbling: number; // L2: touch length while carrying (close control)
  firstTouch: number; // L3: control quality vs ball speed/height/pressure
  passing: number; // L3: kick execution fidelity (direction/power noise)
  tackling: number; // L3: winning physical contests for a glued ball
  strength: number; // L3: tackle weight + shield width (with balance)
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
  /** L4: this body runs the on-ball decision loop when it has (or is sent)
   * the ball. Bodies without a brain follow their script only. */
  brain?: 'onBall';
  /** L4 instruction surface (spec: instructions bias the choice) */
  instructions?: { risk?: number; objective?: 'keep' | 'score' };
}

/** Movement commands — the L1/L2 action vocabulary (scenario scripts issue
 * these; later layers' decisions will). chaseBall targets the ball's live
 * position and completes when ANY body claims it (the race resolves). */
export type MovementCommand =
  | { type: 'moveTo'; target: Vec2; regime: EffortRegime }
  | { type: 'followPath'; points: Vec2[]; regime: EffortRegime; stopAtEach?: boolean }
  | { type: 'chaseBall'; regime: EffortRegime }
  | { type: 'hold'; facing?: number };

/** Script-only ball actions (L2): an exact strike — noise arrives with L3. */
export interface KickEvent {
  atTick: number;
  bodyId: string; // must be the carrier at that tick, else the kick is a no-op
  kick: { target: Vec2; speedMps: number; loftDeg: number };
}

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
  ball: FrameBall;
}

export interface FrameBall {
  x: number;
  y: number;
  z: number;
  phase: 'carried' | 'rolling' | 'airborne' | 'dead';
  carrierId: string | null;
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
  /** L4: the current decision, for the action-label overlay (spec §4) —
   * e.g. "carry", "pass→p3", "shoot", "shield", "clear", "receive" */
  action?: string;
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
  /** initial ball placement (default: at rest on the centre spot). `carrier`
   * starts the ball at that body's feet, coupled. */
  ball?: { pos?: Vec2; carrier?: string };
  /** scripted strikes (L2) */
  kicks?: KickEvent[];
}

/** Script events either fire at an absolute tick (clearing the body's queue —
 * a re-target) or chain after the body's previous command completes. */
export type ScriptEvent =
  | { atTick: number; bodyId: string; command: MovementCommand }
  | { afterPrevious: true; bodyId: string; command: MovementCommand };
