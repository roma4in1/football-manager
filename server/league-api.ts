/**
 * league-api.ts — HTTP API + email/password auth (Fastify).
 *
 * Framework: Fastify (DECISIONS.md) — `app.inject()` gives supertest-style
 * tests without binding a port; @fastify/cookie handles the session cookie.
 *
 * Auth (LOBBY-DESIGN-SPEC §3, phase 1 of the accounts arc): self-service
 * email + password accounts. POST /auth/signup creates an account (claiming a
 * seeded manager row with the same email so its club/season stays reachable, or
 * creating a fresh clubless one) and opens a session; /auth/login verifies the
 * scrypt hash (league-password.ts) and sets the httpOnly fm_session cookie;
 * /auth/logout clears it. The one remaining email path is password reset
 * (/auth/forgot-password → emailed link → /auth/reset-password); everything
 * else is passwordful. /me is session-scoped and works before a club exists;
 * gameplay routes stay club-scoped (403 without a club).
 *
 * Embargo is THE security property here and it lives in SQL, not JS
 * post-filtering: /fixture/:id/result and /standings only see rows through
 * joins on matchweeks.revealed_at (league-store.embargoedResult / standings).
 * Opponent submission status is booleans-only (store.submissionFlags never
 * selects payloads).
 *
 * Error contract: eligibility failures → 422 { error: 'tactics_rejected',
 * issues }; state-machine violations (wrong fixture state, HT window closed)
 * → 409; unauthenticated → 401; non-participants and unknown ids → 404.
 *
 * All routes live under /api so the SPA owns every other path: Vite dev-proxies
 * /api, production Fastify serves web/dist with an index.html fallback
 * (league-server.ts). The reset link points at /reset (an SPA route), so the SW
 * /api/* navigation denylist is unaffected.
 */

import { createHash, randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Tactics } from '@fm/engine/types';
import { AuctionError } from './league-auction.ts';
import { isTrainingFocus, TRAINING_FOCUSES } from '@fm/engine/growth';
import { LEAGUE_CFG, facilityUpgradeCost } from '@fm/engine/config';
import { validateHtResubmission, validateTactics } from '@fm/engine/eligibility';
import type { Orchestrator } from './league-orchestrator.ts';
import { createTransferCore, TransferError } from './league-transfers.ts';
import { hashPassword, verifyPassword } from './league-password.ts';
import * as store from './league-store.ts';

export const SESSION_COOKIE = 'fm_session';

// ── email delivery (password-reset links only) ───────────────────────────────
// Login is email + password; the only transactional mail left is the reset link.

export interface EmailDelivery {
  sendPasswordReset(email: string, url: string): Promise<void>;
}

export const consoleEmailDelivery: EmailDelivery = {
  async sendPasswordReset(email, url) {
    console.log(`[auth] password reset for ${email}: ${url}`);
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Normalize + validate an email; null when it isn't a plausible address. */
const normEmail = (e: unknown): string | null => {
  if (typeof e !== 'string') return null;
  const trimmed = e.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : null;
};
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

// ── request context ──────────────────────────────────────────────────────────

interface SessionCtx extends store.SessionContext {
  clubId: string; // narrowed: club-scoped routes reject accounts without a club
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: SessionCtx;                // club-scoped routes (clubId guaranteed non-null)
    account: store.SessionContext;  // session-scoped routes (/me, /logout — clubId may be null)
  }
}

// ── app ──────────────────────────────────────────────────────────────────────

export interface ApiOptions {
  pool: pg.Pool;
  orchestrator: Pick<Orchestrator, 'notifyTacticsSubmitted' | 'auction' | 'runWeekClose'>;
  /** TEST-ONLY: registers POST /api/admin/force-week-close (league-server
   *  sets this from TEST_FORCE_WEEK_CLOSE=1). Unset → the route does not
   *  exist (404) — it cannot fire in a real season by accident. */
  testForceWeekClose?: boolean;
  /** Reserved for future cookie/token signing; unused by password auth (session
   *  ids are random UUIDs). Kept so callers/tests can keep passing it. */
  sessionSecret?: string;
  delivery?: EmailDelivery;
  /** Base for links in emails, e.g. https://league.example — no trailing slash. */
  baseUrl?: string;
}

export async function createApi(opts: ApiOptions): Promise<FastifyInstance> {
  const { pool, orchestrator } = opts;
  const delivery = opts.delivery ?? consoleEmailDelivery;
  const baseUrl = opts.baseUrl ?? `http://${LEAGUE_CFG.apiHost}:${LEAGUE_CFG.apiPort}`;

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  app.decorateRequest('ctx');
  app.decorateRequest('account');

  await app.register(async (root) => {
  // per-process rate limit — single-process deployment for now (league-server.ts:
  // keep ONE Fly machine so the window isn't split across instances). Guards
  // login + forgot-password against brute force / email flooding, per email.
  const attempts = new Map<string, number[]>();
  const rateLimited = (email: string, now = Date.now()): boolean => {
    const windowMs = LEAGUE_CFG.loginRateWindowMinutes * 60_000;
    const recent = (attempts.get(email) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= LEAGUE_CFG.loginRateMax) {
      attempts.set(email, recent);
      return true;
    }
    recent.push(now);
    attempts.set(email, recent);
    return false;
  };

  const startSession = async (reply: FastifyReply, managerId: string): Promise<void> => {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + LEAGUE_CFG.sessionTtlDays * 86_400_000);
    await store.createSession(pool, sessionId, managerId, expiresAt);
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
      secure: baseUrl.startsWith('https'), // production is https-only (Fly terminates TLS)
    });
  };

  // ── health (no session required) ───────────────────────────────────────────
  // Fly's HTTP check probes this: proves the HTTP layer AND the DB connection
  // (the pg-boss worker shares the same database, so green ≈ whole process).

  root.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ── auth: email + password accounts (no session required) ──────────────────

  root.post('/auth/signup', async (req, reply) => {
    const body = req.body as { email?: unknown; password?: unknown } | null;
    const email = normEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email) return reply.code(400).send({ error: 'invalid_email' });
    if (password.length < LEAGUE_CFG.passwordMinLength) return reply.code(400).send({ error: 'weak_password' });

    if (await store.accountByEmail(pool, email)) return reply.code(409).send({ error: 'email_taken' });
    const passwordHash = await hashPassword(password);
    // claim a seeded manager with this email (keeps its club/season reachable);
    // otherwise create a fresh manager — a clubless account until later phases.
    const managerId =
      (await store.claimableManagerIdByEmail(pool, email)) ??
      (await store.createManager(pool, email, email.split('@')[0]));
    try {
      await store.createAccount(pool, email, passwordHash, managerId);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email_taken' }); // race
      throw err;
    }
    await startSession(reply, managerId);
    return reply.code(200).send({ ok: true });
  });

  root.post('/auth/login', async (req, reply) => {
    const body = req.body as { email?: unknown; password?: unknown } | null;
    const email = normEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) return reply.code(400).send({ error: 'invalid_credentials' });
    if (rateLimited(email)) return reply.code(429).send({ error: 'rate_limited' });

    const account = await store.accountByEmail(pool, email);
    const ok = account ? await verifyPassword(password, account.passwordHash) : false;
    if (!account || !ok) return reply.code(401).send({ error: 'invalid_credentials' });
    await startSession(reply, account.managerId);
    return reply.code(200).send({ ok: true });
  });

  root.post('/auth/logout', async (req, reply) => {
    const sessionId = req.cookies[SESSION_COOKIE];
    if (sessionId) await store.deleteSession(pool, sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  root.post('/auth/forgot-password', async (req, reply) => {
    const email = normEmail((req.body as { email?: unknown } | null)?.email);
    if (!email) return reply.code(400).send({ error: 'invalid_email' });
    if (rateLimited(email)) return reply.code(429).send({ error: 'rate_limited' });

    const account = await store.accountByEmail(pool, email);
    if (account) {
      const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, ''); // 64 hex chars of entropy
      const expiresAt = new Date(Date.now() + LEAGUE_CFG.resetTokenTtlMinutes * 60_000);
      await store.setResetToken(pool, account.id, sha256hex(token), expiresAt);
      try {
        await delivery.sendPasswordReset(email, `${baseUrl}/reset?token=${encodeURIComponent(token)}`);
      } catch (err) {
        console.error('[auth] password-reset email failed:', err); // still 204 (no enumeration)
      }
    }
    return reply.code(204).send(); // identical response whether or not the email is known
  });

  root.post('/auth/reset-password', async (req, reply) => {
    const body = req.body as { token?: unknown; password?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!token) return reply.code(400).send({ error: 'token_required' });
    if (password.length < LEAGUE_CFG.passwordMinLength) return reply.code(400).send({ error: 'weak_password' });

    const account = await store.accountByResetToken(pool, sha256hex(token));
    if (!account) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    await store.setPassword(pool, account.id, await hashPassword(password));
    return reply.code(200).send({ ok: true });
  });

  // ── authenticated, session-scoped (club optional): the account's own view ──

  await root.register(async (sessioned) => {
    sessioned.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionId = req.cookies[SESSION_COOKIE];
      if (!sessionId) return reply.code(401).send({ error: 'unauthenticated' });
      const ctx = await store.getSessionContext(pool, sessionId);
      if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
      req.account = ctx;
    });

    // /me works BEFORE a club exists — a fresh account lands on a placeholder,
    // seeded/claimed accounts get their club + current season. (Phase 3 turns
    // club/season into the selected-league entry.)
    sessioned.get('/me', async (req) => {
      const s = await store.currentSeason(pool);
      const a = req.account;
      return {
        manager: { id: a.managerId, email: a.email, displayName: a.displayName },
        club: a.clubId ? { id: a.clubId, name: a.clubName } : null,
        season: s ? { id: s.id, number: s.number, phase: s.phase } : null,
      };
    });
  });

  // ── authenticated, club-scoped routes ──────────────────────────────────────

  await root.register(async (authed) => {
    authed.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionId = req.cookies[SESSION_COOKIE];
      if (!sessionId) return reply.code(401).send({ error: 'unauthenticated' });
      const ctx = await store.getSessionContext(pool, sessionId);
      if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
      if (!ctx.clubId) return reply.code(403).send({ error: 'no_club' });
      req.ctx = ctx as SessionCtx;
    });

    const season = async (): Promise<store.SeasonRow> => {
      const s = await store.currentSeason(pool);
      if (!s) throw new Error('no season configured');
      return s;
    };

    // ── TEST-ONLY: force the current matchweek to close + sim NOW ──────────
    // Same code path as the deadline timer: deadline is pulled to now(), then
    // the orchestrator's runWeekClose runs — real sims, real bookkeeping,
    // real tick + reveal + season choreography. No shortcut.
    if (opts.testForceWeekClose) {
      authed.post('/admin/force-week-close', async (req, reply) => {
        const confirm = (req.body as { confirm?: unknown } | null)?.confirm;
        if (confirm !== 'SIM NOW') {
          return reply.code(400).send({ error: 'confirm_required', hint: 'POST { "confirm": "SIM NOW" }' });
        }
        const s = await season();
        const mw = await store.currentMatchweek(pool, s.id);
        if (!mw || mw.revealedAt) return reply.code(409).send({ error: 'no_open_matchweek' });
        const forced = await store.forceMatchweekDeadline(pool, mw.id);
        if (!forced) return reply.code(409).send({ error: 'no_open_matchweek' });
        const status = await orchestrator.runWeekClose(mw.id);
        return { matchweek: mw.number, kind: mw.kind, status };
      });
    }

    authed.get('/squad', async (req) => {
      const s = await season();
      return { players: await store.loadSquadView(pool, req.ctx.clubId, s.id) };
    });

    /** Player-hub detail: contract, own-season stats, growth trajectory. */
    authed.get('/squad/player/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const s = await season();
      const squad = await store.loadSquadView(pool, req.ctx.clubId, s.id);
      if (!squad.some((p) => p.playerId === id)) return reply.code(404).send({ error: 'not_found' });
      return {
        contract: await store.playerContract(pool, id, s.number),
        seasonStats: await store.playerSeasonStats(pool, s.id, req.ctx.clubId, id),
        growth: await store.playerGrowth(pool, id),
      };
    });

    /** Read-back for the tactics editor (PUT half existed since client v0). */
    authed.get('/default-tactics', async (req, reply) => {
      const payload = await store.getDefaultTactics(pool, req.ctx.clubId);
      if (!payload) return reply.code(404).send({ error: 'not_found' });
      return { payload };
    });

    authed.get('/matchweek/current', async (req, reply) => {
      const s = await season();
      const mw = await store.currentMatchweek(pool, s.id);
      if (!mw) return reply.code(404).send({ error: 'no_matchweek' });

      let fixture = null;
      const fx = await store.fixtureForClub(pool, mw.id, req.ctx.clubId);
      if (fx) {
        const names = await store.clubNames(pool, [fx.homeClubId, fx.awayClubId]);
        const flags = await store.submissionFlags(pool, fx.id);
        const opponentId = fx.homeClubId === req.ctx.clubId ? fx.awayClubId : fx.homeClubId;
        const none = { half1: false, half2: false };
        fixture = {
          id: fx.id,
          state: fx.state,
          htDeadline: fx.htDeadline,
          home: { clubId: fx.homeClubId, name: names.get(fx.homeClubId) },
          away: { clubId: fx.awayClubId, name: names.get(fx.awayClubId) },
          submissions: {
            you: flags.get(req.ctx.clubId) ?? none,
            opponent: flags.get(opponentId) ?? none, // booleans only — payloads never leave the store query
          },
        };
      }
      return {
        matchweek: { id: mw.id, number: mw.number, kind: mw.kind, opensAt: mw.opensAt, deadlineAt: mw.deadlineAt, revealedAt: mw.revealedAt },
        fixture,
      };
    });

    authed.put('/fixture/:id/tactics/:half', async (req, reply) => {
      const { id, half: halfRaw } = req.params as { id: string; half: string };
      if (halfRaw !== '1' && halfRaw !== '2') return reply.code(404).send({ error: 'not_found' });
      const half = Number(halfRaw) as 1 | 2;

      const fx = await store.getFixture(pool, id).catch(() => null); // malformed uuid → not found
      if (!fx || (fx.homeClubId !== req.ctx.clubId && fx.awayClubId !== req.ctx.clubId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (half === 1 && fx.state !== 'scheduled') {
        return reply.code(409).send({ error: 'invalid_state', state: fx.state });
      }
      if (half === 2) {
        if (fx.state !== 'awaiting_ht') return reply.code(409).send({ error: 'invalid_state', state: fx.state });
        const now = await store.dbNow(pool);
        if (fx.htDeadline && now >= fx.htDeadline) return reply.code(409).send({ error: 'ht_window_closed' });
      }

      const body = req.body as Tactics | null;
      if (!body || !Array.isArray(body.players) || !Array.isArray(body.bench) || !body.setPieceTakers) {
        return reply.code(400).send({ error: 'malformed_tactics' });
      }
      const mw = await store.getMatchweek(pool, fx.matchweekId);
      const elig = await store.loadEligibilitySquad(pool, req.ctx.clubId, mw!.seasonId);
      const issues = validateTactics(body, elig); // validate BEFORE insert — nothing invalid is ever stored
      if (issues.length > 0) return reply.code(422).send({ error: 'tactics_rejected', issues });

      if (half === 2) {
        // HT rules: sub cap vs the half-1 XI, no re-entry across resubmissions,
        // sent-off players (half-1 end state) are gone for good
        const h1Own = (await store.getSubmissions(pool, fx.id, 1)).find((s) => s.clubId === req.ctx.clubId);
        const prevH2 = (await store.getSubmissions(pool, fx.id, 2)).find((s) => s.clubId === req.ctx.clubId);
        const h1Result = await store.getHalfResult(pool, fx.id, 1);
        const sentOff = h1Result
          ? Object.entries(h1Result.endState.playerState)
              .filter(([, st]) => st.cards.sentOff)
              .map(([id]) => id)
          : [];
        const htIssues = validateHtResubmission(
          body,
          h1Own ? h1Own.payload.players.map((p) => p.playerId) : [],
          prevH2 ? prevH2.payload.players.map((p) => p.playerId) : null,
          sentOff,
          LEAGUE_CFG.htSubsMax,
        );
        if (htIssues.length > 0) return reply.code(422).send({ error: 'tactics_rejected', issues: htIssues });
      }

      await store.upsertSubmission(pool, fx.id, req.ctx.clubId, half, body);
      await orchestrator.notifyTacticsSubmitted(fx.id, req.ctx.clubId, half);
      return reply.code(204).send();
    });

    /** Player-name lookup for rendering ratings/events — resolved AFTER visibility checks. */
    const namesFor = async (fx: store.FixtureRow): Promise<Record<string, string>> => {
      const mw = await store.getMatchweek(pool, fx.matchweekId);
      const names = await store.playerNames(pool, mw!.seasonId, [fx.homeClubId, fx.awayClubId]);
      return Object.fromEntries(names);
    };

    /** Own submission read-back (HT screen seeds from the half-1 lineup). */
    authed.get('/fixture/:id/tactics/:half', async (req, reply) => {
      const { id, half: halfRaw } = req.params as { id: string; half: string };
      if (halfRaw !== '1' && halfRaw !== '2') return reply.code(404).send({ error: 'not_found' });
      const fx = await store.getFixture(pool, id).catch(() => null);
      if (!fx || (fx.homeClubId !== req.ctx.clubId && fx.awayClubId !== req.ctx.clubId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const subs = await store.getSubmissions(pool, id, Number(halfRaw) as 1 | 2);
      const own = subs.find((s) => s.clubId === req.ctx.clubId); // own club only — opponent payloads stay server-side
      if (!own) return reply.code(404).send({ error: 'not_found' });
      return { half: Number(halfRaw), isDefault: own.isDefault, payload: own.payload };
    });

    authed.get('/fixture/:id/ht', async (req, reply) => {
      const { id } = req.params as { id: string };
      const fx = await store.getFixture(pool, id).catch(() => null);
      if (!fx || (fx.homeClubId !== req.ctx.clubId && fx.awayClubId !== req.ctx.clubId)) {
        return reply.code(404).send({ error: 'not_found' }); // participants only
      }
      if (fx.state !== 'awaiting_ht' && fx.state !== 'final') {
        return reply.code(409).send({ error: 'invalid_state', state: fx.state });
      }
      const h1 = await store.getHalfResult(pool, id, 1);
      if (!h1) return reply.code(409).send({ error: 'invalid_state', state: fx.state });
      // stats + events + score only: endState (rng stream, opponent fatigue) never leaves the server
      return {
        fixtureId: id,
        state: fx.state,
        htDeadline: fx.htDeadline,
        home: fx.homeClubId,
        away: fx.awayClubId,
        score: h1.endState.score,
        stats: h1.stats,
        events: h1.events,
        players: await namesFor(fx),
      };
    });

    authed.get('/fixture/:id/result', async (req, reply) => {
      const { id } = req.params as { id: string };
      // visibility enforced inside the SQL: revealed matchweek, or participant + final
      const halves = await store.embargoedResult(pool, id, req.ctx.clubId).catch(() => []);
      if (halves.length !== 2) return reply.code(404).send({ error: 'not_found' });
      const fx = (await store.getFixture(pool, id))!;
      return {
        fixtureId: id,
        home: fx.homeClubId,
        away: fx.awayClubId,
        finalScore: halves[1].score,
        halves: halves.map((h) => ({ half: h.half, score: h.score, stats: h.stats, events: h.events })),
        players: await namesFor(fx),
      };
    });

    /** Replay frames for the viewer — same embargo as /result (store SQL). */
    authed.get('/fixture/:id/replay', async (req, reply) => {
      const { id } = req.params as { id: string };
      const halves = await store.embargoedReplay(pool, id, req.ctx.clubId).catch(() => []);
      if (halves.length !== 2) return reply.code(404).send({ error: 'not_found' });
      const fx = (await store.getFixture(pool, id))!;
      const sides = await store.fixtureSides(pool, id);
      return {
        fixtureId: id,
        home: fx.homeClubId,
        away: fx.awayClubId,
        homePlayers: sides[fx.homeClubId] ?? [],
        awayPlayers: sides[fx.awayClubId] ?? [],
        halves,
      };
    });

    // ── facilities (training + medical; youth deferred) ───────────────────
    const facilitiesView = async (clubId: string) => {
      const s = await season();
      const row = await store.getFacilities(pool, s.id, clubId);
      if (!row) return null;
      return {
        phase: s.phase,
        investmentOpen: s.phase === 'regular' || s.phase === 'transfer_window',
        // facilities spend the RESERVE (6b): what the split held back plus
        // half of any unspent bring — never the auction pot
        budgetRemaining: row.reserveBalance,
        training: { level: row.trainingLevel, nextCost: facilityUpgradeCost(row.trainingLevel) },
        medical: { level: row.medicalLevel, nextCost: facilityUpgradeCost(row.medicalLevel) },
      };
    };

    authed.get('/facilities', async (req, reply) => {
      const view = await facilitiesView(req.ctx.clubId);
      if (!view) return reply.code(404).send({ error: 'not_found' });
      return view;
    });

    /**
     * Invest one level in a facility, paying from transfer budget — one
     * transaction under the club_seasons row lock. Open during 'regular'
     * and 'transfer_window': facilities are a season-long management lever.
     * Closed during the auction — transfer_budget IS the live bidding
     * balance there and mutating it would race bid validation — and once
     * the season ends.
     */
    authed.post('/facilities/invest', async (req, reply) => {
      const { facility } = (req.body ?? {}) as { facility?: string };
      if (facility !== 'training' && facility !== 'medical') {
        return reply.code(400).send({ error: 'bad_facility' });
      }
      const s = await season();
      if (s.phase !== 'regular' && s.phase !== 'transfer_window') {
        return reply.code(409).send({ error: 'investment_closed', phase: s.phase });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = await store.getFacilities(client, s.id, req.ctx.clubId, true);
        if (!row) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'not_found' });
        }
        const level = facility === 'training' ? row.trainingLevel : row.medicalLevel;
        const cost = facilityUpgradeCost(level);
        if (cost === null) {
          await client.query('ROLLBACK');
          return reply.code(422).send({ error: 'level_cap', level });
        }
        const remaining = row.reserveBalance;
        if (cost > remaining) {
          await client.query('ROLLBACK');
          return reply.code(422).send({ error: 'insufficient_budget', cost, remaining });
        }
        await store.applyFacilityInvestment(client, s.id, req.ctx.clubId, facility, cost);
        await client.query('COMMIT');
        return reply.code(204).send();
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    // ── weekly training dial (league-growth.ts does the math) ──────────────
    authed.get('/training', async (req, reply) => {
      const s = await season();
      const row = await store.getTraining(pool, s.id, req.ctx.clubId);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return { ...row, focuses: TRAINING_FOCUSES };
    });

    /**
     * Set focus + intensity; applies from the next weekly tick. Same phase
     * rule as facilities: a season-long management lever — open during
     * regular play and the transfer window, closed in the auction and once
     * the season ends.
     */
    authed.put('/training', async (req, reply) => {
      const body = (req.body ?? {}) as { focus?: unknown; intensity?: unknown };
      if (!isTrainingFocus(body.focus)) return reply.code(400).send({ error: 'bad_focus', focuses: TRAINING_FOCUSES });
      const intensity = body.intensity;
      if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
        return reply.code(400).send({ error: 'bad_intensity' });
      }
      const s = await season();
      if (s.phase !== 'regular' && s.phase !== 'transfer_window') {
        return reply.code(409).send({ error: 'training_closed', phase: s.phase });
      }
      const ok = await store.setTraining(pool, s.id, req.ctx.clubId, body.focus, intensity);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    });

    // ── mid-season transfer window (league-transfers.ts) ───────────────────
    const transfers = createTransferCore({ pool });
    const transferReply = (reply: FastifyReply, err: unknown) => {
      if (err instanceof TransferError) return reply.code(err.status).send(err.body);
      throw err;
    };
    // malformed ids 404 up front — a bad uuid must not surface as a pg cast error
    const isUuid = (s: string): boolean =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

    authed.get('/transfer/state', async (req, reply) => {
      try {
        return await transfers.state(req.ctx.clubId);
      } catch (err) {
        return transferReply(reply, err);
      }
    });

    authed.get('/transfer/market', async (req, reply) => {
      try {
        return await transfers.market(req.ctx.clubId);
      } catch (err) {
        return transferReply(reply, err);
      }
    });

    authed.post('/transfer/offer', async (req, reply) => {
      const body = req.body as { playerId?: unknown; fee?: unknown } | null;
      if (typeof body?.playerId !== 'string' || typeof body?.fee !== 'number') {
        return reply.code(400).send({ error: 'offer_required' });
      }
      if (!isUuid(body.playerId)) return reply.code(404).send({ error: 'not_found' });
      try {
        return await transfers.makeOffer(req.ctx.clubId, body.playerId, body.fee);
      } catch (err) {
        return transferReply(reply, err);
      }
    });

    for (const [verb, accept] of [['accept', true], ['reject', false]] as const) {
      authed.post(`/transfer/offer/:id/${verb}`, async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!isUuid(id)) return reply.code(404).send({ error: 'not_found' });
        try {
          await transfers.respondOffer(req.ctx.clubId, id, accept);
          return reply.code(204).send();
        } catch (err) {
          return transferReply(reply, err);
        }
      });
    }

    /** Fixed-price pool signing — first-come (a lost race is 409 not_free). */
    authed.post('/transfer/sign', async (req, reply) => {
      const playerId = (req.body as { playerId?: unknown } | null)?.playerId;
      if (typeof playerId !== 'string') return reply.code(400).send({ error: 'player_required' });
      if (!isUuid(playerId)) return reply.code(404).send({ error: 'not_found' });
      try {
        await transfers.signPoolPlayer(req.ctx.clubId, playerId);
        return reply.code(204).send();
      } catch (err) {
        return transferReply(reply, err);
      }
    });

    authed.get('/standings', async () => {
      const s = await season();
      return { season: { id: s.id, number: s.number }, table: await store.standings(pool, s.id) };
    });

    /** The season's results list — revealed matchweeks only (SQL embargo). */
    authed.get('/results', async () => {
      const s = await season();
      const weeks = await store.revealedResults(pool, s.id);
      const clubIds = [...new Set(weeks.flatMap((w) => w.fixtures.flatMap((f) => [f.home, f.away])))];
      const names = await store.clubNames(pool, clubIds);
      return { matchweeks: weeks, clubNames: Object.fromEntries(names) };
    });

    /** The playoff bracket: seeds, legs (revealed scores only), shootouts, champion. */
    authed.get('/playoffs', async (_req, reply) => {
      const s = await season();
      const ties = await store.listPlayoffTies(pool, s.id);
      if (ties.length === 0) return reply.code(404).send({ error: 'no_playoffs' });
      const clubIds = [...new Set(ties.flatMap((t) => [t.highSeedClubId, t.lowSeedClubId]))];
      const names = await store.clubNames(pool, clubIds);
      const fixtureIds = ties.flatMap((t) => [t.leg1FixtureId, t.leg2FixtureId]).filter((x): x is string => !!x);
      const scores = await store.revealedScores(pool, fixtureIds);
      const players = await store.playerNames(pool, s.id, clubIds);
      return {
        phase: s.phase,
        champion: await store.seasonChampion(pool, s.id),
        clubNames: Object.fromEntries(names),
        playerNames: Object.fromEntries(players),
        ties: ties.map((t) => ({
          round: t.round,
          highSeed: t.highSeed,
          lowSeed: t.lowSeed,
          highSeedClubId: t.highSeedClubId,
          lowSeedClubId: t.lowSeedClubId,
          legs: [t.leg1FixtureId, t.leg2FixtureId]
            .filter((x): x is string => !!x)
            .map((id) => ({ fixtureId: id, score: scores.get(id) ?? null })),
          winnerClubId: t.winnerClubId,
          shootout: t.shootout,
        })),
      };
    });

    // ── season-start auction ───────────────────────────────────────────────
    const auction = orchestrator.auction;
    const auctionReply = (reply: FastifyReply, err: unknown) => {
      if (err instanceof AuctionError) return reply.code(err.status).send(err.body);
      throw err;
    };

    authed.get('/auction/state', async (req, reply) => {
      try {
        return await auction.state(req.ctx.clubId);
      } catch (err) {
        return auctionReply(reply, err);
      }
    });

    authed.get('/auction/pool', async (_req, reply) => {
      try {
        return { players: await auction.poolPlayers() };
      } catch (err) {
        return auctionReply(reply, err);
      }
    });

    /** Pre-auction budget split (6b) — adjustable until the club's first bid. */
    authed.put('/auction/split', async (req, reply) => {
      const reserve = (req.body as { reserve?: unknown } | null)?.reserve;
      if (typeof reserve !== 'number') return reply.code(400).send({ error: 'reserve_required' });
      try {
        await auction.setSplit(req.ctx.clubId, reserve);
        return reply.code(204).send();
      } catch (err) {
        return auctionReply(reply, err);
      }
    });

    authed.post('/auction/nominate', async (req, reply) => {
      const playerId = (req.body as { playerId?: unknown } | null)?.playerId;
      if (typeof playerId !== 'string') return reply.code(400).send({ error: 'player_required' });
      try {
        return await auction.nominate(req.ctx.clubId, playerId);
      } catch (err) {
        return auctionReply(reply, err);
      }
    });

    authed.post('/auction/bid', async (req, reply) => {
      const body = req.body as { lotId?: unknown; amount?: unknown } | null;
      if (typeof body?.lotId !== 'string' || typeof body?.amount !== 'number') {
        return reply.code(400).send({ error: 'bid_required' });
      }
      try {
        return await auction.bid(req.ctx.clubId, body.lotId, body.amount);
      } catch (err) {
        return auctionReply(reply, err); // losing a bid race → 409 { error: 'outbid', highBid }
      }
    });

    /** Winner's contract-duration pick, valid while phase='auction' (DECISIONS.md). */
    authed.put('/auction/contract-duration', async (req, reply) => {
      const body = req.body as { playerId?: unknown; duration?: unknown } | null;
      if (typeof body?.playerId !== 'string' || typeof body?.duration !== 'number') {
        return reply.code(400).send({ error: 'duration_required' });
      }
      try {
        await auction.setDuration(req.ctx.clubId, body.playerId, body.duration);
        return reply.code(204).send();
      } catch (err) {
        return auctionReply(reply, err);
      }
    });

    authed.put('/default-tactics', async (req, reply) => {
      const body = req.body as Tactics | null;
      if (!body || !Array.isArray(body.players) || !Array.isArray(body.bench) || !body.setPieceTakers) {
        return reply.code(400).send({ error: 'malformed_tactics' });
      }
      const s = await season();
      const elig = await store.loadEligibilitySquad(pool, req.ctx.clubId, s.id);
      const issues = validateTactics(body, elig);
      if (issues.length > 0) return reply.code(422).send({ error: 'tactics_rejected', issues });
      await store.upsertDefaultTactics(pool, req.ctx.clubId, body);
      return reply.code(204).send();
    });
  });
  }, { prefix: '/api' });

  return app;
}
