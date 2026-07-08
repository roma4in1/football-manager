/**
 * league-orchestrator.ts — matchweek orchestration: pg-boss jobs around the
 * SimEngine, plus post-match bookkeeping.
 *
 * Queue topology (pg-boss, lives in the league's Postgres, schema `pgboss`):
 *   sim-half-1  — enqueued by notifyTacticsSubmitted() when both clubs have a
 *                 half=1 row; week-close forces it with defaults after deadline.
 *   sim-half-2  — enqueued when both half=2 rows exist, AND as a timer at
 *                 ht_deadline (distinct singletonKey so early submit isn't
 *                 deduped against the timer). Missing half=2 row = carry the
 *                 half=1 payload forward.
 *   week-close  — timer at matchweek.deadline_at: force-completes every
 *                 fixture, applies bookkeeping, then sets revealed_at.
 *
 * Idempotency contract (all jobs are retry-safe):
 *   - every run* function opens its own transaction, locks the fixture row
 *     (SELECT … FOR UPDATE) and re-checks state before acting; a stale or
 *     duplicate job no-ops with a 'skipped:*' status.
 *   - half_results/replay_frames inserts are ON CONFLICT DO NOTHING (the sim is
 *     deterministic, a retried insert is byte-identical anyway).
 *   - bookkeeping is a single transaction per fixture: it sets
 *     fixtures.bookkept_at as its FIRST write and short-circuits on non-null
 *     (read under the FOR UPDATE lock). Wage txns keep the fixture memo for
 *     traceability but are no longer the marker.
 *   - lost queue sends after a commit (e.g. the ht_deadline timer) are
 *     backstopped by week-close, which force-completes everything.
 *
 * Failure taxonomy: DB trigger exceptions (SQLSTATE P0001 — illegal state
 * transition, missing half result) and violated invariants (no default_tactics,
 * zero wages) are ASSERTION FAILURES: they indicate a bug, are reported through
 * onAssertion, and are NOT retried. Everything else (connection loss, etc.) is
 * transient and rethrown so pg-boss retries.
 *
 * Week close is atomic in this order: force-complete → bookkeep → between-week
 * tick → reveal. The tick (injury decrement, served-suspension clear, fatigue
 * recovery) runs in ONE transaction with revealMatchweek under the matchweek
 * row lock, so revealed_at doubles as the tick's exactly-once marker. Served
 * vs newly-issued suspensions are distinguished via the immutable red-card
 * events of this matchweek's half_results (see DECISIONS.md). Transfer weeks
 * tick (recovery) but do not consume one-match bans.
 *
 * Tactics eligibility (league-eligibility.ts): notifyTacticsSubmitted rejects
 * invalid fresh submissions with TacticsRejectedError and removes the row; the
 * sim path never rejects — stale/invalid/missing defaults fall back to a
 * deterministic best XI seeded by the fixture seed.
 *
 * Deliberately out of scope here: API endpoints, auth, auction, and the
 * facility economy (medical multipliers are wired but placeholder-flat).
 */

import pg from 'pg';
import { PgBoss, type Job, type WorkOptions } from 'pg-boss';
import { AggregateEngine } from '@fm/engine/aggregate';
import { Rng } from '@fm/engine/rng';
import type { SimEngine, Tactics } from '@fm/engine/types';
import { createAuctionCore, type AuctionCore, type AuctionTuning } from './league-auction.ts';
import { LEAGUE_CFG, medicalInjuryAvoidProb, medicalInjuryDurationMul } from '@fm/engine/config';
import { bestXI, validateTactics } from '@fm/engine/eligibility';
import * as store from './league-store.ts';

export const QUEUES = {
  simHalf1: 'sim-half-1',
  simHalf2: 'sim-half-2',
  weekClose: 'week-close',
  auctionClose: 'auction-close',
} as const;

export class AssertionFailure extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AssertionFailure';
    this.cause = cause;
  }
}

/** Our SQL guards raise via RAISE EXCEPTION → SQLSTATE P0001. */
export function isAssertionFailure(err: unknown): boolean {
  if (err instanceof AssertionFailure) return true;
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P0001';
}

export type RunStatus =
  | 'simmed'
  | 'applied'
  | 'closed'
  | 'skipped:state'
  | 'skipped:waiting'
  | 'skipped:done'
  | 'skipped:void'
  | 'skipped:early'
  | 'skipped:revealed';

export interface SimHalfOutcome {
  status: RunStatus;
  htDeadline?: Date;
}

/**
 * Deterministic injury severity in matchweek units, keyed on (fixture seed,
 * player): a retried bookkeeping run draws the same number. Lognormal-ish,
 * median ~2 weeks, clamped 1–8 (calibration-reference.md severity note).
 * The club's medical facility level shortens the draw (placeholder-linear).
 */
export function injuryWeeks(fixtureSeed: string, playerId: string, medicalLevel = 0): number {
  const rng = Rng.fromSeed(`${fixtureSeed}|injury|${playerId}`);
  const raw = Math.exp(rng.gauss(0.55, 0.65)) * medicalInjuryDurationMul(medicalLevel);
  return Math.min(LEAGUE_CFG.injuryWeeksMax, Math.max(LEAGUE_CFG.injuryWeeksMin, Math.round(raw)));
}

// ── core (queue-independent, directly callable from tests and week-close) ────

export interface OrchestratorCore {
  runSimHalf1(fixtureId: string, opts?: { force?: boolean }): Promise<SimHalfOutcome>;
  runSimHalf2(fixtureId: string, opts?: { force?: boolean }): Promise<SimHalfOutcome>;
  applyBookkeeping(fixtureId: string): Promise<RunStatus>;
  runWeekClose(matchweekId: string): Promise<RunStatus>;
}

export interface CoreOptions {
  pool: pg.Pool;
  engine?: SimEngine;
  onAssertion?: (err: Error) => void;
}

export function createCore({ pool, engine = new AggregateEngine(), onAssertion }: CoreOptions): OrchestratorCore {
  const report = onAssertion ?? ((err: Error) => console.error('[league-core] ASSERTION FAILURE:', err));
  async function withTxn<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const assert = (cond: unknown, msg: string): void => {
    if (!cond) throw new AssertionFailure(msg);
  };

  async function loadMatchInputs(c: pg.ClientBase, fx: store.FixtureRow, seasonId: string) {
    const [home, away] = await Promise.all([
      store.loadSquad(c, fx.homeClubId, seasonId),
      store.loadSquad(c, fx.awayClubId, seasonId),
    ]);
    assert(home.length >= 11 && away.length >= 11, `fixture ${fx.id}: squads incomplete (${home.length}/${away.length})`);
    return { home, away };
  }

  const payloadFor = (subs: store.SubmissionRow[], clubId: string): Tactics | undefined =>
    subs.find((s) => s.clubId === clubId)?.payload;

  async function runSimHalf1(fixtureId: string, opts: { force?: boolean } = {}): Promise<SimHalfOutcome> {
    return withTxn(async (c) => {
      const fx = await store.getFixture(c, fixtureId, true);
      assert(fx, `fixture ${fixtureId} not found`);
      if (fx!.state !== 'scheduled') return { status: 'skipped:state' };

      const mw = await store.getMatchweek(c, fx!.matchweekId);
      assert(mw, `matchweek ${fx!.matchweekId} not found`);
      const now = await store.dbNow(c);

      let subs = await store.getSubmissions(c, fixtureId, 1);
      const clubs = [fx!.homeClubId, fx!.awayClubId];
      const missing = clubs.filter((id) => !subs.some((s) => s.clubId === id));
      if (missing.length > 0) {
        const mayDefault = opts.force === true || now >= mw!.deadlineAt;
        if (!mayDefault) return { status: 'skipped:waiting' };
        for (const clubId of missing) await store.insertDefaultSubmission(c, fixtureId, clubId, 1);
        subs = await store.getSubmissions(c, fixtureId, 1);
      }

      // eligibility gate: missing or stale/invalid tactics fall back to a
      // deterministic best XI — the sim path never blocks on a bad lineup
      const resolved = new Map<string, Tactics>();
      for (const clubId of clubs) {
        const sub = subs.find((s) => s.clubId === clubId);
        const elig = await store.loadEligibilitySquad(c, clubId, mw!.seasonId);
        if (!sub) {
          // club has no default_tactics at all — synthesize and persist the auto-lineup
          const xi = bestXI(elig, fx!.seed);
          await store.insertSubmission(c, fixtureId, clubId, 1, xi, true);
          subs.push({ clubId, half: 1, payload: xi, isDefault: true });
          resolved.set(clubId, xi);
        } else if (validateTactics(sub.payload, elig).length > 0) {
          const xi = bestXI(elig, fx!.seed);
          if (sub.isDefault) {
            await store.updateSubmissionPayload(c, fixtureId, clubId, 1, xi); // persist what actually played
          } else {
            // fresh submissions are validated at notify time — reaching here is a bug, but don't block the league
            report(new AssertionFailure(`fixture ${fixtureId}: fresh half-1 tactics for ${clubId} invalid at sim time — best-XI fallback used`));
          }
          resolved.set(clubId, xi);
        } else {
          resolved.set(clubId, sub.payload);
        }
      }

      const anyFresh = subs.some((s) => !s.isDefault);
      const htDeadline = new Date(now.getTime() + (anyFresh ? LEAGUE_CFG.htHoursFresh : LEAGUE_CFG.htHoursDefaulted) * 3_600_000);

      const squads = await loadMatchInputs(c, fx!, mw!.seasonId);
      const result = engine.simulateHalf(
        { fixtureId, homeClubId: fx!.homeClubId, awayClubId: fx!.awayClubId, half: 1 },
        squads,
        { home: resolved.get(fx!.homeClubId)!, away: resolved.get(fx!.awayClubId)! },
        fx!.seed,
      );
      await store.insertHalfResult(c, fixtureId, 1, result);
      await store.transitionFixture(c, fixtureId, 'awaiting_ht', htDeadline);
      return { status: 'simmed', htDeadline };
    });
  }

  async function runSimHalf2(fixtureId: string, opts: { force?: boolean } = {}): Promise<SimHalfOutcome> {
    return withTxn(async (c) => {
      const fx = await store.getFixture(c, fixtureId, true);
      assert(fx, `fixture ${fixtureId} not found`);
      if (fx!.state !== 'awaiting_ht') return { status: 'skipped:state' };

      const mw = await store.getMatchweek(c, fx!.matchweekId);
      const now = await store.dbNow(c);
      const subs2 = await store.getSubmissions(c, fixtureId, 2);
      const clubs = [fx!.homeClubId, fx!.awayClubId];
      const bothIn = clubs.every((id) => subs2.some((s) => s.clubId === id));
      const htPassed = fx!.htDeadline !== null && now >= fx!.htDeadline;
      if (!bothIn && !htPassed && opts.force !== true) return { status: 'skipped:waiting' };

      // carry-forward: absent half=2 row means the half=1 tactics stand. A
      // half-2 row that fails eligibility also carries half 1 (squad state is
      // frozen during the match, so the half-1 lineup is still valid).
      const subs1 = await store.getSubmissions(c, fixtureId, 1);
      const tactics: Array<Tactics | undefined> = [];
      for (const clubId of clubs) {
        const p1 = payloadFor(subs1, clubId);
        const p2 = payloadFor(subs2, clubId);
        let use = p2 ?? p1;
        if (p2 && p1) {
          const elig = await store.loadEligibilitySquad(c, clubId, mw!.seasonId);
          if (validateTactics(p2, elig).length > 0) {
            report(new AssertionFailure(`fixture ${fixtureId}: half-2 tactics for ${clubId} invalid at sim time — carrying half-1 lineup`));
            use = p1;
          }
        }
        tactics.push(use);
      }
      assert(tactics[0] && tactics[1], `fixture ${fixtureId}: half-1 tactics missing in awaiting_ht`);

      const h1 = await store.getHalfResult(c, fixtureId, 1);
      assert(h1, `fixture ${fixtureId}: half-1 result missing in awaiting_ht`);

      const squads = await loadMatchInputs(c, fx!, mw!.seasonId);
      const result = engine.simulateHalf(
        { fixtureId, homeClubId: fx!.homeClubId, awayClubId: fx!.awayClubId, half: 2, resumeState: h1!.endState },
        squads,
        { home: tactics[0]!, away: tactics[1]! },
        fx!.seed,
      );
      await store.insertHalfResult(c, fixtureId, 2, result);
      await store.transitionFixture(c, fixtureId, 'final');
      return { status: 'simmed' };
    });
  }

  async function applyBookkeeping(fixtureId: string): Promise<RunStatus> {
    return withTxn(async (c) => {
      const fx = await store.getFixture(c, fixtureId, true);
      assert(fx, `fixture ${fixtureId} not found`);
      if (fx!.state === 'void') return 'skipped:void';
      assert(fx!.state === 'final', `bookkeeping on non-final fixture ${fixtureId} (${fx!.state})`);
      if (fx!.bookkeptAt !== null) return 'skipped:done';
      await store.markBookkept(c, fixtureId); // marker first; everything below is all-or-nothing with it

      const mw = await store.getMatchweek(c, fx!.matchweekId);
      const [h1, h2] = await Promise.all([
        store.getHalfResult(c, fixtureId, 1),
        store.getHalfResult(c, fixtureId, 2),
      ]);
      assert(h1 && h2, `fixture ${fixtureId}: final without both half results`);
      const endState = h2!.endState;
      const events = [...h1!.events, ...h2!.events];
      const clubs = [fx!.homeClubId, fx!.awayClubId];
      const clubOf = await store.squadClubMap(c, mw!.seasonId, clubs);

      for (const clubId of clubs) {
        const wages = await store.activeWageSum(c, clubId);
        assert(wages > 0, `club ${clubId}: zero wage bill — a contracted squad always pays wages`);
        await store.insertWageTxn(c, mw!.seasonId, clubId, wages, fixtureId);
      }

      // fatigue (absolute), season minutes (delta), just_returned consumed by playing
      const minutesOf = new Map<string, number>();
      for (const [playerId, st] of Object.entries(endState.playerState)) {
        assert(clubOf.has(playerId), `player ${playerId} in end state but not in either squad`);
        const minutes = st.minutesPlayed;
        minutesOf.set(playerId, minutes);
        await store.applyPlayerMatchState(c, mw!.seasonId, playerId, st.fatigue, minutes);
      }

      // injuries: deterministic severity so retries agree (marker makes retries
      // moot anyway); the club's medical level shortens the draw
      const medical = await store.getMedicalLevels(c, mw!.seasonId, clubs);
      const injured = new Set(events.filter((e) => e.type === 'injury' && e.playerId).map((e) => e.playerId!));
      for (const playerId of injured) {
        if (!clubOf.has(playerId)) continue;
        const level = medical.get(clubOf.get(playerId)!) ?? 0;
        // medical staff shrug off a share of knocks entirely — deterministic
        // per (fixture seed, player) so retried bookkeeping agrees
        if (Rng.fromSeed(`${fx!.seed}|injury-avoid|${playerId}`).float() < medicalInjuryAvoidProb(level)) continue;
        await store.applyInjury(c, mw!.seasonId, playerId, injuryWeeks(fx!.seed, playerId, level));
      }

      // one-match ban from red cards
      const reds = new Set(
        events.filter((e) => e.type === 'card' && e.meta?.card === 'red' && e.playerId).map((e) => e.playerId!),
      );
      for (const playerId of reds) {
        if (!clubOf.has(playerId)) continue;
        await store.applySuspension(c, mw!.seasonId, playerId);
      }

      // familiarity: dyadic bump per club for co-played minutes
      for (const clubId of clubs) {
        const played = [...minutesOf.entries()]
          .filter(([id, min]) => min > 0 && clubOf.get(id) === clubId)
          .map(([id, min]) => ({ id, min }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)); // uuid text order == pg uuid order (lowercase hex)
        for (let i = 0; i < played.length; i++) {
          for (let j = i + 1; j < played.length; j++) {
            const co = Math.min(played[i].min, played[j].min);
            await store.bumpFamiliarity(
              c, clubId, mw!.seasonId, played[i].id, played[j].id, (LEAGUE_CFG.familiarityPerMatch * co) / 90,
            );
          }
        }
      }

      return 'applied';
    });
  }

  /**
   * Force-complete every fixture of the matchweek, apply bookkeeping, run the
   * between-week tick, reveal — in that order (the matchweek is atomic).
   * Sim/bookkeeping steps are their own idempotent transactions, so a
   * crashed/retried week-close resumes where it left off. The tick runs in ONE
   * transaction with the reveal under the matchweek row lock: revealed_at is
   * its exactly-once marker (a re-run after reveal never ticks twice).
   */
  async function runWeekClose(matchweekId: string): Promise<RunStatus> {
    const mw = await withTxn((c) => store.getMatchweek(c, matchweekId));
    assert(mw, `matchweek ${matchweekId} not found`);
    if (mw!.revealedAt) return 'skipped:revealed';
    const now = await withTxn((c) => store.dbNow(c));
    if (now < mw!.deadlineAt) return 'skipped:early';

    // transfer weeks have no fixtures — the loop is empty and only the tick runs
    const fixtures = await withTxn((c) => store.listFixtures(c, matchweekId));
    for (const { id } of fixtures) {
      let fx = await withTxn((c) => store.getFixture(c, id));
      if (fx!.state === 'void') continue;
      if (fx!.state === 'scheduled') {
        await runSimHalf1(id, { force: true });
        fx = await withTxn((c) => store.getFixture(c, id));
      }
      if (fx!.state === 'awaiting_ht') {
        await runSimHalf2(id, { force: true });
        fx = await withTxn((c) => store.getFixture(c, id));
      }
      assert(fx!.state === 'final' || fx!.state === 'void', `fixture ${id} not completable (${fx!.state})`);
      if (fx!.state === 'final') await applyBookkeeping(id);
    }

    // between-week tick + reveal, atomically
    await withTxn(async (c) => {
      const locked = await store.getMatchweek(c, matchweekId, true);
      if (locked!.revealedAt) return; // concurrent close won the race — tick already applied

      // injuries heal one week; hitting 0 raises just_returned (consumed by playing)
      await store.decrementInjuries(c, mw!.seasonId);

      // served vs newly-issued suspensions: issued = red cards in THIS week's
      // events (immutable), served = flagged players not in that set. A
      // transfer week is a bye — it does not consume a one-match ban.
      if (locked!.kind !== 'transfer') {
        const issuedThisWeek = await store.redCardedPlayerIds(c, matchweekId);
        await store.clearServedSuspensions(c, mw!.seasonId, issuedThisWeek);
      }

      await store.recoverFatigue(
        c, mw!.seasonId, LEAGUE_CFG.fatigueWeeklyRecovery, LEAGUE_CFG.medicalRecoveryBonusPerLevel,
      );
      await store.revealMatchweek(c, matchweekId);
    });
    return 'closed';
  }

  return { runSimHalf1, runSimHalf2, applyBookkeeping, runWeekClose };
}

// ── queue layer ──────────────────────────────────────────────────────────────

export interface OrchestratorOptions extends CoreOptions {
  connectionString: string;
  /** pg-boss worker poll interval; lower in tests. */
  pollingIntervalSeconds?: number;
  /** Auction timing/bounds overrides (tests shrink the timers). */
  auctionTuning?: AuctionTuning;
}

export interface Orchestrator extends OrchestratorCore {
  boss: PgBoss;
  /** Season-start auction operations (league-auction.ts) — timers ride pg-boss. */
  auction: AuctionCore;
  /**
   * Call after a club's tactics_submissions row lands. Eligibility is the
   * API's job BEFORE the insert (league-api.ts) — this only checks whether
   * both clubs are in and enqueues the sim.
   */
  notifyTacticsSubmitted(fixtureId: string, clubId: string, half: 1 | 2): Promise<'enqueued' | 'waiting'>;
  /** Call when a matchweek is created/opened; arms the week-close timer at deadline_at. */
  scheduleWeekClose(matchweekId: string): Promise<void>;
  stop(): Promise<void>;
}

interface FixtureJob {
  fixtureId: string;
}
interface WeekJob {
  matchweekId: string;
}
interface LotJob {
  lotId: string;
}

export async function createOrchestrator(opts: OrchestratorOptions): Promise<Orchestrator> {
  const { pool, connectionString, pollingIntervalSeconds = 2 } = opts;
  const onAssertion = opts.onAssertion ?? ((err) => console.error('[orchestrator] ASSERTION FAILURE:', err));
  const core = createCore(opts);

  const boss = new PgBoss({ connectionString });
  boss.on('error', (err: Error) => console.error('[pg-boss]', err));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    if (!(await boss.getQueue(name))) {
      // 'short' policy: one queued job per singletonKey — repeated notifies collapse
      await boss.createQueue(name, { policy: 'short', retryLimit: 3, retryDelay: 30, retryBackoff: true });
    }
  }

  /** Assertion failures are bugs: report, complete the job, never retry. */
  const guarded = <T extends object>(fn: (data: T) => Promise<unknown>) =>
    async (jobs: Job<T>[]): Promise<void> => {
      for (const job of jobs) {
        try {
          await fn(job.data);
        } catch (err) {
          if (isAssertionFailure(err)) {
            onAssertion(err as Error);
            continue;
          }
          throw err; // transient → pg-boss retry policy applies
        }
      }
    };

  const armHtTimer = async (fixtureId: string, htDeadline: Date): Promise<void> => {
    // distinct key from the early-submit send; week-close backstops a lost timer
    await boss.sendAfter(
      QUEUES.simHalf2, { fixtureId } satisfies FixtureJob,
      { singletonKey: `h2-timer:${fixtureId}` }, htDeadline,
    );
  };

  const workOpts = { pollingIntervalSeconds } satisfies WorkOptions;

  await boss.work<FixtureJob>(QUEUES.simHalf1, workOpts, guarded<FixtureJob>(async ({ fixtureId }) => {
    const out = await core.runSimHalf1(fixtureId);
    if (out.status === 'simmed') await armHtTimer(fixtureId, out.htDeadline!);
  }));

  await boss.work<FixtureJob>(QUEUES.simHalf2, workOpts, guarded<FixtureJob>(async ({ fixtureId }) => {
    await core.runSimHalf2(fixtureId);
  }));

  await boss.work<WeekJob>(QUEUES.weekClose, workOpts, guarded<WeekJob>(async ({ matchweekId }) => {
    await core.runWeekClose(matchweekId);
  }));

  const scheduleWeekCloseFor = async (matchweekId: string): Promise<void> => {
    const client = await pool.connect();
    try {
      const mw = await store.getMatchweek(client, matchweekId);
      if (!mw) throw new AssertionFailure(`matchweek ${matchweekId} not found`);
      await boss.sendAfter(
        QUEUES.weekClose, { matchweekId } satisfies WeekJob,
        { singletonKey: `wc:${matchweekId}`, retryLimit: 10, retryDelay: 60, retryBackoff: true },
        mw.deadlineAt,
      );
    } finally {
      client.release();
    }
  };

  const auction = createAuctionCore({
    pool,
    tuning: opts.auctionTuning,
    // distinct key per closes_at: an extension arms a second timer, the early
    // one no-ops on the closes_at re-check inside closeLot
    armClose: async (lotId, at) => {
      await boss.sendAfter(
        QUEUES.auctionClose, { lotId } satisfies LotJob,
        { singletonKey: `lot:${lotId}:${at.getTime()}` }, at,
      );
    },
    scheduleWeekClose: scheduleWeekCloseFor,
  });

  await boss.work<LotJob>(QUEUES.auctionClose, workOpts, guarded<LotJob>(async ({ lotId }) => {
    await auction.closeLot(lotId);
  }));

  return {
    ...core,
    boss,
    auction,

    async notifyTacticsSubmitted(fixtureId, clubId, half) {
      const client = await pool.connect();
      try {
        const fx = await store.getFixture(client, fixtureId);
        if (!fx) throw new AssertionFailure(`fixture ${fixtureId} not found`);
        const subs = await store.getSubmissions(client, fixtureId, half);
        if (!subs.some((s) => s.clubId === clubId)) {
          throw new AssertionFailure(`notify for ${clubId} on ${fixtureId} h${half} but no submission row exists`);
        }
        const bothIn = [fx.homeClubId, fx.awayClubId].every((id) => subs.some((s) => s.clubId === id));
        if (!bothIn) return 'waiting';
        if (half === 1 && fx.state === 'scheduled') {
          await boss.send(QUEUES.simHalf1, { fixtureId } satisfies FixtureJob, { singletonKey: `h1:${fixtureId}` });
          return 'enqueued';
        }
        if (half === 2 && fx.state === 'awaiting_ht') {
          await boss.send(QUEUES.simHalf2, { fixtureId } satisfies FixtureJob, { singletonKey: `h2:${fixtureId}` });
          return 'enqueued';
        }
        return 'waiting';
      } finally {
        client.release();
      }
    },

    scheduleWeekClose: scheduleWeekCloseFor,

    async stop() {
      await boss.stop({ graceful: false });
    },
  };
}
