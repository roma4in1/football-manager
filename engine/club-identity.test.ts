/**
 * club-identity.test.ts — the badge vocabulary and its validation, which the
 * server rejects on and the client disables its save button on. The two must
 * agree, so there is exactly one implementation and this is its pin.
 *
 * These rules also MIRROR the schema's CHECK constraints (name length, the hex
 * colour pattern). If one moves, both move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGE_COLORS, BADGE_EMBLEMS, BADGE_SHAPES, CLUB_NAME_MAX, CLUB_NAME_MIN,
  initialsOf, validateClubIdentity,
} from './club-identity.ts';

const ok = { name: 'Real Coteaux', badgeShape: 'shield', badgeEmblem: 'lion', primaryColor: '#534ab7', secondaryColor: '#1e3a8a' };

test('a well-formed identity validates and comes back trimmed', () => {
  const r = validateClubIdentity({ ...ok, name: '  Real Coteaux  ' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, 'Real Coteaux');
    assert.equal(r.value.badgeEmblem, 'lion');
  }
});

test('name length mirrors the schema CHECK (2..32 after trimming)', () => {
  for (const [name, issue] of [['R', 'name_too_short'], ['  ', 'name_too_short'], ['x'.repeat(33), 'name_too_long']] as const) {
    const r = validateClubIdentity({ ...ok, name });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.issues.includes(issue), `${name.length} chars → ${issue}`);
  }
  assert.equal(validateClubIdentity({ ...ok, name: 'x'.repeat(CLUB_NAME_MAX) }).ok, true);
  assert.equal(validateClubIdentity({ ...ok, name: 'x'.repeat(CLUB_NAME_MIN) }).ok, true);
});

test('shape and emblem must come from the curated sets', () => {
  assert.equal(validateClubIdentity({ ...ok, badgeShape: 'hexagon' }).ok, false);
  assert.equal(validateClubIdentity({ ...ok, badgeEmblem: 'dragon' }).ok, false);
  for (const s of BADGE_SHAPES) assert.equal(validateClubIdentity({ ...ok, badgeShape: s }).ok, true, s);
  for (const e of BADGE_EMBLEMS) assert.equal(validateClubIdentity({ ...ok, badgeEmblem: e }).ok, true, e);
});

test('colours must be 6-digit hex — the schema CHECK rejects anything else', () => {
  for (const bad of ['red', '#fff', '#GGGGGG', '534ab7', '#534ab77', '']) {
    assert.equal(validateClubIdentity({ ...ok, primaryColor: bad }).ok, false, bad);
  }
  // uppercase is accepted and normalized DOWN, because the CHECK is lowercase-only
  const r = validateClubIdentity({ ...ok, primaryColor: '#534AB7' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.primaryColor, '#534ab7');
  // every offered swatch must itself pass — a palette entry the DB rejects
  // would be a button that always errors
  for (const c of BADGE_COLORS) {
    assert.equal(validateClubIdentity({ ...ok, primaryColor: c, secondaryColor: c }).ok, true, c);
  }
});

test('every problem is reported at once, not just the first', () => {
  const r = validateClubIdentity({ name: '', badgeShape: 'nope', badgeEmblem: 'nope', primaryColor: 'x', secondaryColor: 'y' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.issues.length, 4); // name, shape, emblem, colour
});

test('garbage input never throws — the route hands it straight from the body', () => {
  for (const junk of [null, undefined, 42, 'string', [], { name: 5 }]) {
    assert.equal(validateClubIdentity(junk).ok, false);
  }
});

test('initials: two words take both, one word takes two letters', () => {
  assert.equal(initialsOf('Real Coteaux'), 'RC');
  assert.equal(initialsOf('Arsenal'), 'AR');
  assert.equal(initialsOf('  spaced   out  '), 'SO');
});
