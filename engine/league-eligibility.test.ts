/**
 * league-eligibility.test.ts — pure unit tests (no database) for tactics
 * validation and the deterministic best-XI fallback, including a squad
 * wrecked by injuries.
 *
 *   node --test league-eligibility.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestXI, validateTactics, type EligiblePlayer, type EligibilityIssue } from './league-eligibility.ts';
import type { Attributes, Tactics } from './engine-types.ts';

const ATTR_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing', 'tackling', 'marking',
  'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility', 'decisions',
  'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'aggression',
  'gkReflexes', 'gkPositioning', 'gkDistribution',
];

function mk(
  playerId: string, position: string, quality: number,
  state: { inj?: number; susp?: boolean } = {},
): EligiblePlayer {
  const attributes = {} as Attributes;
  const isGk = position.startsWith('GK');
  for (const k of ATTR_KEYS) attributes[k] = k.startsWith('gk') ? (isGk ? quality + 4 : 4) : quality;
  return {
    playerId, position, attributes,
    injuryWeeksLeft: state.inj ?? 0,
    suspendedNext: state.susp ?? false,
  };
}

/** 2 GK, 5 DF, 5 MF, 3 FW = 15 players, quality descending within groups. */
function fullSquad(): EligiblePlayer[] {
  return [
    mk('gk1', 'GK', 14), mk('gk2', 'GK', 11),
    mk('df1', 'DF-CB', 14), mk('df2', 'DF-CB', 13), mk('df3', 'DF-LB', 13), mk('df4', 'DF-RB', 12), mk('df5', 'DF-CB', 10),
    mk('mf1', 'MF-CM', 14), mk('mf2', 'MF-CM', 13), mk('mf3', 'MF-DM', 12), mk('mf4', 'MF-AM', 12), mk('mf5', 'MF-CM', 10),
    mk('fw1', 'FW-ST', 14), mk('fw2', 'FW-W', 13), mk('fw3', 'FW-ST', 11),
  ];
}

const codes = (issues: EligibilityIssue[]): string[] => issues.map((i) => i.code);
const starterIds = (t: Tactics): string[] => t.players.map((p) => p.playerId);

// ── validateTactics ──────────────────────────────────────────────────────────

test('valid best XI from a healthy squad passes validation', () => {
  const squad = fullSquad();
  const xi = bestXI(squad, 'seed-a');
  assert.deepEqual(validateTactics(xi, squad), []);
  assert.equal(xi.players.length, 11);
});

test('wrong starter count / oversized bench are rejected', () => {
  const squad = fullSquad();
  const xi = bestXI(squad, 's');
  const tenStarters: Tactics = { ...xi, players: xi.players.slice(0, 10) };
  assert.ok(codes(validateTactics(tenStarters, squad)).includes('wrong_starter_count'));

  const bigBench: Tactics = { ...xi, bench: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'] };
  assert.ok(codes(validateTactics(bigBench, squad)).includes('bench_too_large'));
});

test('duplicates and non-squad players are rejected', () => {
  const squad = fullSquad();
  const xi = bestXI(squad, 's');
  const dup: Tactics = { ...xi, players: xi.players.map((p, i) => (i === 1 ? { ...p, playerId: xi.players[0].playerId } : p)) };
  assert.ok(codes(validateTactics(dup, squad)).includes('duplicate_player'));

  const alien: Tactics = { ...xi, players: xi.players.map((p, i) => (i === 5 ? { ...p, playerId: 'someone-else' } : p)) };
  assert.ok(codes(validateTactics(alien, squad)).includes('not_in_squad'));
});

test('injured and suspended players are rejected, on bench too', () => {
  const squad = fullSquad();
  const xi = bestXI(squad, 's');
  const injuredSquad = squad.map((p) => (p.playerId === starterIds(xi)[3] ? { ...p, injuryWeeksLeft: 2 } : p));
  const issues = validateTactics(xi, injuredSquad);
  assert.deepEqual(issues, [{ code: 'player_unavailable', playerId: starterIds(xi)[3], reason: 'injured' }]);

  const benched: Tactics = { ...xi, bench: ['fw3'] };
  const suspSquad = squad.map((p) => (p.playerId === 'fw3' ? { ...p, suspendedNext: true } : p));
  assert.deepEqual(validateTactics(benched, suspSquad), [{ code: 'player_unavailable', playerId: 'fw3', reason: 'suspended' }]);
});

test('a starting XI without a goalkeeper is rejected', () => {
  const squad = fullSquad();
  const xi = bestXI(squad, 's');
  const gkId = starterIds(xi).find((id) => id.startsWith('gk'))!;
  const noGk: Tactics = { ...xi, players: xi.players.map((p) => (p.playerId === gkId ? { ...p, playerId: 'fw3' } : p)) };
  assert.ok(codes(validateTactics(noGk, squad)).includes('no_goalkeeper'));
});

// ── bestXI ───────────────────────────────────────────────────────────────────

test('bestXI is position-aware: 1 GK, 4-4-2 outfield spread from a full squad', () => {
  const squad = fullSquad();
  const ids = starterIds(bestXI(squad, 'seed-a'));
  assert.equal(ids.filter((id) => id.startsWith('gk')).length, 1);
  assert.equal(ids.filter((id) => id.startsWith('df')).length, 4);
  assert.equal(ids.filter((id) => id.startsWith('mf')).length, 4);
  assert.equal(ids.filter((id) => id.startsWith('fw')).length, 2);
  assert.equal(ids[0], 'gk1', 'best GK by gk composite');
});

test('bestXI is deterministic per seed, including tiebreaks between clones', () => {
  const squad = [...fullSquad(), mk('mf5-twin', 'MF-CM', 10)]; // exact clone of mf5's attributes
  const a = bestXI(squad, 'seed-a');
  const b = bestXI(squad, 'seed-a');
  assert.deepEqual(a, b, 'same seed → byte-identical tactics');
  const c = bestXI(squad, 'seed-b');
  assert.deepEqual(validateTactics(c, squad), [], 'different seed still yields a valid XI');
});

test('wrecked squad: fit players first, then least-injured; suspended drafted last', () => {
  // GK1 + 5 outfielders injured, 1 suspended → only 8 fit for 11 slots
  const squad = fullSquad().map((p): EligiblePlayer => {
    if (p.playerId === 'gk1') return { ...p, injuryWeeksLeft: 3 };
    if (p.playerId === 'df1') return { ...p, injuryWeeksLeft: 5 };
    if (p.playerId === 'df2') return { ...p, injuryWeeksLeft: 1 };
    if (p.playerId === 'mf1') return { ...p, injuryWeeksLeft: 2 };
    if (p.playerId === 'mf2') return { ...p, injuryWeeksLeft: 6 };
    if (p.playerId === 'fw1') return { ...p, injuryWeeksLeft: 4 };
    if (p.playerId === 'fw2') return { ...p, suspendedNext: true };
    return p;
  });
  const xi = bestXI(squad, 'seed-a');
  const ids = starterIds(xi);

  assert.equal(ids.length, 11, 'a wrecked squad still fields 11');
  assert.equal(ids.includes('gk2'), true, 'fit backup GK over injured starter GK');
  assert.equal(ids.includes('gk1'), false);
  for (const fit of ['df3', 'df4', 'df5', 'mf3', 'mf4', 'mf5', 'fw3']) {
    assert.ok(ids.includes(fit), `fit player ${fit} must start before any injured player`);
  }
  // 8 fit + 3 injured needed: the three with the fewest weeks out
  assert.ok(ids.includes('df2') && ids.includes('mf1') && ids.includes('gk1') === false);
  assert.ok(!ids.includes('fw2'), 'suspended players are drafted only after all injured');
  assert.ok(!ids.includes('mf2'), '6-weeker stays out when 1- and 2-weekers exist');

  const again = bestXI(squad, 'seed-a');
  assert.deepEqual(xi, again, 'wrecked-squad fallback is deterministic');
});

test('bench only contains fit leftovers', () => {
  const squad = fullSquad().map((p): EligiblePlayer =>
    p.playerId === 'fw3' ? { ...p, injuryWeeksLeft: 2 } : p);
  const xi = bestXI(squad, 's');
  assert.ok(!xi.bench.includes('fw3'), 'injured player never sits on the generated bench');
  assert.ok(xi.bench.length <= 9);
  const ids = new Set(starterIds(xi));
  assert.ok(xi.bench.every((id) => !ids.has(id)), 'bench disjoint from starters');
});
