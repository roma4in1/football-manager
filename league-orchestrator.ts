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
 *   - bookkeeping is a single transaction per fixture, guarded by its
 *     wage_payment txn (memo = 'fixture:<id>') as the applied-marker. Wages
 *     must be positive for the marker to exist — asserted.
 *   - lost queue sends after a commit (e.g. the ht_deadline timer) are
 *     backstopped by week-close, which force-completes everything.
 *
 * Failure taxonomy: DB trigger exceptions (SQLSTATE P0001 — illegal state
 * transition, missing half result) and violated invariants (no default_tactics,
 * zero wages) are ASSERTION FAILURES: they indicate a bug, are reported through
 * onAssertion, and are NOT retried. Everything else (connection loss, etc.) is
 * transient and rethrown so pg-boss retries.
 *
 * Deliberately out of scope here: API endpoints, auth, auction, eligibility
 * validation of submitted tactics (suspended/injured starters), and the
 * between-week tick (injury_weeks_left decrement, suspension clear, fatigue
 * recovery) which belongs to the next PR.
 */

import pg from 'pg';
import { PgBoss, type Job, type WorkOptions } from 'pg-boss';
import { AggregateEngine } from './engine-aggregate.ts';
import { Rng } from './engine-rng.ts';
import type { SimEngine, Tactics } from './engine-types.ts';
import * as store from './league-store.ts';

const HT_HOURS_FRESH = 12; // either manager submitted a real half-1 lineup
const HT_HOURS_DEFAULTED = 2; // both defaulted — nobody is waiting on the HT screen
const FAMILIARITY_PER_MATCH = 0.05; // dyadic increment for 90 co-played minutes
const INJURY_WEEKS_MIN = 1;
const INJURY_WEEKS_MAX = 8;

export const QUEUES = {
  simHalf1: 'sim-half-1',
  simHalf2: 'sim-half-2',
  weekClose: 'week-close',
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
 */
export function injuryWeeks(fixtureSeed: string, playerId: string): number {
  const rng = Rng.fromSeed(`${fixtureSeed}|injury|${playerId}`);
  return Math.min(INJURY_WEEKS_MAX, Math.max(INJURY_WEEKS_MIN, Math.round(Math.exp(rng.gauss(0.55, 0.65)))));
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
        assert(
          subs.length === 2,
          `fixture ${fixtureId}: no default_tactics for club(s) ${missing.join(', ')} — cannot sim; void the fixture`,
        );
      }

      const anyFresh = subs.some((s) => !s.isDefault);
      const htDeadline = new Date(now.getTime() + (anyFresh ? HT_HOURS_FRESH : HT_HOURS_DEFAULTED) * 3_600_000);

      const squads = await loadMatchInputs(c, fx!, mw!.seasonId);
      const result = engine.simulateHalf(
        { fixtureId, homeClubId: fx!.homeClubId, awayClubId: fx!.awayClubId, half: 1 },
        squads,
        { home: payloadFor(subs, fx!.homeClubId)!, away: payloadFor(subs, fx!.awayClubId)! },
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

      // carry-forward: absent half=2 row means the half=1 tactics stand
      const subs1 = await store.getSubmissions(c, fixtureId, 1);
      const tactics = clubs.map((id) => payloadFor(subs2, id) ?? payloadFor(subs1, id));
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
      if (await store.bookkeepingDone(c, fixtureId)) return 'skipped:done';

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

      // wages first: these rows are the applied-marker for the whole transaction
      for (const clubId of clubs) {
        const wages = await store.activeWageSum(c, clubId);
        assert(wages > 0, `club ${clubId}: zero wage bill — bookkeeping marker requires positive wages`);
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

      // injuries: deterministic severity so retries agree (marker makes retries moot anyway)
      const injured = new Set(events.filter((e) => e.type === 'injury' && e.playerId).map((e) => e.playerId!));
      for (const playerId of injured) {
        if (!clubOf.has(playerId)) continue;
        await store.applyInjury(c, mw!.seasonId, playerId, injuryWeeks(fx!.seed, playerId));
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
              c, clubId, mw!.seasonId, played[i].id, played[j].id, (FAMILIARITY_PER_MATCH * co) / 90,
            );
          }
        }
      }

      return 'applied';
    });
  }

  /**
   * Force-complete every fixture of the matchweek, apply bookkeeping, reveal.
   * Each step is its own idempotent transaction, so a crashed/retried week-close
   * resumes where it left off; revealed_at is only set once everything is done.
   */
  async function runWeekClose(matchweekId: string): Promise<RunStatus> {
    const mw = await withTxn((c) => store.getMatchweek(c, matchweekId));
    assert(mw, `matchweek ${matchweekId} not found`);
    if (mw!.revealedAt) return 'skipped:revealed';
    const now = await withTxn((c) => store.dbNow(c));
    if (now < mw!.deadlineAt) return 'skipped:early';

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

    await withTxn((c) => store.revealMatchweek(c, matchweekId));
    return 'closed';
  }

  // onAssertion is consumed by the queue layer; expose core untouched
  void onAssertion;
  return { runSimHalf1, runSimHalf2, applyBookkeeping, runWeekClose };
}

// ── queue layer ──────────────────────────────────────────────────────────────

export interface OrchestratorOptions extends CoreOptions {
  connectionString: string;
  /** pg-boss worker poll interval; lower in tests. */
  pollingIntervalSeconds?: number;
}

export interface Orchestrator extends OrchestratorCore {
  boss: PgBoss;
  /** Call when a tactics_submissions row lands; enqueues the sim if both clubs are in. */
  notifyTacticsSubmitted(fixtureId: string, half: 1 | 2): Promise<'enqueued' | 'waiting'>;
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

  return {
    ...core,
    boss,

    async notifyTacticsSubmitted(fixtureId, half) {
      const client = await pool.connect();
      try {
        const fx = await store.getFixture(client, fixtureId);
        if (!fx) throw new AssertionFailure(`fixture ${fixtureId} not found`);
        const subs = await store.getSubmissions(client, fixtureId, half);
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

    async scheduleWeekClose(matchweekId) {
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
    },

    async stop() {
      await boss.stop({ graceful: false });
    },
  };
}
