/**
 * scripts/playable-match.ts — ONE COMMAND: empty scratch database → a completed,
 * watchable match, with the proof asserted rather than left to the eye.
 *
 *   pnpm playable
 *
 * What it does, in order: creates a local scratch database, runs the real
 * `seed-demo.ts` into it, boots the real `league-server.ts` as a CHILD with the
 * test overrides in ITS environment only, signs both demo managers up over the
 * real HTTP API, drives the real auction to squadMin for both clubs, submits
 * both lineups (which is what makes the server sim half 1 for real), forces the
 * matchweek close, and then ASSERTS the match is watchable before printing the
 * fixture id and the replay URL.
 *
 * THIS SCRIPT IS DESTRUCTIVE and refuses anything that is not obviously a local
 * scratch database — see `assertScratchDatabase` below. Production and local
 * differ only by DATABASE_URL, so the guards are deliberately layered: a host
 * allowlist, a remote-provider denylist, and — the one that actually matters —
 * a refusal to drop any database holding a league schema this script did not
 * create.
 *
 * IT ADDS NO PRODUCT BEHAVIOUR. Every step is an existing script, an existing
 * route, or an existing engine export. If this file ever needs a product change
 * to work, that is a finding about the loop, not a licence to make one.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LEAGUE_CFG } from '@fm/engine/config';
import { bestXI } from '@fm/engine/eligibility';
import type { EligiblePlayer } from '@fm/engine/eligibility';
import type { Tactics } from '@fm/engine/types';

// ── the run's shape ──────────────────────────────────────────────────────────

const DEFAULT_DB = 'postgres://postgres:fm@localhost:54329/fm_playable';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
/** an SSH tunnel can make a remote database answer on localhost — refuse the giveaways */
const REMOTE_MARKERS = ['supabase', 'pooler', 'fly.dev', 'neon.tech', 'rds.amazonaws', 'render.com', 'railway'];
/** dropped and re-created by every run; its ABSENCE next to a league schema is the refusal */
const MARKER_TABLE = 'playable_scratch';

const MANAGERS = [
  { email: 'alice@demo.io', club: 'Alpha FC' },
  { email: 'bob@demo.io', club: 'Beta United' },
];
const PASSWORD = 'playable-match-demo';
/** 13 = LEAGUE_CFG.squadMin; the shape only has to make a legal XI possible */
const TARGET_SHAPE: Array<[string, number]> = [['GK', 2], ['DF', 5], ['MF', 4], ['FW', 2]];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const DATABASE_URL = flag('database-url') || process.env.PLAYABLE_DATABASE_URL || DEFAULT_DB;
const PORT = Number(flag('port') || 8099);
const ENGINE = flag('engine'); // undefined → the product default (aggregate)
const EXIT_WHEN_DONE = flag('exit-when-done') !== undefined;

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const base = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
const serverLog: string[] = [];

// ── failure is loud, and says what was expected ──────────────────────────────

class Failed extends Error {}

function die(what: string, detail?: string): never {
  throw new Failed(detail ? `${what}\n  ${detail}` : what);
}

/** the assertion form the mandate asks for: expected vs what came back */
function expect(ok: unknown, what: string, expected: string, got: unknown): void {
  if (ok) {
    console.log(`  ✓ ${what}`);
    return;
  }
  die(`ASSERTION FAILED — ${what}`, `expected: ${expected}\n  got:      ${typeof got === 'string' ? got : JSON.stringify(got)}`);
}

const step = (n: number, msg: string): void => console.log(`\n[${n}/9] ${msg}`);

// ── preflight ────────────────────────────────────────────────────────────────

function assertLocalUrl(): URL {
  let url: URL;
  try {
    url = new URL(DATABASE_URL);
  } catch {
    return die(`DATABASE_URL is not a URL: ${DATABASE_URL}`);
  }
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    die(
      `REFUSING: this script DROPS SCHEMAS and only runs against a local host — got "${url.hostname}".`,
      'Production and local differ only by DATABASE_URL. Point it at a local scratch database, or use\n  server/scripts/setup-production.ts, which is the non-destructive path.',
    );
  }
  const marker = REMOTE_MARKERS.find((m) => DATABASE_URL.includes(m));
  if (marker) {
    die(
      `REFUSING: DATABASE_URL contains "${marker}", which names a hosted provider even though the host reads local.`,
      'A tunnel to a real database is exactly the accident this check exists for.',
    );
  }
  if (!url.pathname || url.pathname === '/') die('DATABASE_URL has no database name');
  return url;
}

async function assertPostgresReachable(url: URL): Promise<void> {
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
  } catch (err) {
    die(
      `Postgres is not reachable at ${url.hostname}:${url.port || 5432}.`,
      `Start the test database with:\n    pnpm db:test:up\n  (underlying error: ${(err as Error).message})`,
    );
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount === 0) {
    console.log(`  creating scratch database "${name}"`);
    await client.query(`CREATE DATABASE ${JSON.stringify(name).replace(/"/g, '"')}`);
  } else {
    console.log(`  scratch database "${name}" already exists`);
  }
  await client.end();
}

/**
 * THE GUARD THAT MATTERS. A database is safe to drop only when it holds no
 * league schema at all, or when it holds the marker this script writes. Anything
 * else is somebody's data.
 */
async function assertScratchDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 4000 });
  await client.connect();
  try {
    const seasons = await client.query(`SELECT to_regclass('public.seasons') AS t`);
    if (seasons.rows[0].t === null) {
      console.log('  target holds no league schema — safe to seed');
      return;
    }
    const marker = await client.query(`SELECT to_regclass($1) AS t`, [`public.${MARKER_TABLE}`]);
    if (marker.rows[0].t === null) {
      const counts = await client.query(
        `SELECT (SELECT count(*) FROM seasons) AS seasons, (SELECT count(*) FROM clubs) AS clubs`,
      ).catch(() => ({ rows: [{ seasons: '?', clubs: '?' }] }));
      die(
        'REFUSING: the target database holds a league schema this script did not create.',
        `It has ${counts.rows[0].seasons} season(s) and ${counts.rows[0].clubs} club(s), and no "${MARKER_TABLE}" marker table.\n` +
        '  seed-demo DROPS the public and pgboss schemas. If this really is a throwaway database,\n' +
        `  drop it yourself first; this script will not guess.`,
      );
    }
    console.log(`  target carries the "${MARKER_TABLE}" marker — a previous run's scratch database`);
  } finally {
    await client.end();
  }
}

function assertWebBundle(): void {
  if (existsSync(new URL('../../web/dist/index.html', import.meta.url))) {
    console.log('  web/dist present — the replay URL will open in a browser');
    return;
  }
  die(
    'web/dist is missing, so the server would serve the API only and the replay URL would 404.',
    'Build the client first:\n    pnpm --filter @fm/web build',
  );
}

async function assertPortFree(): Promise<void> {
  await new Promise<void>((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      probe.close();
      die(
        `port ${PORT} is already in use, so the server child cannot bind it.`,
        `Stop whatever holds it, or re-run with --port=<free port>.`,
      );
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(PORT, '127.0.0.1');
  });
}

// ── child processes ──────────────────────────────────────────────────────────

function run(cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => process.stdout.write(`  │ ${d.toString().replace(/\n(?!$)/g, '\n  │ ')}`));
    child.stderr.on('data', (d: Buffer) => process.stderr.write(`  │ ${d.toString().replace(/\n(?!$)/g, '\n  │ ')}`));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Failed(`${label} exited ${code}`))));
  });
}

/**
 * The overrides live HERE and nowhere else: they are built into the child's
 * environment object and never written to process.env, so no shell the operator
 * later uses — least of all one pointed at production — can inherit them.
 * Production-shaped variables are stripped for the same reason.
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const leak of ['RESEND_API_KEY', 'EMAIL_FROM', 'BASE_URL', 'SIM_ENGINE']) delete env[leak];
  if (ENGINE) env.SIM_ENGINE = ENGINE;
  return env;
}

async function startServer(): Promise<void> {
  const env = childEnv({
    DATABASE_URL,
    SESSION_SECRET: randomBytes(24).toString('hex'),
    HOST: '127.0.0.1',
    PORT: String(PORT),
    // TEST-ONLY, child-scoped: 1s lots so 26 of them take a minute, and the
    // admin route that closes the matchweek on demand.
    AUCTION_LOT_SECONDS_TEST: '1',
    TEST_FORCE_WEEK_CLOSE: '1',
  });
  server = spawn('node', ['league-server.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (d: Buffer): void => {
    const s = d.toString();
    serverLog.push(s);
    if (serverLog.length > 400) serverLog.shift();
  };
  server.stdout!.on('data', keep);
  server.stderr!.on('data', keep);
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`\n[server] exited ${code}\n${serverLog.slice(-25).join('')}`);
  });

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) die('the server child exited during startup', serverLog.slice(-25).join('').trim());
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        console.log(`  server up on ${base} (engine: ${ENGINE ?? 'aggregate — the product default'})`);
        return;
      }
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  die('the server did not answer /api/health within 40s', serverLog.slice(-25).join('').trim());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── an API client per manager, cookies and all ───────────────────────────────

interface Client {
  email: string;
  club: string;
  clubId: string;
  cookie: string;
  get<T>(path: string): Promise<T>;
  send<T>(method: string, path: string, body?: unknown): Promise<T>;
  try_(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

function makeClient(email: string, club: string): Client {
  const c: Client = {
    email, club, clubId: '', cookie: '',
    async get<T>(path: string): Promise<T> { return c.send<T>('GET', path); },
    async try_(method: string, path: string, body?: unknown) {
      const res = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(c.cookie ? { cookie: c.cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      for (const raw of set) if (raw.startsWith('fm_session=')) c.cookie = raw.split(';')[0];
      const text = await res.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    },
    async send<T>(method: string, path: string, body?: unknown): Promise<T> {
      const out = await c.try_(method, path, body);
      if (out.status >= 400) {
        die(`${method} /api${path} → ${out.status} for ${email}`, JSON.stringify(out.body));
      }
      return out.body as T;
    },
  };
  return c;
}

// ── the auction, driven exactly as a manager drives it ───────────────────────

interface PoolPlayer { playerId: string; fullName: string; position: string; marketValue: number }
interface AuctionState {
  phase: string;
  lot: { lotId: string; player: PoolPlayer; closesAt: string; highBid: unknown } | null;
  turn: { clubId: string; name: string; you: boolean } | null;
  clubs: Array<{ clubId: string; name: string; squadCount: number; you: boolean }>;
  signings: Array<{ playerId: string; position: string }>;
  squadMin: number;
  squadMax: number;
}

const groupOfPosition = (p: string): string =>
  p.startsWith('GK') ? 'GK' : p.startsWith('DF') ? 'DF' : p.startsWith('MF') ? 'MF' : 'FW';

/** what this club still wants, most-wanted first — keeps a legal XI reachable */
function wantedGroups(signings: Array<{ position: string }>): string[] {
  const have = new Map<string, number>();
  for (const s of signings) {
    const g = groupOfPosition(s.position);
    have.set(g, (have.get(g) ?? 0) + 1);
  }
  return TARGET_SHAPE
    .map(([g, want]) => ({ g, deficit: want - (have.get(g) ?? 0) }))
    .filter((x) => x.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit)
    .map((x) => x.g);
}

function pickNomination(pool: PoolPlayer[], signings: Array<{ position: string }>): PoolPlayer {
  const cheapest = [...pool].sort((a, b) => a.marketValue - b.marketValue);
  for (const g of wantedGroups(signings)) {
    const hit = cheapest.find((p) => groupOfPosition(p.position) === g);
    if (hit) return hit;
  }
  if (cheapest.length === 0) die('the auction pool is empty but a club is still short of squadMin');
  return cheapest[0];
}

async function driveAuction(clients: Client[]): Promise<void> {
  const byClub = new Map(clients.map((c) => [c.clubId, c]));
  const squadMin = LEAGUE_CFG.squadMin;
  let lots = 0;
  const maxLots = clients.length * LEAGUE_CFG.squadMax + 10;

  while (lots < maxLots) {
    const state = await clients[0].get<AuctionState>('/auction/state');
    if (state.phase !== 'auction') {
      console.log(`  auction complete after ${lots} lots — phase is now "${state.phase}"`);
      return;
    }
    if (state.clubs.every((c) => c.squadCount >= squadMin) && !state.lot) {
      // the completion transition rides the last lot close; give it a beat
      await sleep(500);
      continue;
    }
    if (state.lot) { await sleep(200); continue; } // a lot from a previous iteration is still closing

    const turnId = state.turn?.clubId;
    const nominator = turnId ? byClub.get(turnId) : undefined;
    if (!nominator) die('no club has the nomination turn', JSON.stringify(state.turn));

    const before = await nominator.get<AuctionState>('/auction/state');
    const pool = (await nominator.get<{ players: PoolPlayer[] }>('/auction/pool')).players;
    const pick = pickNomination(pool, before.signings);

    const lot = await nominator.send<{ lotId: string }>('POST', '/auction/nominate', { playerId: pick.playerId });
    lots++;

    // the bid: the minimum is highBid + bidIncrementMin, which for a first bid
    // is the increment itself and has nothing to do with market value — the
    // 409 carries the real minimum, so take it from there rather than guessing.
    let amount = LEAGUE_CFG.bidIncrementMin;
    let bid = await nominator.try_('POST', '/auction/bid', { lotId: lot.lotId, amount });
    if (bid.status === 409 && typeof bid.body?.minimum === 'number') {
      amount = bid.body.minimum;
      bid = await nominator.try_('POST', '/auction/bid', { lotId: lot.lotId, amount });
    }
    if (bid.status >= 400) {
      die(`bidding on lot ${lot.lotId} failed for ${nominator.club}`, `${bid.status} ${JSON.stringify(bid.body)}`);
    }

    // WAIT FOR THE SIGNING, never a fixed delay: lot closes are pg-boss paced,
    // and re-reading too early re-nominates the same player forever.
    const target = before.signings.length + 1;
    const deadline = Date.now() + 60_000;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(300);
      after = await nominator.get<AuctionState>('/auction/state');
      if (after.phase !== 'auction') break;      // that lot completed the auction
      if (after.signings.length >= target) break;
      if (!after.lot && after.signings.length < target) {
        die(`lot ${lot.lotId} closed without a signing for ${nominator.club}`, `bid ${amount} on ${pick.fullName}`);
      }
    }
    if (after.phase === 'auction' && after.signings.length < target) {
      die(`lot ${lot.lotId} did not close within 60s`, JSON.stringify(after.lot));
    }
    const counts = after.clubs.map((c) => `${c.name} ${c.squadCount}`).join(', ');
    console.log(`  lot ${String(lots).padStart(2)} — ${nominator.club} signs ${pick.fullName} (${pick.position}) for ${amount.toLocaleString()} · ${counts}`);
  }
  die(`the auction did not complete within ${maxLots} lots`);
}

// ── lineups, the close, and the proof ────────────────────────────────────────

interface SquadPlayer {
  playerId: string; fullName: string; position: string;
  attributes: Record<string, number>; injuryWeeksLeft: number; suspendedNext: boolean;
}
interface CurrentMatchweek {
  matchweek: { id: string; number: number; kind: string };
  fixture: { id: string; state: string; home: { name: string }; away: { name: string } } | null;
}

async function submitLineup(c: Client, fixtureId: string): Promise<void> {
  const squad = (await c.get<{ players: SquadPlayer[] }>('/squad')).players;
  const eligible: EligiblePlayer[] = squad.map((p) => ({
    playerId: p.playerId,
    position: p.position,
    attributes: p.attributes as unknown as EligiblePlayer['attributes'],
    injuryWeeksLeft: p.injuryWeeksLeft,
    suspendedNext: p.suspendedNext,
  }));
  // bestXI is the engine's own selection — the same function the server falls
  // back to. Using it means this script invents no tactics of its own.
  const tactics: Tactics = bestXI(eligible, fixtureId);
  await c.send('PUT', `/fixture/${fixtureId}/tactics/1`, tactics);
  console.log(`  ${c.club} submitted an XI (${tactics.players.length} starters, ${tactics.bench.length} on the bench)`);
}

async function fixtureStateFromDb(fixtureId: string): Promise<string> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT state FROM fixtures WHERE id = $1', [fixtureId]);
    return rows[0]?.state ?? 'MISSING';
  } finally {
    await client.end();
  }
}

async function markScratch(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         note TEXT NOT NULL
       )`,
    );
    await client.query(`INSERT INTO ${MARKER_TABLE} (note) VALUES ($1)`, [
      'created by server/scripts/playable-match.ts — this database is a throwaway and gets dropped on every run',
    ]);
  } finally {
    await client.end();
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`playable-match — a complete, watchable match on ${DATABASE_URL}`);

  step(1, 'preflight: local target, Postgres, scratch database, web bundle, free port');
  const url = assertLocalUrl();
  await assertPostgresReachable(url);
  await assertScratchDatabase();
  assertWebBundle();
  await assertPortFree();

  step(2, 'seed the demo season (server/scripts/seed-demo.ts — DROPS the public and pgboss schemas)');
  await run('node', ['scripts/seed-demo.ts'], serverDir, childEnv({ DATABASE_URL }), 'seed-demo');
  await markScratch();

  step(3, 'boot the server with the test overrides in ITS environment only');
  await startServer();

  step(4, 'sign both demo managers up (this claims their seeded clubs)');
  const clients: Client[] = [];
  for (const m of MANAGERS) {
    const c = makeClient(m.email, m.club);
    const signup = await c.try_('POST', '/auth/signup', { email: m.email, password: PASSWORD });
    if (signup.status !== 200) die(`signup failed for ${m.email}`, `${signup.status} ${JSON.stringify(signup.body)}`);
    const me = await c.get<{ club: { id: string; name: string } | null }>('/me');
    if (!me.club) die(`${m.email} signed up but claimed no club — seed-demo's manager rows did not match`);
    c.clubId = me.club.id;
    console.log(`  ${m.email} → ${me.club.name}`);
    clients.push(c);
  }

  step(5, `drive the auction to squadMin (${LEAGUE_CFG.squadMin}) for both clubs`);
  await driveAuction(clients);

  step(6, 'find matchweek 1 and submit both lineups');
  const mw = await clients[0].get<CurrentMatchweek>('/matchweek/current');
  if (!mw.fixture) die('matchweek 1 has no fixture for this club', JSON.stringify(mw.matchweek));
  const fixtureId = mw.fixture.id;
  console.log(`  MW${mw.matchweek.number}: ${mw.fixture.home.name} v ${mw.fixture.away.name} (${fixtureId})`);
  for (const c of clients) await submitLineup(c, fixtureId);

  step(7, 'force the matchweek close — real sims, real bookkeeping, real reveal');
  const closed = await clients[0].send<{ matchweek: number; status: string }>(
    'POST', '/admin/force-week-close', { confirm: 'SIM NOW' },
  );
  console.log(`  week close → ${closed.status}`);

  step(8, 'assert the match is complete and watchable');
  const state = await fixtureStateFromDb(fixtureId);
  expect(state === 'final', 'the fixture reached `final`', "state === 'final'", state);

  const replay = await clients[0].try_('GET', `/fixture/${fixtureId}/replay`);
  expect(replay.status === 200, '/api/fixture/:id/replay returns 200', '200', `${replay.status} ${JSON.stringify(replay.body)}`);
  const halves: Array<{ half: number; frames: unknown[] }> = replay.body?.halves ?? [];
  expect(halves.length === 2, 'the replay carries both halves', '2 halves', halves.length);
  for (const h of halves) {
    expect(
      Array.isArray(h.frames) && h.frames.length > 0,
      `half ${h.half} has replay frames`, '> 0 frames', Array.isArray(h.frames) ? h.frames.length : h.frames,
    );
  }

  const result = await clients[0].try_('GET', `/fixture/${fixtureId}/result`);
  expect(result.status === 200, '/api/fixture/:id/result returns 200', '200', `${result.status} ${JSON.stringify(result.body)}`);
  const score = result.body?.finalScore;
  expect(
    Array.isArray(score) && score.length === 2 && score.every((n: unknown) => Number.isInteger(n)),
    'the scoreline is a pair of integers', '[home, away]', score,
  );

  const events = (result.body?.halves ?? []).flatMap((h: { events: Array<{ type: string }> }) => h.events ?? []);
  expect(events.length > 0, 'the match timeline is non-empty', '> 0 events', events.length);
  // shots, not goals: a 0–0 with no cards is a legitimate match, so asserting on
  // goal/card events would be a flake. A 90 minutes with zero shots would not be.
  const shots = events.filter((e: { type: string }) => e.type === 'shot').length;
  expect(shots > 0, 'the timeline contains shots', '> 0 shot events', shots);

  for (const h of result.body.halves as Array<{ half: number; stats: Record<string, unknown> }>) {
    const stats = h.stats ?? {};
    const possession = stats.possession as [number, number] | undefined;
    expect(
      Array.isArray(possession) && Math.round(possession[0] + possession[1]) === 100,
      `half ${h.half} stats carry possession summing to 100`, 'possession pair summing to 100', possession,
    );
    const ratings = stats.playerRatings as Record<string, number> | undefined;
    expect(
      ratings !== undefined && Object.keys(ratings).length > 0,
      `half ${h.half} stats carry player ratings`, '> 0 rated players', ratings && Object.keys(ratings).length,
    );
  }

  step(9, 'done');
  const goals = events.filter((e: { type: string }) => e.type === 'goal').length;
  console.log(`
  ┌─ A COMPLETE MATCH ─────────────────────────────────────────────
  │ ${mw.fixture.home.name} ${score[0]}–${score[1]} ${mw.fixture.away.name}   (${goals} goal event${goals === 1 ? '' : 's'}, ${shots} shots, ${events.length} events)
  │ fixture   ${fixtureId}
  │ watch it  ${base}/season/match/${fixtureId}
  │ sign in   ${MANAGERS[0].email} / ${PASSWORD}
  └────────────────────────────────────────────────────────────────`);

  if (EXIT_WHEN_DONE) {
    console.log('\n--exit-when-done: stopping the server.');
    return;
  }
  console.log('\nThe server is still running so you can open that URL. Ctrl-C to stop it.');
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
}

const stopServer = (): void => {
  if (server && server.exitCode === null) server.kill('SIGTERM');
};

try {
  await main();
  stopServer();
  process.exit(0);
} catch (err) {
  stopServer();
  console.error(`\n✗ ${err instanceof Failed ? err.message : err}`);
  if (!(err instanceof Failed) && err instanceof Error && err.stack) console.error(err.stack);
  if (serverLog.length > 0) console.error(`\n--- last server output ---\n${serverLog.slice(-20).join('')}`);
  process.exit(1);
}
