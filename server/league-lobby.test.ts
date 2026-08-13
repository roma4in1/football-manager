/**
 * league-lobby.test.ts — THE LOBBY, over HTTP, with two real accounts.
 *
 * The store's side of phase 4 is covered by league-phase4.test.ts. What only a
 * route test can answer is whether the two RULINGS survive the wire:
 *
 *  · THE HOST MAY START AT >= 2 CLUBS. Capacity is a ceiling, not a quorum —
 *    a 4-club league starts with two in it, and the refusal below two is
 *    setupSeason's own floor rather than a screen's opinion.
 *  · A `none` POOL BLOCKS THE START. It is asserted FIRST, on a pristine tree,
 *    because that is the only moment `copyPoolInto` can honestly return `none`:
 *    once templates exist every later league copies them. A league that cannot
 *    run must fail at creation, not when the auction opens.
 *
 * And the third thing a route test owns: A WRONG CODE IS A WRONG CODE. A typo'd
 * code is the commonest first-user event there is, and it must come back as a
 * named 404 the screen can turn into a sentence.
 *
 * ORDER MATTERS IN THIS FILE. The empty-pool test runs before any template is
 * seeded; node:test runs a file's tests in source order.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createApi, SESSION_COOKIE } from './league-api.ts';
import { createOrchestrator, type Orchestrator } from './league-orchestrator.ts';
import { apiLogin, bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
let pool: pg.Pool;
let orch: Orchestrator;
let api: FastifyInstance;

type InjectOpts = { method: 'GET' | 'POST' | 'PUT'; url: string; cookie?: string; payload?: unknown };
async function call({ method, url, cookie, payload }: InjectOpts) {
  return api.inject({
    method,
    url,
    ...(cookie ? { cookies: { [SESSION_COOKIE]: cookie } } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** A fresh account every time: the tree is truncated once, and a reused email
 *  would keep an accounts row whose manager no longer exists. */
const freshLogin = (): Promise<string> => apiLogin(api, `${randomUUID()}@lobby.test`);

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  await bootstrapSchema(pool, DATABASE_URL);
  await pool.query(
    `TRUNCATE squad_players, contracts, auction_lots, club_seasons, clubs, seasons,
              players, leagues, club_identities, sessions, managers, accounts CASCADE`,
  );
  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 3600 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: 'lobby-test-secret' });
});

after(async () => {
  await api?.close();
  await orch?.stop();
  await pool?.end();
});

test('A `none` POOL IS SHOWN AT CREATION AND BLOCKS THE START', async () => {
  const host = await freshLogin();
  const made = await call({
    method: 'POST', url: '/api/leagues', cookie: host,
    payload: { name: 'Empty Tree', capacity: 4, clubName: 'Ghost FC' },
  });
  assert.equal(made.statusCode, 201);
  const created = made.json() as { leagueId: string; pool: { copied: number; source: string } };
  assert.equal(created.pool.source, 'none', 'no templates and no other league to copy from');
  assert.equal(created.pool.copied, 0);

  const seen = await call({ method: 'GET', url: `/api/leagues/${created.leagueId}/lobby`, cookie: host });
  assert.equal(seen.statusCode, 200);
  assert.equal((seen.json() as { poolCount: number }).poolCount, 0, 'the lobby repeats what creation said');

  // a SECOND club does not rescue it — the pool is the blocker, not the count
  const guest = await freshLogin();
  const code = (await pool.query(`SELECT join_code FROM leagues WHERE id = $1`, [created.leagueId])).rows[0].join_code;
  assert.equal((await call({
    method: 'POST', url: '/api/leagues/join', cookie: guest, payload: { code, clubName: 'Ghost Town' },
  })).statusCode, 200);

  const started = await call({ method: 'POST', url: `/api/leagues/${created.leagueId}/start`, cookie: host });
  assert.equal(started.statusCode, 409);
  assert.equal((started.json() as { error: string }).error, 'empty_pool');
  const { rows } = await pool.query(`SELECT status::text AS s FROM leagues WHERE id = $1`, [created.leagueId]);
  assert.equal(rows[0].s, 'lobby', 'a refused start leaves the league where it was');
});

test('TWO ACCOUNTS: create, join by code, and see each other in the same lobby', async () => {
  // 36 templates: 2 clubs need 1x18 + 13 = 31 total and a 4-4-2 each by position
  await seedPoolPlayers(pool, 36, 'Template', null);

  const host = await freshLogin();
  const guest = await freshLogin();
  const made = await call({
    method: 'POST', url: '/api/leagues', cookie: host,
    payload: { name: 'Sunday League', capacity: 4, clubName: 'Alpha FC' },
  });
  assert.equal(made.statusCode, 201);
  const created = made.json() as { leagueId: string; joinCode: string; pool: { copied: number; source: string } };
  assert.equal(created.pool.source, 'templates');
  assert.equal(created.pool.copied, 36);
  assert.equal(created.joinCode.length, 6, 'six characters is what a person reads out');

  // a NON-MEMBER gets 404, not 403 — a forged id cannot confirm a league exists
  assert.equal((await call({
    method: 'GET', url: `/api/leagues/${created.leagueId}/lobby`, cookie: guest,
  })).statusCode, 404);

  const solo = (await call({ method: 'GET', url: `/api/leagues/${created.leagueId}/lobby`, cookie: host })).json() as {
    name: string; capacity: number; isHost: boolean; poolCount: number;
    clubs: Array<{ clubName: string }>; joinCode: string;
  };
  assert.equal(solo.name, 'Sunday League');
  assert.equal(solo.capacity, 4);
  assert.equal(solo.isHost, true);
  assert.equal(solo.poolCount, 36);
  assert.deepEqual(solo.clubs.map((c) => c.clubName), ['Alpha FC']);
  assert.equal(solo.joinCode, created.joinCode, 'the host can read the code back to share it');
  assert.equal((solo as { hostAccountId?: string }).hostAccountId, undefined,
    'isHost crosses the wire; the account id behind it does not');

  // the code is read off a screen by a person: trimmed and case-insensitive
  const joined = await call({
    method: 'POST', url: '/api/leagues/join', cookie: guest,
    payload: { code: `  ${created.joinCode.toLowerCase()} `, clubName: 'Beta United' },
  });
  assert.equal(joined.statusCode, 200);
  assert.equal((joined.json() as { name: string }).name, 'Sunday League');

  const both = (await call({ method: 'GET', url: `/api/leagues/${created.leagueId}/lobby`, cookie: guest })).json() as {
    isHost: boolean; clubs: Array<{ clubName: string; displayName: string }>;
  };
  assert.equal(both.isHost, false, 'the guest is not the host');
  assert.deepEqual(both.clubs.map((c) => c.clubName).sort(), ['Alpha FC', 'Beta United']);
  assert.ok(both.clubs.every((c) => c.displayName), 'every seat names its manager');
});

test('A WRONG CODE FAILS AS A WRONG CODE — a named 404, never a crash', async () => {
  const stranger = await freshLogin();
  const res = await call({
    method: 'POST', url: '/api/leagues/join', cookie: stranger, payload: { code: 'ZZZZZZ', clubName: 'Nowhere FC' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: string }).error, 'not_found');

  const empty = await call({ method: 'POST', url: '/api/leagues/join', cookie: stranger, payload: { code: '   ' } });
  assert.equal(empty.statusCode, 400);
  assert.equal((empty.json() as { error: string }).error, 'code_required');
});

test('THE START IS THE HOST\'S, AND CAPACITY IS A CEILING NOT A QUORUM', async () => {
  const host = await freshLogin();
  const guest = await freshLogin();
  const made = (await call({
    method: 'POST', url: '/api/leagues', cookie: host,
    payload: { name: 'Ceiling FC', capacity: 6, clubName: 'Gamma Rovers' },
  })).json() as { leagueId: string; joinCode: string };

  // ONE club is below setupSeason's floor, and the refusal says which
  const alone = await call({ method: 'POST', url: `/api/leagues/${made.leagueId}/start`, cookie: host });
  assert.equal(alone.statusCode, 409);
  assert.deepEqual(alone.json(), { error: 'need_two_clubs', joined: 1 });

  await call({
    method: 'POST', url: '/api/leagues/join', cookie: guest,
    payload: { code: made.joinCode, clubName: 'Delta Town' },
  });

  // a member who is not the host cannot start it
  const notHost = await call({ method: 'POST', url: `/api/leagues/${made.leagueId}/start`, cookie: guest });
  assert.equal(notHost.statusCode, 403);
  assert.equal((notHost.json() as { error: string }).error, 'not_host');

  // TWO OF SIX STARTS. The capacity was never a quorum.
  const started = await call({ method: 'POST', url: `/api/leagues/${made.leagueId}/start`, cookie: host });
  assert.equal(started.statusCode, 200, started.body);
  const out = started.json() as { seasonId: string; clubs: number };
  assert.equal(out.clubs, 2);

  const { rows: league } = await pool.query(`SELECT status::text AS s FROM leagues WHERE id = $1`, [made.leagueId]);
  assert.equal(league[0].s, 'active');
  const { rows: season } = await pool.query(
    `SELECT phase::text AS phase, league_id FROM seasons WHERE id = $1`, [out.seasonId]);
  assert.equal(season[0].phase, 'auction', 'the season the host started opens in the auction');
  assert.equal(season[0].league_id, made.leagueId);

  // the season did NOT claim the remaining templates — that is the copy ruling
  const { rows: t } = await pool.query(`SELECT count(*)::int AS n FROM players WHERE league_id IS NULL`);
  assert.equal(t[0].n, 36, 'templates survive a phase-4 start');

  // and a started league is closed: the second start and any late joiner
  assert.equal((await call({ method: 'POST', url: `/api/leagues/${made.leagueId}/start`, cookie: host })).statusCode, 409);
  const latecomer = await freshLogin();
  const late = await call({
    method: 'POST', url: '/api/leagues/join', cookie: latecomer,
    payload: { code: made.joinCode, clubName: 'Late FC' },
  });
  assert.equal(late.statusCode, 409);
  assert.equal((late.json() as { error: string }).error, 'league_started');
});

test('A POOL TOO SMALL FOR ITS CLUBS IS A REFUSAL, NOT A 500', async () => {
  const host = await freshLogin();
  const made = (await call({
    method: 'POST', url: '/api/leagues', cookie: host,
    payload: { name: 'Thin Pool', capacity: 4, clubName: 'Thin FC' },
  })).json() as { leagueId: string; joinCode: string };
  const guest = await freshLogin();
  await call({
    method: 'POST', url: '/api/leagues/join', cookie: guest,
    payload: { code: made.joinCode, clubName: 'Thinner FC' },
  });

  // NOT empty - just short. Two clubs need (2-1)*18 + 13 = 31.
  await pool.query(
    `DELETE FROM players WHERE id IN (
       SELECT id FROM players WHERE league_id = $1 ORDER BY full_name LIMIT 30)`, [made.leagueId]);
  const started = await call({ method: 'POST', url: `/api/leagues/${made.leagueId}/start`, cookie: host });
  assert.equal(started.statusCode, 409, started.body);
  const body = started.json() as { error: string; issues: string[] };
  assert.equal(body.error, 'pool_insufficient');
  assert.ok(body.issues.length > 0, "the refusal carries setupSeason's own reasons");
  const { rows } = await pool.query(`SELECT status::text AS s FROM leagues WHERE id = $1`, [made.leagueId]);
  assert.equal(rows[0].s, 'lobby', 'a refused start leaves the league where it was');
});

test('THE FULL LEAGUE: capacity IS enforced as a ceiling', async () => {
  const host = await freshLogin();
  const made = (await call({
    method: 'POST', url: '/api/leagues', cookie: host,
    payload: { name: 'Two Seater', capacity: 2, clubName: 'First FC' },
  })).json() as { leagueId: string; joinCode: string };

  const second = await freshLogin();
  assert.equal((await call({
    method: 'POST', url: '/api/leagues/join', cookie: second, payload: { code: made.joinCode, clubName: 'Second FC' },
  })).statusCode, 200);

  const third = await freshLogin();
  const full = await call({
    method: 'POST', url: '/api/leagues/join', cookie: third, payload: { code: made.joinCode, clubName: 'Third FC' },
  });
  assert.equal(full.statusCode, 409);
  assert.equal((full.json() as { error: string }).error, 'league_full');
});
