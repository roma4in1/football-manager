/**
 * engine/rng.ts — deterministic seeded RNG for the sim engines.
 *
 * sfc32 core, seeded from a string via xmur3. State is exactly four uint32
 * words, serializable to a 32-char hex string (HalfTimeState.rngState) so the
 * second half continues the same stream.
 *
 * Determinism notes:
 *  - No hidden state: gauss() uses Box-Muller WITHOUT caching the spare value,
 *    so serialize() always captures the full generator state.
 *  - Bit-identical replay is guaranteed on the same JS engine/platform
 *    (Math.log/cos/pow are deterministic per build, not across architectures).
 */

const U32 = 0x100000000;

/** xmur3 string hash — stretches a seed string into a stream of uint32s. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  private constructor(a: number, b: number, c: number, d: number) {
    this.a = a >>> 0;
    this.b = b >>> 0;
    this.c = c >>> 0;
    this.d = d >>> 0;
  }

  static fromSeed(seed: string): Rng {
    const h = xmur3(seed);
    const rng = new Rng(h(), h(), h(), h());
    for (let i = 0; i < 12; i++) rng.float(); // decorrelate close seeds
    return rng;
  }

  /** Restore from a serialize()d state (HalfTimeState.rngState). */
  static fromState(state: string): Rng {
    if (!/^[0-9a-f]{32}$/.test(state)) throw new Error(`invalid rng state: "${state}"`);
    const w = [0, 1, 2, 3].map((i) => parseInt(state.slice(i * 8, i * 8 + 8), 16));
    return new Rng(w[0], w[1], w[2], w[3]);
  }

  serialize(): string {
    return [this.a, this.b, this.c, this.d]
      .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
      .join('');
  }

  /** Uniform float in [0, 1). */
  float(): number {
    const t = (this.a + this.b) | 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = ((this.c + (this.c << 3)) | 0) >>> 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) >>> 0);
    this.d = ((this.d + 1) | 0) >>> 0;
    const out = (t + this.d) | 0;
    this.c = ((this.c + out) | 0) >>> 0;
    return (out >>> 0) / U32;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  int(maxExclusive: number): number {
    return Math.floor(this.float() * maxExclusive);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  gauss(mean = 0, sd = 1): number {
    const u1 = Math.max(this.float(), 1e-12);
    const u2 = this.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Knuth for small λ; normal approximation above 30 (never hit in aggregate engine). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(this.gauss(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.float();
    } while (p > L);
    return k - 1;
  }

  /** Index into weights, proportional pick. Weights ≥ 0, at least one > 0. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.float() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}
