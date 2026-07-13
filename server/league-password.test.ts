/**
 * league-password.test.ts — scrypt hashing (league-password.ts). No DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './league-password.ts';

test('hash is a PHC-style scrypt string, salted (never plaintext), and unique per call', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!a.includes('correct horse battery'), 'never stores the plaintext');
  assert.notEqual(a, b, 'random salt → different hashes for the same password');
});

test('verify accepts the right password and rejects the wrong one', async () => {
  const hash = await hashPassword('s3cret-passphrase');
  assert.equal(await verifyPassword('s3cret-passphrase', hash), true);
  assert.equal(await verifyPassword('s3cret-passphras', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('verify rejects malformed stored values instead of throwing', async () => {
  for (const bad of ['', 'plaintext', 'scrypt$bad', 'bcrypt$1$2$3$4$5']) {
    assert.equal(await verifyPassword('whatever', bad), false);
  }
});
