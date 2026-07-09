/**
 * league-api.ts — HTTP API + magic-link auth (Fastify).
 *
 * Framework: Fastify (DECISIONS.md) — `app.inject()` gives supertest-style
 * tests without binding a port; @fastify/cookie handles the session cookie.
 *
 * Auth: no registration — the 8 managers are seeded. POST /auth/request-link
 * mints an HMAC-signed single-use token (15 min TTL) and hands the URL to a
 * LinkDelivery (console stub until the email PR). GET /auth/redeem exchanges
 * it for an httpOnly session cookie. Single-use without a token table: the
 * session id is HMAC(secret, jti), so a second redeem conflicts on the
 * sessions PK (schema.sql).
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
 * (league-server.ts). Redeem 302s to / so the magic link lands in the app.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
import * as store from './league-store.ts';

export const SESSION_COOKIE = 'fm_session';

// ── link delivery (real email is a later PR) ─────────────────────────────────

export interface LinkDelivery {
  sendLoginLink(email: string, url: string): Promise<void>;
}

export const consoleLinkDelivery: LinkDelivery = {
  async sendLoginLink(email, url) {
    console.log(`[auth] login link for ${email}: ${url}`);
  },
};

// ── magic tokens ─────────────────────────────────────────────────────────────

const b64url = (buf: Buffer): string => buf.toString('base64url');
const hmac = (secret: string, data: string): Buffer => createHmac('sha256', secret).update(data).digest();

/** Exported for tests (expiry crafting). Token = payload.signature, both base64url. */
export function mintMagicToken(secret: string, managerId: string, ttlMs: number, now = Date.now()): string {
  const payload = b64url(Buffer.from(JSON.stringify({ m: managerId, e: now + ttlMs, j: randomUUID() })));
  return `${payload}.${b64url(hmac(secret, payload))}`;
}

function verifyMagicToken(secret: string, token: string, now = Date.now()): { managerId: string; jti: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = hmac(secret, payload);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { m?: string; e?: number; j?: string };
    if (typeof parsed.m !== 'string' || typeof parsed.e !== 'number' || typeof parsed.j !== 'string') return null;
    if (now > parsed.e) return null;
    return { managerId: parsed.m, jti: parsed.j };
  } catch {
    return null;
  }
}

/**
 * Session id derived from the link's jti: deterministic (PK collision = link
 * already redeemed) but not computable from the link alone once redeemed.
 */
export function sessionIdFromJti(secret: string, jti: string): string {
  const h = hmac(secret, `session|${jti}`).subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ── request context ──────────────────────────────────────────────────────────

interface SessionCtx extends store.SessionContext {
  clubId: string; // narrowed: club-scoped routes reject managers without a club
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: SessionCtx;
  }
}

// ── app ──────────────────────────────────────────────────────────────────────

export interface ApiOptions {
  pool: pg.Pool;
  orchestrator: Pick<Orchestrator, 'notifyTacticsSubmitted' | 'auction'>;
  sessionSecret: string;
  delivery?: LinkDelivery;
  /** Base for links in emails, e.g. https://league.example — no trailing slash. */
  baseUrl?: string;
}

export async function createApi(opts: ApiOptions): Promise<FastifyInstance> {
  const { pool, orchestrator, sessionSecret } = opts;
  const delivery = opts.delivery ?? consoleLinkDelivery;
  const baseUrl = opts.baseUrl ?? `http://${LEAGUE_CFG.apiHost}:${LEAGUE_CFG.apiPort}`;

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  app.decorateRequest('ctx');

  await app.register(async (root) => {
  // per-process rate limit — single-process deployment for now (league-server.ts)
  const linkRequests = new Map<string, number[]>();
  const rateLimited = (email: string, now = Date.now()): boolean => {
    const windowMs = LEAGUE_CFG.requestLinkWindowMinutes * 60_000;
    const recent = (linkRequests.get(email) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= LEAGUE_CFG.requestLinkMax) {
      linkRequests.set(email, recent);
      return true;
    }
    recent.push(now);
    linkRequests.set(email, recent);
    return false;
  };

  // ── auth (no session required) ─────────────────────────────────────────────

  root.post('/auth/request-link', async (req, reply) => {
    const email = (req.body as { email?: unknown } | null)?.email;
    if (typeof email !== 'string' || email.length === 0) return reply.code(400).send({ error: 'email_required' });
    if (rateLimited(email.toLowerCase())) return reply.code(429).send({ error: 'rate_limited' });

    const managerId = await store.managerIdByEmail(pool, email);
    if (managerId) {
      const token = mintMagicToken(sessionSecret, managerId, LEAGUE_CFG.authTokenTtlMinutes * 60_000);
      await delivery.sendLoginLink(email, `${baseUrl}/api/auth/redeem?token=${encodeURIComponent(token)}`);
    }
    return reply.code(204).send(); // identical response whether or not the email is known
  });

  root.get('/auth/redeem', async (req, reply) => {
    const token = (req.query as { token?: unknown }).token;
    if (typeof token !== 'string') return reply.code(400).send({ error: 'token_required' });
    const verified = verifyMagicToken(sessionSecret, token);
    if (!verified) return reply.code(401).send({ error: 'invalid_or_expired_token' });

    const sessionId = sessionIdFromJti(sessionSecret, verified.jti);
    const expiresAt = new Date(Date.now() + LEAGUE_CFG.sessionTtlDays * 86_400_000);
    const created = await store.createSession(pool, sessionId, verified.managerId, expiresAt);
    if (!created) return reply.code(401).send({ error: 'link_already_used' });

    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
    return reply.redirect('/', 302); // land in the SPA, cookie in hand
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

    authed.get('/me', async (req) => {
      const s = await season();
      return {
        manager: { id: req.ctx.managerId, email: req.ctx.email, displayName: req.ctx.displayName },
        club: { id: req.ctx.clubId, name: req.ctx.clubName },
        season: { id: s.id, number: s.number, phase: s.phase },
      };
    });

    authed.get('/squad', async (req) => {
      const s = await season();
      return { players: await store.loadSquadView(pool, req.ctx.clubId, s.id) };
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
