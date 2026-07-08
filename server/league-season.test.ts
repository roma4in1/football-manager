/**
 * league-season.test.ts — variable club count, N ∈ {5..10} (odd N REQUIRED:
 * the bye mechanism is load-bearing).
 *
 * Pure layer: doubleRoundRobin invariants for every supported N; snake
 * rotation; pool-supply guards. DB layer: a full season generates and the
 * auction completes for each N — clubs are pre-contracted to squadMin and
 * completion fires through the same closeLot → maybeComplete path the real
 * flow uses.
 *
 *   npm run db:test:up && node --test league-season.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createAuctionCore, doubleRoundRobin, snakeNominator } from './league-auction.ts';
import { expectedRounds, POSITION_XI_MIN, SetupError, setupSeason, validatePoolSupply } from './league-setup.ts';
import { bootstrapSchema, seedPoolPlayers } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

// ── pure: schedule invariants for every supported N ──────────────────────────

for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  test(`doubleRoundRobin invariants hold for N=${n}`, () => {
    const clubs = Array.from({ length: n }, (_, i) => `c${i}`);
    const rounds = doubleRoundRobin(clubs);

    assert.equal(rounds.length, expectedRounds(n), 'round count: 2(N−1) even, 2N odd');

    const meetings = new Map<string, number>();
    const homeCounts = new Map<string, number>();
    for (const round of rounds) {
      const seen = new Set<string>();
      for (const { home, away } of round) {
        assert.ok(!seen.has(home) && !seen.has(away), `no club twice in a round (N=${n})`);
        seen.add(home);
        seen.add(away);
        meetings.set(`${home}|${away}`, (meetings.get(`${home}|${away}`) ?? 0) + 1);
        homeCounts.set(home, (homeCounts.get(home) ?? 0) + 1);
      }
      if (n % 2 === 1) {
        assert.equal(seen.size, n - 1, `odd N: exactly one bye per round (N=${n})`);
      } else {
        assert.equal(seen.size, n, `even N: everyone plays every round (N=${n})`);
      }
    }

    // every ordered pair exactly once → each pairing twice, venues swapped
    for (const a of clubs) {
      for (const b of clubs) {
        if (a === b) continue;
        assert.equal(meetings.get(`${a}|${b}`) ?? 0, 1, `${a} hosts ${b} exactly once (N=${n})`);
      }
    }

    // byes distributed fairly: every club sits out exactly once per leg
    if (n % 2 === 1) {
      const byesPerLeg = (legRounds: typeof rounds) => {
        const byes = new Map(clubs.map((c) => [c, 0]));
        for (const round of legRounds) {
          const playing = new Set(round.flatMap((p) => [p.home, p.away]));
          for (const c of clubs) if (!playing.has(c)) byes.set(c, byes.get(c)! + 1);
        }
        return byes;
      };
      for (const leg of [rounds.slice(0, n), rounds.slice(n)]) {
        for (const [club, count] of byesPerLeg(leg)) {
          assert.equal(count, 1, `${club} byes exactly once per leg (N=${n})`);
        }
      }
    }

    // home/away balance: legs mirror, so hosting count = N−1 for everyone
    for (const c of clubs) {
      assert.equal(homeCounts.get(c), n - 1, `${c} hosts N−1 matches (N=${n})`);
    }
  });

  test(`snakeNominator covers every club each round of N=${n} lots`, () => {
    const clubs = Array.from({ length: n }, (_, i) => `c${i}`);
    const firstRound = Array.from({ length: n }, (_, lot) => snakeNominator(clubs, lot));
    const secondRound = Array.from({ length: n }, (_, lot) => snakeNominator(clubs, n + lot));
    assert.deepEqual([...firstRound].sort(), [...clubs].sort(), 'round 1 covers all clubs');
    assert.deepEqual(secondRound, [...firstRound].reverse(), 'round 2 reverses (snake)');
  });
}

// ── pure: pool-supply guards ─────────────────────────────────────────────────

test('validatePoolSupply: per-position undersupply is caught, not just total', () => {
  // plenty of players overall, but 10 clubs need ≥ 10 GKs
  const issues = validatePoolSupply({ GK: 9, DF: 120, MF: 120, FW: 60 }, 10, 13, 18);
  assert.ok(issues.some((i) => i.includes('position_undersupplied: GK')), issues.join('; '));
});

test('validatePoolSupply: drainable pool is caught (max hoarding strands the last club)', () => {
  // 10 clubs, squadMax 18: 9 hoarders × 18 + 13 = 175 needed
  const issues = validatePoolSupply({ GK: 30, DF: 60, MF: 50, FW: 30 }, 10, 13, 18); // total 170
  assert.ok(issues.some((i) => i.includes('pool_drainable')), issues.join('; '));
});

test('validatePoolSupply: a healthy pool passes for N=10', () => {
  // ~2,128-player seeded pool shape, scaled down but proportional
  assert.deepEqual(validatePoolSupply({ GK: 160, DF: 760, MF: 640, FW: 560 }, 10, 13, 18), []);
});

// ── DB: full season generates + auction completes for N ∈ {5..10} ────────────

let pool: pg.Pool;

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});
after(async () => {
  await pool?.end();
});

const q = (text: string, params?: unknown[]) => pool.query(text, params);

for (const n of [5, 6, 7, 8, 9, 10]) {
  test(`N=${n}: season sets up, auction completes, schedule is valid (odd byes included)`, async () => {
    await bootstrapSchema(pool, DATABASE_URL);
    // pool sized for the tuned squadMin/squadMax below (min 2 / max 3):
    // drain-safe = (n−1)·3 + 2; positional floors need n×(1,4,4,2) — seed generously
    await seedPoolPlayers(pool, n * 13 + 12, `P${n}`);

    const { seasonId, clubIds, rounds, transferAfterWeek } = await setupSeason(pool, {
      clubs: Array.from({ length: n }, (_, i) => ({ name: `Club ${i}`, managerEmail: `m${i}@n${n}.io` })),
      // guard and auction must agree on squad sizes: tuned tiny (min 2) so
      // completion is one closeLot, not 13n timed lots
      squadMin: 2,
      squadMax: 3,
    });
    assert.equal(rounds, expectedRounds(n));
    assert.ok(transferAfterWeek > 0 && transferAfterWeek < rounds, 'transfer week valid for this N');

    // pre-contract clubs to the tuned squadMin (2), mimicking auction wins —
    // except club 0, one short, so ONE real lot drives completion through the
    // same nominate → bid → timed-close path production uses
    const freeAgents = await q(
      `SELECT id, position FROM players p WHERE NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id) ORDER BY full_name`,
    );
    const gks = freeAgents.rows.filter((r) => r.position === 'GK').map((r) => r.id);
    const outfield = freeAgents.rows.filter((r) => r.position !== 'GK').map((r) => r.id);
    const sign = async (clubId: string, playerId: string) => {
      await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`, [playerId, clubId, seasonId]);
      await q(`INSERT INTO squad_players (club_id, season_id, player_id, fatigue) VALUES ($1, $2, $3, 0.1)`, [clubId, seasonId, playerId]);
    };
    for (let i = 0; i < clubIds.length; i++) {
      await sign(clubIds[i], gks[i]);
      if (i > 0) await sign(clubIds[i], outfield[i]);
    }

    const armed: string[] = [];
    const core = createAuctionCore({
      pool,
      armClose: async () => {},
      scheduleWeekClose: async (id) => {
        armed.push(id);
      },
      tuning: { lotSeconds: 0.5, softCloseSeconds: 0.2, squadMin: 2, squadMax: 3 },
    });

    // the final lot: whoever's turn nominates, the short club wins it
    const turn = (await core.state(clubIds[0])).turn;
    assert.ok(turn, 'auction has a nomination turn');
    const freeId = (await q(
      `SELECT id FROM players p WHERE NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id) LIMIT 1`,
    )).rows[0].id;
    const { lotId } = await core.nominate(turn!.clubId, freeId);
    await core.bid(clubIds[0], lotId, 1_000);
    let res: Awaited<ReturnType<typeof core.closeLot>> = 'skipped';
    for (let i = 0; i < 60 && res === 'skipped'; i++) {
      await new Promise((r) => setTimeout(r, 150));
      res = await core.closeLot(lotId);
    }
    assert.equal(res, 'completed', 'last signing reaches squadMin → completion generates the schedule');

    // schedule shape
    const mws = await q(
      `SELECT id, number, kind FROM matchweeks WHERE season_id = $1 ORDER BY number`,
      [seasonId],
    );
    assert.equal(mws.rowCount, rounds + 1, 'regular rounds + one transfer week');
    assert.equal(mws.rows.filter((r) => r.kind === 'transfer').length, 1);
    assert.equal(mws.rows[transferAfterWeek].kind, 'transfer', 'transfer week sits right after its round');
    assert.equal(armed.length, rounds + 1, 'every matchweek got a week-close timer');

    const fixtures = await q(
      `SELECT f.home_club_id AS home, f.away_club_id AS away, mw.number
       FROM fixtures f JOIN matchweeks mw ON mw.id = f.matchweek_id WHERE mw.season_id = $1`,
      [seasonId],
    );
    assert.equal(fixtures.rowCount, n * (n - 1), 'N(N−1) fixtures: every club N−1 opponents × 2 legs');

    const perClub = new Map<string, number>();
    const perRound = new Map<number, Set<string>>();
    for (const f of fixtures.rows) {
      perClub.set(f.home, (perClub.get(f.home) ?? 0) + 1);
      perClub.set(f.away, (perClub.get(f.away) ?? 0) + 1);
      const seen = perRound.get(f.number) ?? new Set<string>();
      assert.ok(!seen.has(f.home) && !seen.has(f.away), `no club twice in matchweek ${f.number} (N=${n})`);
      seen.add(f.home);
      seen.add(f.away);
      perRound.set(f.number, seen);
    }
    for (const clubId of clubIds) {
      assert.equal(perClub.get(clubId), 2 * (n - 1), 'each club plays 2(N−1) matches');
    }

    const season = await q(`SELECT phase, matchweek_count, transfer_week FROM seasons WHERE id = $1`, [seasonId]);
    assert.equal(season.rows[0].phase, 'regular');
    assert.equal(season.rows[0].matchweek_count, rounds);
    assert.ok(season.rows[0].transfer_week > 0 && season.rows[0].transfer_week < rounds);
  });
}

// ── setup guards fail loudly ─────────────────────────────────────────────────

test('setupSeason rejects an undersupplied pool before writing anything', async () => {
  await bootstrapSchema(pool, DATABASE_URL);
  // 10 clubs at REAL squad sizes against a tiny pool → SetupError, no season row
  await seedPoolPlayers(pool, 30, 'Tiny');
  await assert.rejects(
    setupSeason(pool, {
      clubs: Array.from({ length: 10 }, (_, i) => ({ name: `Club ${i}`, managerEmail: `g${i}@x.io` })),
    }),
    (err: unknown) => {
      assert.ok(err instanceof SetupError);
      assert.ok(err.issues.some((i) => i.includes('pool_drainable')));
      assert.ok(err.issues.some((i) => i.includes('position_undersupplied')));
      return true;
    },
  );
  const seasons = await q(`SELECT count(*) FROM seasons`);
  assert.equal(Number(seasons.rows[0].count), 0, 'guards fire before any insert');
});

test('POSITION_XI_MIN matches the 4-4-2 bestXI demand', () => {
  assert.deepEqual(POSITION_XI_MIN, { GK: 1, DF: 4, MF: 4, FW: 2 });
});
