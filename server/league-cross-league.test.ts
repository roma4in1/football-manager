/**
 * league-cross-league.test.ts — phase 3 step 3: NO ROUTE MAY REACH ACROSS A
 * LEAGUE BOUNDARY.
 *
 * One account holds entries in league A and league B. With B selected, it must
 * not be able to read or act on anything belonging to A — by fixture id, by
 * player id, or by pool listing — even when A's matchweek has been REVEALED.
 *
 * That last case is the whole point. The embargo's `revealed_at IS NOT NULL`
 * branch deliberately lets a non-participant see a finished match; within one
 * league that is correct, and across leagues it was a leak. A forgotten league
 * predicate is the same class of hole as a forgotten embargo filter, and it
 * fails on the SECOND league, never the first — so single-league testing could
 * never have caught it.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createApi, SESSION_COOKIE } from './league-api.ts';
import { createOrchestrator, type Orchestrator } from './league-orchestrator.ts';
import { apiLogin, bootstrapSchema, flatAttributes } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
let orch: Orchestrator;
let api: FastifyInstance;
let cookie: string;
let leagueA: string, leagueB: string;
let clubA1: string, clubA2: string, clubB1: string;
let fixtureA: string;
let playerA: string;

const q = (text: string, params?: unknown[]) => pool.query(text, params);

/** a league with two clubs (the account manages the first) and one season */
async function buildLeague(name: string, managerId: string, otherEmail: string): Promise<{
  leagueId: string; seasonId: string; mine: string; other: string;
}> {
  const { rows: [l] } = await q(`INSERT INTO leagues (name,status) VALUES ($1,'active') RETURNING id`, [name]);
  const { rows: [s] } = await q(
    `INSERT INTO seasons (number,matchweek_count,transfer_week,league_id) VALUES (1,2,1,$1) RETURNING id`, [l.id]);
  await q(`UPDATE seasons SET phase='auction' WHERE id=$1`, [s.id]);
  await q(`UPDATE seasons SET phase='regular' WHERE id=$1`, [s.id]);
  const { rows: [mine] } = await q(
    `INSERT INTO clubs (manager_id,name,league_id) VALUES ($1,'Real Coteaux',$2) RETURNING id`, [managerId, l.id]);
  const { rows: [om] } = await q(
    `INSERT INTO managers (email,display_name) VALUES ($1,'Other') RETURNING id`, [otherEmail]);
  const { rows: [other] } = await q(
    `INSERT INTO clubs (manager_id,name,league_id) VALUES ($1,'Rivals',$2) RETURNING id`, [om.id, l.id]);
  for (const c of [mine.id, other.id]) {
    await q(`INSERT INTO club_seasons (club_id,season_id,transfer_budget,wage_cap) VALUES ($1,$2,1000000,100000)`,
      [c, s.id]);
  }
  return { leagueId: l.id, seasonId: s.id, mine: mine.id, other: other.id };
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 0.5 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: 'x' });

  cookie = await apiLogin(api, 'boss@x.io');
  const { rows: [acc] } = await q(`SELECT manager_id FROM accounts WHERE email='boss@x.io'`);
  const managerId = acc.manager_id as string;

  const A = await buildLeague('Alpha League', managerId, 'other-a@x.io');
  const B = await buildLeague('Beta League', managerId, 'other-b@x.io');
  leagueA = A.leagueId; leagueB = B.leagueId;
  clubA1 = A.mine; clubA2 = A.other; clubB1 = B.mine;

  // a FINISHED, REVEALED fixture in league A — the case that used to leak
  const { rows: [mw] } = await q(
    `INSERT INTO matchweeks (season_id,number,opens_at,deadline_at,revealed_at)
     VALUES ($1,1,now()-interval '2 days',now()-interval '1 day',now()) RETURNING id`, [A.seasonId]);
  const { rows: [fx] } = await q(
    `INSERT INTO fixtures (matchweek_id,home_club_id,away_club_id,state,seed)
     VALUES ($1,$2,$3,'final','s') RETURNING id`, [mw.id, clubA1, clubA2]);
  fixtureA = fx.id;
  for (const half of [1, 2]) {
    await q(`INSERT INTO half_results (fixture_id,half,events,stats,end_state)
             VALUES ($1,$2,'[]','{}',$3)`, [fixtureA, half, JSON.stringify({ score: [1, 0] })]);
    await q(`INSERT INTO replay_frames (fixture_id,half,frames) VALUES ($1,$2,'[]')`, [fixtureA, half]);
  }

  // an uncontracted player in league A's pool
  const { rows: [p] } = await q(
    `INSERT INTO players (full_name,birth_date,position,height_cm,market_value,attributes,physical,league_id)
     VALUES ('A Pooler','2000-01-01','FW',180,1000,$1,'{}',$2) RETURNING id`,
    [JSON.stringify(flatAttributes(false)), leagueA]);
  playerA = p.id;

  // ...and the session is looking at league B
  const { rows: [sess] } = await q(`SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1`);
  await q(`UPDATE sessions SET selected_league_id=$2 WHERE id=$1`, [sess.id, leagueB]);
});

after(async () => { await api.close(); await orch.stop(); await pool.end(); });

const call = (url: string) => api.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie } });

test('the session is on league B and sees B\'s club', async () => {
  const me = (await call('/api/me')).json();
  assert.equal(me.selectedLeagueId, leagueB);
  assert.equal(me.club.id, clubB1);
  assert.equal(me.leagues.length, 2, '/me lists BOTH memberships — step 4 needs this');
  assert.deepEqual(me.leagues.map((l: { name: string }) => l.name), ['Alpha League', 'Beta League']);
});

test('a REVEALED fixture in the other league is NOT readable — the leak that was', async () => {
  const res = await call(`/api/fixture/${fixtureA}/result`);
  assert.equal(res.statusCode, 404, 'league A result must not be visible from a league B session');
});

test('...nor its replay', async () => {
  assert.equal((await call(`/api/fixture/${fixtureA}/replay`)).statusCode, 404);
});

test('...nor its half-time state or tactics', async () => {
  assert.equal((await call(`/api/fixture/${fixtureA}/ht`)).statusCode, 404);
  assert.equal((await call(`/api/fixture/${fixtureA}/tactics/1`)).statusCode, 404);
});

test('the other league\'s player is not in this league\'s squad view', async () => {
  assert.equal((await call(`/api/squad/player/${playerA}`)).statusCode, 404);
});

test('the auction pool lists only THIS league\'s players', async () => {
  // league B is in `regular`, so /auction/pool 409s on phase — assert at the
  // store instead, which is where the league predicate actually lives
  const store = await import('./league-store.ts');
  const { rows: [sB] } = await q(`SELECT id FROM seasons WHERE league_id=$1`, [leagueB]);
  const poolB = await store.poolPlayers(pool, sB.id);
  assert.equal(poolB.some((p) => p.playerId === playerA), false,
    "league A's pooler must not appear in league B's pool");

  const { rows: [sA] } = await q(`SELECT id FROM seasons WHERE league_id=$1`, [leagueA]);
  const poolA = await store.poolPlayers(pool, sA.id);
  assert.equal(poolA.some((p) => p.playerId === playerA), true, '...but it IS in its own');
});

test('standings and results show only the selected league', async () => {
  const standings = (await call('/api/standings')).json();
  const ids = standings.table.map((r: { clubId: string }) => r.clubId);
  assert.equal(ids.includes(clubA1), false, "league A's clubs must not appear");
  assert.equal(ids.includes(clubA2), false);
  // league A's revealed matchweek must not surface in league B's results
  const results = (await call('/api/results')).json();
  const fixtures = JSON.stringify(results);
  assert.equal(fixtures.includes(fixtureA), false, "league A's revealed fixture must not appear");
});

test('switching to league A makes A visible — the guard is the LEAGUE, not the row', async () => {
  const sw = await api.inject({
    method: 'PUT', url: '/api/league', cookies: { [SESSION_COOKIE]: cookie },
    payload: { leagueId: leagueA },
  });
  assert.equal(sw.statusCode, 200);
  assert.equal(sw.json().selectedLeagueId, leagueA);

  const res = await call(`/api/fixture/${fixtureA}/result`);
  assert.equal(res.statusCode, 200, 'the same fixture IS readable once its league is selected');
  assert.deepEqual(res.json().finalScore, [1, 0]);

  // put it back for any later test
  await api.inject({
    method: 'PUT', url: '/api/league', cookies: { [SESSION_COOKIE]: cookie },
    payload: { leagueId: leagueB },
  });
});

test('the switcher refuses a league the account is not in', async () => {
  const { rows: [outsider] } = await q(
    `INSERT INTO leagues (name,status) VALUES ('Someone Else','active') RETURNING id`);
  const res = await api.inject({
    method: 'PUT', url: '/api/league', cookies: { [SESSION_COOKIE]: cookie },
    payload: { leagueId: outsider.id },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((await call('/api/me')).json().selectedLeagueId, leagueB, 'selection unchanged');
});

test('a malformed league id is refused, not a 500', async () => {
  const res = await api.inject({
    method: 'PUT', url: '/api/league', cookies: { [SESSION_COOKIE]: cookie },
    payload: { leagueId: 'not-a-uuid' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((await api.inject({
    method: 'PUT', url: '/api/league', cookies: { [SESSION_COOKIE]: cookie }, payload: {},
  })).statusCode, 400);
});
