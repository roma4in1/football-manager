/**
 * agent-rng.ts — KEYED randomness for the agent engine.
 *
 * The aggregate engine draws from one sequential stream, which makes every
 * outcome sensitive to draw ORDER — adding a single attribute reshuffled all
 * harness streams and forced a recalibration (longPassing PR). The agent
 * engine is born keyed instead: every draw is addressed by
 * (namespace, ...parts) — typically (tick, playerId, purpose) — so inserting
 * a new consumer never perturbs existing draws.
 *
 * Determinism: same namespace + parts ⇒ same values, independent of call
 * order. Cost: one seeded-generator construction per stream request; fine at
 * scaffold scale, revisit if profiling says otherwise.
 */

import { Rng } from './engine-rng.ts';

export type KeyPart = string | number;

export class KeyedRng {
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /** A fresh deterministic stream for one logical draw site. Take as many
   * values from it as the site needs — sites never share streams. */
  stream(...parts: KeyPart[]): Rng {
    return Rng.fromSeed(`${this.namespace}|${parts.join('|')}`);
  }

  float(...parts: KeyPart[]): number {
    return this.stream(...parts).float();
  }

  gauss(mean: number, sd: number, ...parts: KeyPart[]): number {
    return this.stream(...parts).gauss(mean, sd);
  }

  chance(p: number, ...parts: KeyPart[]): boolean {
    return this.stream(...parts).float() < p;
  }

  /** Namespace for the second half etc. — carried through HalfTimeState.rngState. */
  child(suffix: string): KeyedRng {
    return new KeyedRng(`${this.namespace}|${suffix}`);
  }

  token(): string {
    return this.namespace;
  }
}
