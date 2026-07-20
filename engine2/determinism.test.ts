/**
 * determinism.test.ts — the spec §3 non-negotiables: two runs of the same
 * scenario are byte-identical; the decimated stream round-trips within
 * quantization; keyed draws are order-free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimate, decode, streamBytes } from './frames.ts';
import { KeyedRng } from './keyed-rng.ts';
import { runScenario } from './sim.ts';
import { SCENARIOS } from './scenarios/index.ts';

test('same scenario, same seed → byte-identical frame streams (twice, every scenario)', () => {
  for (const def of SCENARIOS) {
    const a = JSON.stringify(runScenario(def, 'det-seed'));
    const b = JSON.stringify(runScenario(def, 'det-seed'));
    assert.equal(a, b, `${def.name}: identical full-rate streams`);
    const da = JSON.stringify(decimate(runScenario(def, 'det-seed')));
    const db = JSON.stringify(decimate(runScenario(def, 'det-seed')));
    assert.equal(da, db, `${def.name}: identical decimated streams`);
  }
});

test('decimated stream: 5 Hz, delta-compressed, decodes within quantization', () => {
  const frames = runScenario(SCENARIOS[0], 'roundtrip');
  const stream = decimate(frames);
  assert.equal(stream.hz, 5);
  const decoded = decode(stream);
  assert.equal(decoded.length, Math.ceil(frames.length / 2));
  for (let i = 0; i < decoded.length; i++) {
    const orig = frames[i * 2];
    assert.equal(decoded[i].tick, orig.tick);
    for (let j = 0; j < orig.bodies.length; j++) {
      assert.ok(Math.abs(decoded[i].bodies[j].x - orig.bodies[j].x) <= 0.006, 'x within 1cm quantization');
      assert.ok(Math.abs(decoded[i].bodies[j].y - orig.bodies[j].y) <= 0.006, 'y within 1cm quantization');
      assert.equal(decoded[i].bodies[j].regime, orig.bodies[j].regime);
    }
  }
  assert.ok(streamBytes(stream) < JSON.stringify(frames).length / 4, 'the stored stream is a real compression');
});

test('keyed rng: draws are addressed, not ordered — reading extra keys changes nothing', () => {
  const a = new KeyedRng('ns');
  const b = new KeyedRng('ns');
  const before = a.float(7, 'p1', 'x');
  // b consumes a bunch of unrelated draws first — order must be irrelevant
  for (let i = 0; i < 50; i++) b.float(i, 'other', 'y');
  assert.equal(b.float(7, 'p1', 'x'), before);
  assert.notEqual(a.float(7, 'p1', 'x2'), before);
  assert.notEqual(new KeyedRng('ns2').float(7, 'p1', 'x'), before);
  const g = a.gauss(0, 1, 3, 'p', 'g');
  assert.equal(g, b.gauss(0, 1, 3, 'p', 'g'));
  assert.ok(Number.isFinite(g));
});
