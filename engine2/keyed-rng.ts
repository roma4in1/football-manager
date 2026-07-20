/**
 * keyed-rng.ts — keyed randomness, V2-native from day one (spec §3).
 *
 * Every draw is addressed by (tick, entityId, purpose) under a namespace
 * seed — no stream, no draw order. Adding a consumer is a no-op for every
 * existing draw, and two runs of the same scenario are byte-identical by
 * construction. Ported as a CONCEPT from v1's agent-rng (the discipline that
 * made v1 debuggable); the implementation is fresh and dependency-free.
 *
 * L1 uses no randomness yet — the module ships now because retrofitting
 * keyed determinism is exactly the mistake the spec forbids.
 */

/** FNV-1a 32-bit over a string — tiny, deterministic, good enough spread
 * for simulation keys (not cryptographic, doesn't need to be). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One extra avalanche pass (xorshift-multiply) — FNV alone correlates for
 * keys differing in one trailing char (adjacent ticks). */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export class KeyedRng {
  private readonly ns: string;

  constructor(namespace: string) {
    this.ns = namespace;
  }

  /** uniform [0, 1) for (tick, entityId, purpose) */
  float(tick: number, entityId: string, purpose: string): number {
    return mix(fnv1a(`${this.ns}|${tick}|${entityId}|${purpose}`)) / 0x1_0000_0000;
  }

  /** P(true) = p */
  chance(p: number, tick: number, entityId: string, purpose: string): boolean {
    return this.float(tick, entityId, purpose) < p;
  }

  /** standard normal via Box-Muller on two keyed uniforms */
  gauss(mean: number, sd: number, tick: number, entityId: string, purpose: string): number {
    const u1 = Math.max(this.float(tick, entityId, `${purpose}#u1`), 1e-12);
    const u2 = this.float(tick, entityId, `${purpose}#u2`);
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** child namespace (e.g. a second half derives one — v1's resume rule) */
  child(label: string): KeyedRng {
    return new KeyedRng(`${this.ns}/${label}`);
  }
}
