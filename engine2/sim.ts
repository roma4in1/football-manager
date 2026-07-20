/**
 * sim.ts — the L1 simulation loop: fixed 10 Hz tick over kinematic bodies
 * following scripted movement commands (spec §3, §5-L1).
 *
 * The sim emits FULL-RATE frames internally (one per tick — the workbench
 * judges these); the stored/replayable format is the decimated stream in
 * frames.ts. Deterministic by construction: no wall clock, no unkeyed
 * randomness, body order fixed by the scenario definition.
 */

import { DT, type BodyState, type Frame, type FrameBody, type MovementCommand, type ScenarioDef } from './engine2-types.ts';
import { currentTarget, stepBody } from './kinematics.ts';
import { KeyedRng } from './keyed-rng.ts';

export class Sim {
  readonly bodies: BodyState[];
  readonly rng: KeyedRng;
  tick = 0;
  private readonly byId = new Map<string, BodyState>();
  private readonly atTick = new Map<number, Array<{ bodyId: string; command: MovementCommand }>>();
  private readonly queues = new Map<string, MovementCommand[]>();

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
  }

  /** advance one tick; returns the full-rate frame for it */
  step(): Frame {
    // scripted re-targets fire first — an atTick command interrupts (clears
    // the chain queue is NOT desired: afterPrevious chains model planned
    // routes; an atTick event models an external re-decision and replaces
    // only the current command)
    const events = this.atTick.get(this.tick);
    if (events) {
      for (const ev of events) {
        const body = this.byId.get(ev.bodyId)!;
        this.assign(body, ev.command);
      }
    }
    for (const body of this.bodies) {
      stepBody(body, this.tick);
      // command complete → pull the next chained command (it starts next tick)
      if (body.arrived) {
        const next = this.queues.get(body.id)!.shift();
        if (next) this.assign(body, next);
      }
    }
    const frame = this.snapshot();
    this.tick++;
    return frame;
  }

  private assign(body: BodyState, command: MovementCommand): void {
    body.command = command;
    body.pathIndex = 0;
    body.arrived = command.type === 'hold' && command.facing === undefined && body.speed <= 0.02;
    body.arrivedAtTick = body.arrived ? this.tick : -1;
  }

  private snapshot(): Frame {
    const bodies: FrameBody[] = this.bodies.map((b) => {
      const target = currentTarget(b);
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
    return { tick: this.tick, t: this.tick * DT, bodies };
  }
}

/** Run a scenario start-to-finish; the full-rate frame list is the result. */
export function runScenario(def: ScenarioDef, seed = 'workbench'): Frame[] {
  const sim = new Sim(def, seed);
  const frames: Frame[] = [];
  for (let i = 0; i < def.durationTicks; i++) frames.push(sim.step());
  return frames;
}
