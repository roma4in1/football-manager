/**
 * league-password.ts — password hashing, no new dependency.
 *
 * Uses Node's built-in scrypt (node:crypto): a memory-hard KDF in the same
 * OWASP tier as argon2id/bcrypt (LOBBY-DESIGN-SPEC §3 asks for "argon2id or
 * bcrypt"; scrypt is chosen because it ships with Node, so the zero-runtime-
 * dependency, no-native-build discipline that keeps `node:24-slim` buildable
 * holds — see DECISIONS.md). Hashes are self-describing PHC-style strings so
 * the cost parameters can be raised later without a migration:
 *
 *   scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
 *
 * Verification is constant-time and recomputes with the STORED parameters, so
 * old hashes keep verifying after the defaults below are bumped.
 */

import { randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to the no-options overload; wrap so we can pass cost params.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options: ScryptOptions,
) => Promise<Buffer>;

// N=2^15 (~32 MiB per hash), r=8, p=1 — comfortable on the 512 MB Fly machine
// for an 8-manager league's rare logins; maxmem is raised to fit N.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAXMEM = 128 * N * R * 2; // scrypt needs ~128*N*r bytes; double it for headroom

const derive = (password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> =>
  scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }) as Promise<Buffer>;

/** Hash a plaintext password into a storable PHC-style scrypt string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time verify against a stored PHC-style scrypt string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr), r = Number(rStr), p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
