/**
 * league-phase4.test.ts — CREATE AND JOIN, the copy, and the two league-blind
 * fixes that ship with them.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. Every defect in the league-blind family
 * is INVISIBLE AT ONE LEAGUE — that is what let three of them through. So every
 * test here builds a SECOND league and asks the question that only a second
 * league can answer:
 *
 *  · the copy carries `players` columns and NOTHING ELSE — the dangerous case is
 *    the one that does not error, since copying contracts or squad_players is
 *    accepted by Postgres and silently puts a league-B player under contract to
 *    a league-A club;
 *  · ISOLATION: after league A signs a copied player, A's pool falls and B's
 *    does not (proven once in the ruling's probe; an assertion here instead of a
 *    memory);
 *  · the THIRD instance — setupSeason's supply guard counting league-blind;
 *  · the FOURTH — carrySquadsForward writing every live contract in the database
 *    into one league's next season.
 */

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as store from './league-store.ts';
import { bootstrapSchema, flatAttributes } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
let pool: pg.Pool;

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await bootstrapSchema(pool, DATABASE_URL);
});
after(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE squad_players, contracts, auction_lots, clubs, seasons, players, leagues, managers CASCADE`);
});

async function makeManager(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO managers (email, display_name) VALUES ($1, $2) RETURNING id`,
    [`${randomUUID()}@t.test`, name],
  );
  return rows[0].id;
}

/** N unclaimed TEMPLATES — the pipeline's import shape (league_id NULL). */
async function seedTemplates(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, foot,
                            market_value, attributes, physical, source_meta, league_id)
       VALUES ($1, '1998-01-01', $2, 180, 75, 'R', 1000000, $3, '{}', $4, NULL)`,
      [`Template ${i}`, i % 5 === 0 ? 'GK' : 'MF', JSON.stringify(flatAttributes(i % 5 === 0)), JSON.stringify({ tmId: i })],
    );
  }
}

test('the copy carries players columns only — and NOT contracts or squad rows', async () => {
  await seedTemplates(6);
  const host = await makeManager('Host');
  const a = await store.createLeague(pool, { name: 'A', hostAccountId: null, clubCapacity: 4 });
  assert.equal(a.source, 'templates');
  assert.equal(a.copied, 6);
  await store.addClubToLeague(pool, a.leagueId, host, 'Aston');

  // the templates SURVIVE the copy — a copy is not a claim
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM players WHERE league_id IS NULL`);
  assert.equal(t[0].n, 6, 'templates are copied, never consumed');

  // source_meta rides along for re-joins; identity keys repeat per league
  const { rows: copied } = await pool.query(
    `SELECT full_name, source_meta FROM players WHERE league_id = $1 ORDER BY full_name`, [a.leagueId]);
  assert.equal(copied.length, 6);
  assert.ok(copied.every((r) => r.source_meta && Object.keys(r.source_meta).length > 0), 'source_meta carried');

  // NOTHING ELSE came with them
  const { rows: ct } = await pool.query(`SELECT count(*)::int AS n FROM contracts`);
  const { rows: sp } = await pool.query(`SELECT count(*)::int AS n FROM squad_players`);
  assert.equal(ct[0].n, 0, 'no contracts were copied');
  assert.equal(sp[0].n, 0, 'no squad rows were copied');
});

test('TWO leagues hold the same footballer as independent rows, and the join code seats the second manager', async () => {
  await seedTemplates(6);
  const m1 = await makeManager('One');
  const m2 = await makeManager('Two');
  const a = await store.createLeague(pool, { name: 'A', hostAccountId: null, clubCapacity: 4 });
  const b = await store.createLeague(pool, { name: 'B', hostAccountId: null, clubCapacity: 4 });
  await store.addClubToLeague(pool, a.leagueId, m1, 'Aston');
  assert.notEqual(a.joinCode, b.joinCode);

  const found = await store.leagueByJoinCode(pool, b.joinCode.toLowerCase());
  assert.ok(found, 'the code resolves case-insensitively');
  assert.equal(found.leagueId, b.leagueId);
  assert.equal(await store.clubInLeague(pool, m2, b.leagueId), null);
  await store.addClubToLeague(pool, b.leagueId, m2, 'Boro');
  assert.ok(await store.clubInLeague(pool, m2, b.leagueId));

  const { rows } = await pool.query(
    `SELECT league_id, count(*)::int AS n FROM players WHERE league_id IS NOT NULL GROUP BY league_id`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.n === 6), 'each league holds its own six');
});

test('ISOLATION: league A signing a copied player drops A pool and leaves B untouched', async () => {
  await seedTemplates(6);
  const m1 = await makeManager('One');
  const a = await store.createLeague(pool, { name: 'A', hostAccountId: null, clubCapacity: 4 });
  const b = await store.createLeague(pool, { name: 'B', hostAccountId: null, clubCapacity: 4 });
  const clubA = await store.addClubToLeague(pool, a.leagueId, m1, 'Aston');
  const { rows: [sA] } = await pool.query<{ id: string }>(
    `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id, phase)
     VALUES (1, 14, 7, $1, 'auction') RETURNING id`, [a.leagueId]);
  const { rows: [sB] } = await pool.query<{ id: string }>(
    `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id, phase)
     VALUES (1, 14, 7, $1, 'auction') RETURNING id`, [b.leagueId]);

  const before = { a: (await store.poolPlayers(pool, sA.id)).length, b: (await store.poolPlayers(pool, sB.id)).length };
  assert.equal(before.a, 6);
  assert.equal(before.b, 6);

  const target = (await store.poolPlayers(pool, sA.id))[0];
  await pool.query(
    `INSERT INTO contracts (player_id, club_id, wage, duration, season_signed) VALUES ($1, $2, 1000, 2, $3)`,
    [target.playerId, clubA, sA.id],
  );

  const after = { a: (await store.poolPlayers(pool, sA.id)).length, b: (await store.poolPlayers(pool, sB.id)).length };
  assert.equal(after.a, 5, "A's pool falls by the signing");
  assert.equal(after.b, 6, "B's pool is untouched — the whole point of the copy");
});

test('THE FOURTH LEAGUE-BLIND INSTANCE: a rollover carries only its OWN league forward', async () => {
  await seedTemplates(4);
  const m1 = await makeManager('One');
  const m2 = await makeManager('Two');
  const a = await store.createLeague(pool, { name: 'A', hostAccountId: null, clubCapacity: 4 });
  const b = await store.createLeague(pool, { name: 'B', hostAccountId: null, clubCapacity: 4 });
  const clubA = await store.addClubToLeague(pool, a.leagueId, m1, 'Aston');
  const clubB = await store.addClubToLeague(pool, b.leagueId, m2, 'Boro');
  const { rows: [sA] } = await pool.query<{ id: string }>(
    `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id)
     VALUES (1, 14, 7, $1) RETURNING id`, [a.leagueId]);
  const { rows: [sA2] } = await pool.query<{ id: string }>(
    `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id)
     VALUES (2, 14, 7, $1) RETURNING id`, [a.leagueId]);
  await pool.query(
    `INSERT INTO seasons (number, matchweek_count, transfer_week, league_id) VALUES (1, 14, 7, $1)`, [b.leagueId]);

  const pa = (await pool.query(`SELECT id FROM players WHERE league_id = $1 LIMIT 1`, [a.leagueId])).rows[0].id;
  const pb = (await pool.query(`SELECT id FROM players WHERE league_id = $1 LIMIT 1`, [b.leagueId])).rows[0].id;
  const sB1 = (await pool.query(`SELECT id FROM seasons WHERE league_id = $1`, [b.leagueId])).rows[0].id;
  await pool.query(`INSERT INTO contracts (player_id, club_id, wage, duration, season_signed) VALUES ($1,$2,1000,3,$3)`, [pa, clubA, sA.id]);
  await pool.query(`INSERT INTO contracts (player_id, club_id, wage, duration, season_signed) VALUES ($1,$2,1000,3,$3)`, [pb, clubB, sB1]);

  await store.carrySquadsForward(pool, sA2.id);

  const { rows } = await pool.query(
    `SELECT club_id, player_id FROM squad_players WHERE season_id = $1`, [sA2.id]);
  assert.equal(rows.length, 1, "only league A's contract carried — the old form wrote both");
  assert.equal(rows[0].club_id, clubA);
  assert.equal(rows[0].player_id, pa);
});

test('the empty tree: a league created with no templates and no other league gets an EMPTY pool, reported', async () => {
  const a = await store.createLeague(pool, { name: 'A', hostAccountId: null, clubCapacity: 4 });
  assert.equal(a.source, 'none');
  assert.equal(a.copied, 0);

  // ...and with a league already holding a roster, the fallback copies THAT
  await pool.query(
    `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, foot,
                          market_value, attributes, physical, league_id)
     VALUES ('Solo', '1998-01-01', 'MF', 180, 75, 'R', 1000000, $1, '{}', $2)`,
    [JSON.stringify(flatAttributes(false)), a.leagueId],
  );
  const b = await store.createLeague(pool, { name: 'B', hostAccountId: null, clubCapacity: 4 });
  assert.equal(b.source, 'league', 'no templates left: the copy falls back to an existing league');
  assert.equal(b.copied, 1);
});
