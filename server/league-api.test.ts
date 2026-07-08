/**
 * league-api.test.ts — HTTP API integration tests against real Postgres,
 * supertest-style via fastify's inject (no port binding).
 *
 *   npm run db:test:up && npm run test:api
 *
 * The embargo is THE property under test: participant sees own final result
 * pre-reveal; non-participant is 404 pre-reveal and 200 post-reveal; standings
 * ignore unrevealed fixtures; opponent submission status leaks booleans only.
 *
 * Three clubs: Alpha vs Beta play the fixture, Gamma is the non-participant.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createApi, mintMagicToken, SESSION_COOKIE, type LinkDelivery } from './league-api.ts';
import { createOrchestrator, type Orchestrator } from './league-orchestrator.ts';
import { bootstrapSchema, buildTactics, flatAttributes, seedClub, seedSeason, waitFor } from './league-test-helpers.ts';
import type { Tactics } from '@fm/engine/types';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const SECRET = 'api-test-secret';

let pool: pg.Pool;
let orch: Orchestrator;
let api: FastifyInstance;

let seasonId: string;
let clubA: string, clubB: string, clubC: string;
let playersA: string[], playersB: string[];
let fixtureId: string;
let matchweekId: string;
let cookieA: string, cookieB: string, cookieC: string;

const delivered: Array<{ email: string; url: string }> = [];
const captureDelivery: LinkDelivery = {
  async sendLoginLink(email, url) {
    delivered.push({ email, url });
  },
};

const q = (text: string, params?: unknown[]) => pool.query(text, params);

type InjectOpts = { method: 'GET' | 'POST' | 'PUT'; url: string; cookie?: string; payload?: unknown };
async function call({ method, url, cookie, payload }: InjectOpts) {
  return api.inject({
    method,
    url,
    ...(cookie ? { cookies: { [SESSION_COOKIE]: cookie } } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function login(email: string): Promise<string> {
  delivered.length = 0;
  const req = await call({ method: 'POST', url: '/api/auth/request-link', payload: { email } });
  assert.equal(req.statusCode, 204);
  assert.equal(delivered.length, 1);
  const token = new URL(delivered[0].url).searchParams.get('token')!;
  const res = await call({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(token)}` });
  assert.equal(res.statusCode, 302, 'redeem lands on the SPA root');
  assert.equal(res.headers.location, '/');
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  assert.ok(cookie, 'redeem sets the session cookie');
  return cookie.value;
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await bootstrapSchema(pool, DATABASE_URL);
  seasonId = await seedSeason(pool);
  ({ clubId: clubA, playerIds: playersA } = await seedClub(pool, seasonId, 'Alpha', 'alpha@test.io'));
  ({ clubId: clubB, playerIds: playersB } = await seedClub(pool, seasonId, 'Beta', 'beta@test.io'));
  ({ clubId: clubC } = await seedClub(pool, seasonId, 'Gamma', 'gamma@test.io'));

  const mw = await q(
    `INSERT INTO matchweeks (season_id, number, opens_at, deadline_at) VALUES ($1, 1, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
    [seasonId],
  );
  matchweekId = mw.rows[0].id;
  const fx = await q(
    `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed) VALUES ($1, $2, $3, 'api-1') RETURNING id`,
    [matchweekId, clubA, clubB],
  );
  fixtureId = fx.rows[0].id;

  orch = await createOrchestrator({ pool, connectionString: DATABASE_URL, pollingIntervalSeconds: 0.5 });
  api = await createApi({ pool, orchestrator: orch, sessionSecret: SECRET, delivery: captureDelivery });

  cookieA = await login('alpha@test.io');
  cookieB = await login('beta@test.io');
  cookieC = await login('gamma@test.io');
});

after(async () => {
  await api?.close();
  await orch?.stop();
  await pool?.end();
});

// ── auth ─────────────────────────────────────────────────────────────────────

test('request-link: unknown email → 204 and nothing delivered', async () => {
  delivered.length = 0;
  const res = await call({ method: 'POST', url: '/api/auth/request-link', payload: { email: 'stranger@test.io' } });
  assert.equal(res.statusCode, 204, 'response does not reveal whether the email exists');
  assert.equal(delivered.length, 0);
});

test('redeem: a link is single-use', async () => {
  delivered.length = 0;
  await call({ method: 'POST', url: '/api/auth/request-link', payload: { email: 'alpha@test.io' } });
  const token = new URL(delivered[0].url).searchParams.get('token')!;
  const first = await call({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(token)}` });
  assert.equal(first.statusCode, 302);
  const second = await call({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(token)}` });
  assert.equal(second.statusCode, 401);
  assert.equal(second.json().error, 'link_already_used');
});

test('redeem: expired and forged tokens → 401', async () => {
  const managerId = (await q(`SELECT id FROM managers WHERE email = 'alpha@test.io'`)).rows[0].id;
  const expired = mintMagicToken(SECRET, managerId, -1000);
  assert.equal((await call({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(expired)}` })).statusCode, 401);

  const forged = mintMagicToken('wrong-secret', managerId, 60_000);
  assert.equal((await call({ method: 'GET', url: `/api/auth/redeem?token=${encodeURIComponent(forged)}` })).statusCode, 401);
  assert.equal((await call({ method: 'GET', url: '/api/auth/redeem?token=garbage' })).statusCode, 401);
});

test('request-link is rate-limited per email', async () => {
  const email = 'ratelimit-probe@test.io'; // unknown emails are limited too
  for (let i = 0; i < 3; i++) {
    assert.equal((await call({ method: 'POST', url: '/api/auth/request-link', payload: { email } })).statusCode, 204);
  }
  assert.equal((await call({ method: 'POST', url: '/api/auth/request-link', payload: { email } })).statusCode, 429);
});

test('no or bogus session → 401', async () => {
  assert.equal((await call({ method: 'GET', url: '/api/me' })).statusCode, 401);
  assert.equal((await call({ method: 'GET', url: '/api/me', cookie: '00000000-0000-0000-0000-000000000000' })).statusCode, 401);
});

// ── club-scoped reads ────────────────────────────────────────────────────────

test('/me returns manager, club, season phase', async () => {
  const res = await call({ method: 'GET', url: '/api/me', cookie: cookieA });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.manager.email, 'alpha@test.io');
  assert.equal(body.club.id, clubA);
  assert.equal(body.club.name, 'Alpha');
  assert.equal(body.season.phase, 'regular');
});

test('/squad returns own 13 players with league state', async () => {
  const res = await call({ method: 'GET', url: '/api/squad', cookie: cookieA });
  assert.equal(res.statusCode, 200);
  const { players } = res.json();
  assert.equal(players.length, 13);
  for (const key of ['playerId', 'fullName', 'position', 'fatigue', 'injuryWeeksLeft', 'suspendedNext', 'justReturned', 'seasonMinutes']) {
    assert.ok(key in players[0], `squad row exposes ${key}`);
  }
});

// ── submission flow ──────────────────────────────────────────────────────────

test('tactics: non-participant and wrong-half/state are refused', async () => {
  const res = await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieC, payload: buildTactics(playersA) });
  assert.equal(res.statusCode, 404, 'non-participant cannot even see the fixture');

  const h2early = await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/2`, cookie: cookieA, payload: buildTactics(playersA) });
  assert.equal(h2early.statusCode, 409, 'half 2 while scheduled is a state violation');

  const badHalf = await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/3`, cookie: cookieA, payload: buildTactics(playersA) });
  assert.equal(badHalf.statusCode, 404);

  assert.equal((await call({ method: 'GET', url: `/api/fixture/${fixtureId}/ht`, cookie: cookieA })).statusCode, 409, 'no HT report while scheduled');
});

test('tactics: eligibility failures are 422 with the issues array, nothing stored', async () => {
  await q(`UPDATE squad_players SET injury_weeks_left = 2 WHERE player_id = $1`, [playersA[5]]);
  const res = await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieA, payload: buildTactics(playersA) });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'tactics_rejected');
  assert.ok(body.issues.some((i: { code: string; playerId?: string }) => i.code === 'player_unavailable' && i.playerId === playersA[5]));
  const rows = await q(`SELECT count(*) FROM tactics_submissions WHERE fixture_id = $1`, [fixtureId]);
  assert.equal(Number(rows.rows[0].count), 0, 'validation happens BEFORE insert');
  await q(`UPDATE squad_players SET injury_weeks_left = 0 WHERE player_id = $1`, [playersA[5]]);

  const malformed = await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieA, payload: { players: 'nope' } });
  assert.equal(malformed.statusCode, 400);
});

test('tactics: both submit half 1 via the API → sim runs; opponent status is boolean-only', async () => {
  assert.equal((await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieA, payload: buildTactics(playersA) })).statusCode, 204);
  assert.equal((await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieA, payload: buildTactics(playersA) })).statusCode, 204, 'resubmission replaces (PUT)');

  const mwB = await call({ method: 'GET', url: '/api/matchweek/current', cookie: cookieB });
  assert.equal(mwB.statusCode, 200);
  const viewB = mwB.json();
  assert.equal(viewB.fixture.submissions.you.half1, false);
  assert.equal(viewB.fixture.submissions.opponent.half1, true, 'B sees that A submitted');
  const raw = JSON.stringify(viewB);
  assert.ok(!raw.includes('anchors') && !raw.includes('riskAppetite'), 'no tactics payload leaks through the matchweek view');

  // own submission read-back (HT screen seed); opponents never see it
  const own = await call({ method: 'GET', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieA });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().payload.players.length, 11);
  assert.equal((await call({ method: 'GET', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieC })).statusCode, 404);

  assert.equal((await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieB, payload: buildTactics(playersB) })).statusCode, 204);
  await waitFor(async () => (await q(`SELECT state FROM fixtures WHERE id = $1`, [fixtureId])).rows[0].state === 'awaiting_ht', 'half-1 sim via queue');
});

test('HT report: participants only, no rng state leak', async () => {
  const res = await call({ method: 'GET', url: `/api/fixture/${fixtureId}/ht`, cookie: cookieA });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.events) && body.stats && Array.isArray(body.score));
  assert.ok(!JSON.stringify(body).includes('rngState'), 'resume state never leaves the server');

  assert.equal((await call({ method: 'GET', url: `/api/fixture/${fixtureId}/ht`, cookie: cookieC })).statusCode, 404);
});

test('half 2: window, sub cap, no re-entry, sent-off exclusion, then sim to final', async () => {
  const putH2 = (cookie: string, ids: string[]) =>
    call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/2`, cookie, payload: buildTactics(ids) });

  // HT window
  await q(`UPDATE fixtures SET ht_deadline = now() - interval '1 minute' WHERE id = $1`, [fixtureId]);
  const closed = await putH2(cookieB, playersB);
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().error, 'ht_window_closed');
  await q(`UPDATE fixtures SET ht_deadline = now() + interval '2 hours' WHERE id = $1`, [fixtureId]);

  // sent-off players are ineligible: doctor the half-1 end state, then restore it
  const original = (await q(`SELECT end_state FROM half_results WHERE fixture_id = $1 AND half = 1`, [fixtureId])).rows[0].end_state;
  const doctored = structuredClone(original);
  doctored.playerState[playersA[7]].cards.sentOff = true;
  await q(`UPDATE half_results SET end_state = $2 WHERE fixture_id = $1 AND half = 1`, [fixtureId, JSON.stringify(doctored)]);
  const sentOffTry = await putH2(cookieA, playersA); // half-1 XI includes playersA[7]
  assert.equal(sentOffTry.statusCode, 422);
  assert.ok(
    sentOffTry.json().issues.some((i: { code: string; playerId?: string }) => i.code === 'sent_off_player' && i.playerId === playersA[7]),
    'sent-off starter rejected',
  );
  await q(`UPDATE half_results SET end_state = $2 WHERE fixture_id = $1 AND half = 1`, [fixtureId, JSON.stringify(original)]);

  // sub cap: 6 swaps vs the half-1 XI exceeds htSubsMax (5)
  const extras: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = await q(
      `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, market_value, attributes, physical)
       VALUES ($1, '2002-05-05', 'MF', 180, 78, 1000000, $2, $3) RETURNING id`,
      [`Alpha Extra ${i}`, JSON.stringify(flatAttributes(false)), JSON.stringify({ injuryProneness: 10 })],
    );
    extras.push(p.rows[0].id);
    await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`, [p.rows[0].id, clubA, seasonId]);
    await q(`INSERT INTO squad_players (club_id, season_id, player_id, fatigue) VALUES ($1, $2, $3, 0.1)`, [clubA, seasonId, p.rows[0].id]);
  }
  const sixSwaps = await putH2(cookieA, [...playersA.slice(0, 5), ...extras, playersA[11]]);
  assert.equal(sixSwaps.statusCode, 422);
  assert.ok(sixSwaps.json().issues.some((i: { code: string }) => i.code === 'too_many_subs'));

  // Half-2 XIs are built from what ACTUALLY happened in half 1: the sim is
  // seeded by the fixture seed, but freshly-minted player UUIDs still vary
  // outcomes per run, so an organic red card among fixed starters made the
  // strict 204s below flaky (hit PR #10, green on rerun). A sent-off
  // exclusion costs a sub like any other swap.
  const endState = original as { playerState: Record<string, { cards?: { sentOff?: boolean } }> };
  const survivors = (squad: string[]) => {
    const h1XI = squad.slice(0, 11);
    const fit = h1XI.filter((id) => !endState.playerState[id]?.cards?.sentOff);
    return { h1XI, fit };
  };

  // a legal ≤2-swap resubmission sticks: keep 9 fit starters, bring the bench on
  const A = survivors(playersA);
  assert.ok(A.fit.length >= 9, `half 1 left ${A.fit.length} fit Alpha starters — cannot field a legal XI`);
  assert.ok(A.fit.includes(playersA[0]), 'sole Alpha GK must survive half 1 for this test to field an XI');
  const xiA = [...A.fit.slice(0, 9), playersA[11], playersA[12]];
  assert.equal((await putH2(cookieA, xiA)).statusCode, 204);

  // no re-entry: anyone out of the accepted XI (swapped or sent off) stays off
  const droppedA = A.h1XI.filter((id) => !xiA.includes(id));
  const probe = [...xiA.filter((id) => id !== playersA[12]), droppedA[0]];
  const reentry = await putH2(cookieA, probe);
  assert.equal(reentry.statusCode, 422);
  assert.ok(
    reentry.json().issues.some((i: { code: string; playerId?: string }) => i.code === 'reentry' && i.playerId === droppedA[0]),
    'substituted players stay off',
  );

  // and the derived-XI approach fields a legal side when a red card DID
  // happen — deterministic coverage of the branch that used to flake:
  // doctor a current starter as sent off, resubmit without him (a squad
  // extra comes on: 3 swaps vs half 1, within the cap)
  const withRed = structuredClone(original);
  withRed.playerState[playersA[5]].cards.sentOff = true;
  await q(`UPDATE half_results SET end_state = $2 WHERE fixture_id = $1 AND half = 1`, [fixtureId, JSON.stringify(withRed)]);
  const xiRed = [...xiA.filter((id) => id !== playersA[5]), extras[0]];
  assert.equal((await putH2(cookieA, xiRed)).statusCode, 204, 'derived XI stays legal when a red card actually happened');
  await q(`UPDATE half_results SET end_state = $2 WHERE fixture_id = $1 AND half = 1`, [fixtureId, JSON.stringify(original)]);

  const B = survivors(playersB);
  assert.ok(B.fit.length >= 9, `half 1 left ${B.fit.length} fit Beta starters — cannot field a legal XI`);
  assert.ok(B.fit.includes(playersB[0]), 'sole Beta GK must survive half 1 for this test to field an XI');
  const xiB = [...B.fit, playersB[11], playersB[12]].slice(0, 11);
  assert.equal((await putH2(cookieB, xiB)).statusCode, 204);
  await waitFor(async () => (await q(`SELECT state FROM fixtures WHERE id = $1`, [fixtureId])).rows[0].state === 'final', 'half-2 sim via queue');

  const late = await call({ method: 'PUT', url: `/api/fixture/${fixtureId}/tactics/1`, cookie: cookieA, payload: buildTactics(playersA) });
  assert.equal(late.statusCode, 409, 'no submissions once final');
});

// ── embargo (the security property of this PR) ───────────────────────────────

test('embargo: participant sees own final result pre-reveal; others do not', async () => {
  const participant = await call({ method: 'GET', url: `/api/fixture/${fixtureId}/result`, cookie: cookieA });
  assert.equal(participant.statusCode, 200, 'participant sees own final result before reveal');
  const body = participant.json();
  assert.equal(body.halves.length, 2);
  assert.ok(Array.isArray(body.finalScore));

  const outsider = await call({ method: 'GET', url: `/api/fixture/${fixtureId}/result`, cookie: cookieC });
  assert.equal(outsider.statusCode, 404, 'non-participant blocked until reveal');

  // replay rides the SAME embargo predicate: participant 200, outsider 404
  const replay = await call({ method: 'GET', url: `/api/fixture/${fixtureId}/replay`, cookie: cookieA });
  assert.equal(replay.statusCode, 200, 'participant sees own replay before reveal');
  const rbody = replay.json();
  assert.equal(rbody.halves.length, 2);
  for (const h of rbody.halves) {
    assert.ok(Array.isArray(h.frames) && h.frames.length > 0, `half ${h.half} has frames`);
    const f = h.frames[0];
    assert.ok(typeof f.t === 'number' && f.ball && f.players, 'frames carry t/ball/players');
  }
  assert.ok(rbody.homePlayers.length === 11 || rbody.homePlayers.length > 11, 'home side listed (XI + HT subs)');
  assert.ok(!JSON.stringify(rbody).includes('rngState'), 'no resume state in the replay payload');
  assert.equal(
    (await call({ method: 'GET', url: `/api/fixture/${fixtureId}/replay`, cookie: cookieC })).statusCode,
    404,
    'non-participant replay blocked until reveal',
  );
});

test('embargo: standings ignore unrevealed fixtures — even for participants', async () => {
  const res = await call({ method: 'GET', url: '/api/standings', cookie: cookieA });
  assert.equal(res.statusCode, 200);
  const { table } = res.json();
  assert.equal(table.length, 3);
  for (const row of table) {
    assert.equal(row.played, 0, `${row.name}: unrevealed result must not appear in the table`);
    assert.equal(row.points, 0);
  }
});

test('embargo: after reveal, result and standings open up consistently', async () => {
  await q(`UPDATE matchweeks SET revealed_at = now() WHERE id = $1`, [matchweekId]);

  const outsider = await call({ method: 'GET', url: `/api/fixture/${fixtureId}/result`, cookie: cookieC });
  assert.equal(outsider.statusCode, 200, 'revealed results are public');
  assert.equal(
    (await call({ method: 'GET', url: `/api/fixture/${fixtureId}/replay`, cookie: cookieC })).statusCode,
    200,
    'revealed replays are public',
  );
  const [homeGoals, awayGoals] = outsider.json().finalScore as [number, number];

  const res = await call({ method: 'GET', url: '/api/standings', cookie: cookieC });
  const { table } = res.json() as { table: Array<{ clubId: string; played: number; points: number; goalsFor: number }> };
  const rowA = table.find((r) => r.clubId === clubA)!;
  const rowB = table.find((r) => r.clubId === clubB)!;
  const rowC = table.find((r) => r.clubId === clubC)!;
  assert.equal(rowA.played, 1);
  assert.equal(rowB.played, 1);
  assert.equal(rowC.played, 0);
  assert.equal(rowA.goalsFor, homeGoals);
  assert.equal(rowB.goalsFor, awayGoals);
  const expected: [number, number] = homeGoals > awayGoals ? [3, 0] : homeGoals < awayGoals ? [0, 3] : [1, 1];
  assert.deepEqual([rowA.points, rowB.points], expected, 'points match the revealed score');
});

// ── default tactics ──────────────────────────────────────────────────────────

test('default tactics: validated like submissions, upsert on success', async () => {
  const bad = structuredClone(buildTactics(playersA)) as Tactics;
  bad.players[1].playerId = playersA[0];
  const rejected = await call({ method: 'PUT', url: '/api/default-tactics', cookie: cookieA, payload: bad });
  assert.equal(rejected.statusCode, 422);
  assert.ok(rejected.json().issues.some((i: { code: string }) => i.code === 'duplicate_player'));

  const ok = await call({ method: 'PUT', url: '/api/default-tactics', cookie: cookieA, payload: buildTactics(playersA) });
  assert.equal(ok.statusCode, 204);
  const row = await q(`SELECT payload FROM default_tactics WHERE club_id = $1`, [clubA]);
  assert.equal(row.rows[0].payload.players.length, 11);
});
