/**
 * league-context.test.ts — the league context layer (accounts arc phase 3,
 * step 2). THE TWO-LEAGUE TEST: one manager holding an entry in two leagues at
 * once, with every context read returning the right league's rows.
 *
 * This is the test the phase exists for, and it was impossible before 0003:
 * the same footballer can now exist in both leagues as two independent rows,
 * season numbers and club names repeat per league, and a session carries which
 * league it is looking at.
 *
 * Store and session layer only — no routes, no web.
 */

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as store from './league-store.ts';
import { bootstrapSchema } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
let pool: pg.Pool;

/** a league with one season, plus this manager's club in it */
async function makeLeague(name: string, managerId: string, seasonNumber = 1): Promise<{
  leagueId: string; seasonId: string; clubId: string;
}> {
  const { rows: [l] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ($1, 'active') RETURNING id`, [name]);
  const { rows: [s] } = await pool.query<{ id: string }>(
    `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id)
     VALUES ($1, 14, 7, $2) RETURNING id`, [seasonNumber, l.id]);
  const { rows: [c] } = await pool.query<{ id: string }>(
    `INSERT INTO clubs (manager_id, name, league_id) VALUES ($1, $2, $3) RETURNING id`,
    [managerId, 'Real Coteaux', l.id]);   // the SAME club name in both leagues
  return { leagueId: l.id, seasonId: s.id, clubId: c.id };
}

async function session(managerId: string): Promise<string> {
  const id = randomUUID();
  await store.createSession(pool, id, managerId, new Date(Date.now() + 86_400_000));
  return id;
}

let managerId: string;

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
});
after(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE leagues, seasons, clubs, managers, sessions CASCADE`);
  const { rows: [m] } = await pool.query<{ id: string }>(
    `INSERT INTO managers (email, display_name) VALUES ('boss@x.io', 'Boss') RETURNING id`);
  managerId = m.id;
});

test('currentSeason is per league — never "the newest row" across all of them', async () => {
  const a = await makeLeague('Alpha League', managerId, 1);
  // league B is on season 7: under the old "ORDER BY number DESC LIMIT 1" this
  // would have been returned for league A as well, for everybody
  const b = await makeLeague('Beta League', managerId, 7);

  const sa = await store.currentSeason(pool, a.leagueId);
  const sb = await store.currentSeason(pool, b.leagueId);
  assert.equal(sa?.id, a.seasonId);
  assert.equal(sa?.number, 1);
  assert.equal(sb?.id, b.seasonId);
  assert.equal(sb?.number, 7);
});

test('getMyEntry returns the club for THAT league, and null for a league you are not in', async () => {
  const a = await makeLeague('Alpha League', managerId);
  const b = await makeLeague('Beta League', managerId);

  assert.equal((await store.getMyEntry(pool, managerId, a.leagueId))?.clubId, a.clubId);
  assert.equal((await store.getMyEntry(pool, managerId, b.leagueId))?.clubId, b.clubId);
  assert.notEqual(a.clubId, b.clubId, 'two leagues means two clubs, same manager');

  // a league this manager has no entry in — the check that stops one session
  // reading another league's club
  const { rows: [outsider] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ('Someone Else', 'active') RETURNING id`);
  assert.equal(await store.getMyEntry(pool, managerId, outsider.id), null);
});

test('the session lists BOTH memberships and selects one', async () => {
  const a = await makeLeague('Alpha League', managerId);
  const b = await makeLeague('Beta League', managerId);
  const sid = await session(managerId);

  const ctx = await store.getSessionContext(pool, sid);
  assert.equal(ctx?.memberships.length, 2);
  assert.deepEqual(ctx?.memberships.map((m) => m.leagueName), ['Alpha League', 'Beta League']);
  // unset selection falls back to the first membership, so a single-league
  // session behaves exactly as it did before this phase
  assert.equal(ctx?.leagueId, a.leagueId);
  assert.equal(ctx?.clubId, a.clubId);

  assert.equal(await store.setSelectedLeague(pool, sid, managerId, b.leagueId), true);
  const after2 = await store.getSessionContext(pool, sid);
  assert.equal(after2?.leagueId, b.leagueId);
  assert.equal(after2?.clubId, b.clubId, 'switching league switches the club the session reads');
  // ...and the season follows the selection
  assert.equal((await store.currentSeason(pool, after2!.leagueId!))?.id, b.seasonId);
});

test('a session cannot select a league its manager is not in', async () => {
  const a = await makeLeague('Alpha League', managerId);
  const sid = await session(managerId);
  const { rows: [outsider] } = await pool.query<{ id: string }>(
    `INSERT INTO leagues (name, status) VALUES ('Someone Else', 'active') RETURNING id`);

  assert.equal(await store.setSelectedLeague(pool, sid, managerId, outsider.id), false);
  assert.equal((await store.getSessionContext(pool, sid))?.leagueId, a.leagueId, 'selection unchanged');
});

test('a STALE selection (a league since left) falls back instead of pinning a dead club', async () => {
  const a = await makeLeague('Alpha League', managerId);
  const b = await makeLeague('Beta League', managerId);
  const sid = await session(managerId);
  await store.setSelectedLeague(pool, sid, managerId, b.leagueId);

  // the manager leaves league B
  await pool.query(`DELETE FROM clubs WHERE id = $1`, [b.clubId]);

  const ctx = await store.getSessionContext(pool, sid);
  assert.equal(ctx?.memberships.length, 1);
  assert.equal(ctx?.leagueId, a.leagueId, 'falls back to a league still held');
  assert.equal(ctx?.clubId, a.clubId);
});

test('an account in NO league resolves cleanly to null rather than throwing', async () => {
  const sid = await session(managerId);
  const ctx = await store.getSessionContext(pool, sid);
  assert.equal(ctx?.memberships.length, 0);
  assert.equal(ctx?.leagueId, null);
  assert.equal(ctx?.clubId, null);
});

test('the same footballer exists independently in both leagues (the 0003 payoff)', async () => {
  const a = await makeLeague('Alpha League', managerId);
  const b = await makeLeague('Beta League', managerId);

  const add = async (leagueId: string, rating: number): Promise<string> => {
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO players (full_name, birth_date, position, height_cm, market_value, attributes, physical, league_id)
       VALUES ('Kylian Mbappé', '1998-12-20', 'FW', 178, 180000000, $1, '{}', $2) RETURNING id`,
      [JSON.stringify({ finishing: rating }), leagueId]);
    return p.id;
  };
  const inA = await add(a.leagueId, 19);
  const inB = await add(b.leagueId, 19);
  assert.notEqual(inA, inB);

  // league A's season-end growth touches ONLY league A's row — the quiet
  // corruption a shared pool would have caused
  await store.updatePlayerAttributes(pool, inA, { finishing: 20 });
  const read = async (id: string): Promise<number> => Number(
    (await pool.query(`SELECT attributes->>'finishing' AS f FROM players WHERE id = $1`, [id])).rows[0].f);
  assert.equal(await read(inA), 20);
  assert.equal(await read(inB), 19, "league B's copy is untouched by league A's rollover");
});
