/**
 * agent-setpiece-takers.test.ts — THE DESIGNATED TAKER IS OBEYED.
 *
 * The agent engine carried tactics.setPieceTakers from day one and never read
 * it: corners/free kicks picked the best setPieceDelivery attribute on the
 * pitch (:242), penalties the best finishing (:307). It went unnoticed because
 * build.ts SYNTHESIZES the field from the same attributes — a dead field whose
 * machine pick coincided with the live behaviour is invisible by construction.
 * (The fourth dead-control instance; the first caught before a UI shipped.)
 *
 * The contract now: an EXPLICIT designation (a human choice — the `explicit`
 * marker exists precisely because synthesized ids are indistinguishable from
 * chosen ones) is obeyed while the player is on the pitch; unset, off-pitch or
 * keeper designations fall back to the exact expression that always ran. The
 * null case is pinned byte-identical by the fallback being textually the old
 * code and every draw being keyed (tick, playerId, purpose) — agent-rng.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentEngine } from './agent-engine.ts';
import type { Attributes, PlayerTactic, SquadPlayer, Tactics, Vec2, Phase } from './engine-types.ts';

const ATTR_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
  'tackling', 'marking', 'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping',
  'agility', 'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
  'aggression', 'gkReflexes', 'gkPositioning', 'gkDistribution',
];
const varied = (seed: number): Attributes =>
  Object.fromEntries(ATTR_KEYS.map((k, i) => [k, 6 + ((seed * 7 + i * 3) % 13)])) as unknown as Attributes;

const SLOTS: Vec2[] = [
  { x: 6, y: 34 },
  { x: 25, y: 10 }, { x: 22, y: 25 }, { x: 22, y: 43 }, { x: 25, y: 58 },
  { x: 45, y: 12 }, { x: 42, y: 27 }, { x: 42, y: 41 }, { x: 45, y: 56 },
  { x: 62, y: 26 }, { x: 62, y: 42 },
];
const PHASES: Phase[] = ['buildUp', 'progression', 'finalThird', 'defensiveBlock', 'counterPress', 'counterAttack'];

function sideTeam(name: string, off: number, takers: Tactics['setPieceTakers']): { squad: SquadPlayer[]; tactics: Tactics } {
  const squad: SquadPlayer[] = [];
  const players: PlayerTactic[] = [];
  for (let i = 0; i < 11; i++) {
    const id = `${name}${i}`;
    // pin the keeper to slot 0: setup() elects the GK by best gk-composite,
    // and varied() once made the DESIGNATED TAKER the keeper (a keeper
    // designation correctly falls back — that is contract, not the test's
    // subject, so the fixture keeps it out of frame)
    const attrs = varied(i + off);
    attrs.gkReflexes = i === 0 ? 19 : 2;
    attrs.gkPositioning = i === 0 ? 19 : 2;
    attrs.gkDistribution = i === 0 ? 19 : 2;
    squad.push({
      playerId: id,
      attributes: attrs,
      physical: { heightCm: 180 + (i % 8), weightKg: 78, preferredFoot: 'R', injuryProneness: 10 },
      fatigue: 0.1,
      familiarity: {},
    } as SquadPlayer);
    const anchors = {} as Record<Phase, Vec2>;
    for (const ph of PHASES) anchors[ph] = { ...SLOTS[i] };
    players.push({
      playerId: id,
      anchors,
      instructions: { riskAppetite: 0.5, shootingBias: 0.5, dribbleBias: 0.5, pressingIntensity: 0.5, holdPosition: 0.5, crossBias: 0.5 },
      zones: {},
    });
  }
  return {
    squad,
    tactics: {
      players,
      team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
      bench: [],
      setPieceTakers: takers,
    },
  };
}

function collect(homeTakers: Tactics['setPieceTakers'], seeds: number): {
  corners: string[]; freeKicks: string[]; penalties: string[];
} {
  const engine = new AgentEngine();
  const out = { corners: [] as string[], freeKicks: [] as string[], penalties: [] as string[] };
  for (let m = 0; m < seeds; m++) {
    const home = sideTeam('H', m, homeTakers);
    const away = sideTeam('A', m + 3, { corners: 'A8', freeKicks: 'A5', penalties: 'A9' });
    const r = engine.simulateHalf(
      { fixtureId: `spt-${m}`, homeClubId: 'hc', awayClubId: 'ac', half: 1 },
      { home: home.squad, away: away.squad },
      { home: home.tactics, away: away.tactics },
      `spt-seed-${m}`,
    );
    // "while on the pitch": a red card or injury removes the designated
    // taker, after which the fallback is CORRECT behaviour — so collection
    // stops for this match at the moment any home player departs (the empty
    // bench means an injury also removes without replacement).
    const evs = r.events as Array<{ t: number; type: string; playerId?: string; meta?: { source?: string; card?: string } }>;
    let offAt = Infinity;
    for (const e of evs) {
      if (e.playerId?.startsWith('H') &&
        ((e.type === 'card' && e.meta?.card === 'red') || e.type === 'injury')) {
        offAt = Math.min(offAt, e.t);
      }
    }
    for (const e of evs) {
      const isHome = e.playerId?.startsWith('H');
      if (!isHome || !e.playerId || e.t >= offAt) continue;
      if (e.type === 'cornerAwarded') out.corners.push(e.playerId);
      if (e.type === 'setPiece') out.freeKicks.push(e.playerId);
      if (e.type === 'shot' && e.meta?.source === 'penalty') out.penalties.push(e.playerId);
    }
  }
  return out;
}

test('the EXPLICIT designated taker takes corners, free kicks and penalties while on the pitch', () => {
  // H2 is a centre-back-ish slot with unremarkable delivery/finishing — the
  // fallback would essentially never elect him, so every H2 event is the
  // designation acting, not coincidence.
  const ev = collect({ corners: 'H2', freeKicks: 'H2', penalties: 'H2', explicit: true }, 24);
  assert.ok(ev.corners.length >= 5, `home corners occurred (${ev.corners.length}) — anti-vacuity`);
  assert.ok(ev.freeKicks.length >= 5, `home set-piece deliveries occurred (${ev.freeKicks.length}) — anti-vacuity`);
  assert.ok(ev.penalties.length >= 1, `a home penalty occurred (${ev.penalties.length}) — anti-vacuity`);
  for (const id of ev.corners) assert.equal(id, 'H2', `corner taken by the designated taker (got ${id})`);
  for (const id of ev.freeKicks) assert.equal(id, 'H2', `free kick taken by the designated taker (got ${id})`);
  for (const id of ev.penalties) assert.equal(id, 'H2', `penalty taken by the designated taker (got ${id})`);
});

test('a NON-explicit (synthesized) designation is ignored — the taker is EXACTLY the attribute-best, as always', () => {
  // the strongest form of the null case: predict today's pick independently
  // (argmax over the outfield, strict-greater replacement like the reduce)
  // and assert every event matches it. A steering synthesized id would break
  // this the moment the designated differs from the attribute-best.
  const engine = new AgentEngine();
  let corners = 0, fks = 0, pens = 0;
  for (let m = 0; m < 12; m++) {
    const home = sideTeam('H', m, { corners: 'H2', freeKicks: 'H2', penalties: 'H2' });
    const away = sideTeam('A', m + 3, { corners: 'A8', freeKicks: 'A5', penalties: 'A9' });
    const outfield = home.squad.slice(1); // slot 0 is the pinned keeper
    const bestBy = (k: 'setPieceDelivery' | 'finishing'): string =>
      outfield.reduce((b, s) => (s.attributes[k] > b.attributes[k] ? s : b)).playerId;
    const predDelivery = bestBy('setPieceDelivery');
    const predFinishing = bestBy('finishing');
    const r = engine.simulateHalf(
      { fixtureId: `sptn-${m}`, homeClubId: 'hc', awayClubId: 'ac', half: 1 },
      { home: home.squad, away: away.squad },
      { home: home.tactics, away: away.tactics },
      `sptn-seed-${m}`,
    );
    const evs = r.events as Array<{ t: number; type: string; playerId?: string; meta?: { source?: string; card?: string } }>;
    let offAt = Infinity;
    for (const e of evs) {
      if (e.playerId?.startsWith('H') &&
        ((e.type === 'card' && e.meta?.card === 'red') || e.type === 'injury')) offAt = Math.min(offAt, e.t);
    }
    for (const e of evs) {
      if (!e.playerId?.startsWith('H') || e.t >= offAt) continue;
      if (e.type === 'cornerAwarded') { corners++; assert.equal(e.playerId, predDelivery, `corner falls back to the attribute-best (m=${m})`); }
      if (e.type === 'setPiece') { fks++; assert.equal(e.playerId, predDelivery, `free kick falls back to the attribute-best (m=${m})`); }
      if (e.type === 'shot' && e.meta?.source === 'penalty') { pens++; assert.equal(e.playerId, predFinishing, `penalty falls back to the attribute-best (m=${m})`); }
    }
  }
  assert.ok(corners >= 3, `home corners occurred (${corners}) — anti-vacuity`);
  assert.ok(fks + pens >= 1, `a free kick or penalty occurred (${fks}/${pens})`);
});

test('an explicit but OFF-PITCH designation falls back to the attribute pick, no crash', () => {
  const ev = collect({ corners: 'H99', freeKicks: 'H99', penalties: 'H99', explicit: true }, 8);
  assert.ok(ev.corners.length >= 2, `home corners occurred (${ev.corners.length})`);
  for (const id of [...ev.corners, ...ev.freeKicks, ...ev.penalties]) {
    assert.notEqual(id, 'H99', 'an absent player cannot take anything');
  }
});
