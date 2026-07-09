/**
 * league-playoffs.test.ts — the top-4 knockout, two ways:
 *
 * STUBBED bracket mechanics (deterministic, crafted scores): two-leg
 * aggregate resolution, level-aggregate → shootout, the neutral final's
 * creation and hosting, drawn final → shootout, 90-minute scorelines
 * untouched by shootouts.
 *
 * FULL 5-club season end to end through production paths (real auction lot,
 * real sims, real week-closes): seeding from the final table, leg hosting,
 * the 5th club left out, rollover firing after the FINAL (not the last
 * regular week), season 2 opening.
 *
 *   npm run db:test:up && node --test league-playoffs.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { HalfResult, HalfStats, MatchEvent } from '@fm/engine/types';
import { createAuctionCore, type AuctionCore } from './league-auction.ts';
import { createCore } from './league-orchestrator.ts';
import { advanceBracket } from './league-playoffs.ts';
import { setupSeason } from './league-setup.ts';
import * as store from './league-store.ts';
import { bootstrapSchema, buildTactics, seedClub, seedPoolPlayers, seedSeason } from './league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

let pool: pg.Pool;
const q = (text: string, params?: unknown[]) => pool.query(text, params);

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});
after(async () => {
  await pool?.end();
});

// ── part 1: stubbed bracket mechanics ────────────────────────────────────────

function stubHalves(score: [number, number], playerIds: string[]): { h1: HalfResult; h2: HalfResult } {
  const playerState = Object.fromEntries(playerIds.map((id) => [
    id,
    { fatigue: 0.4, cards: { yellows: 0 as const, sentOff: false }, injured: false, minutesPlayed: 90 },
  ]));
  const zero: [number, number] = [0, 0];
  const stats: HalfStats = {
    possession: [50, 50], shots: zero, shotsOnTarget: zero, xg: zero, passAccuracy: [80, 80],
    aerialsWon: zero, ppda: [12, 12], fieldTilt: [50, 50], playerRatings: {}, heatmaps: {},
  };
  const mk = (s: [number, number], events: MatchEvent[]): HalfResult => ({
    events, frames: [], stats,
    endState: { v: 2, score: s, playerState, subsUsed: [0, 0], rngState: '0'.repeat(32) },
  });
  return { h1: mk([0, 0], [{ t: 0, type: 'kickoff' }]), h2: mk(score, [{ t: 5400, type: 'halfEnd' }]) };
}

test('stubbed bracket: aggregates, level→shootout, neutral final, drawn final→shootout', async () => {
  await bootstrapSchema(pool, DATABASE_URL);
  const seasonId = await seedSeason(pool); // phase regular; phases irrelevant to advanceBracket
  const clubs: Record<string, { clubId: string; playerIds: string[] }> = {};
  for (const name of ['One', 'Two', 'Three', 'Four'] as const) {
    clubs[name] = await seedClub(pool, seasonId, name, `${name.toLowerCase()}@po.io`);
  }

  // three playoff matchweeks (leg1 / leg2 / final), all past deadline
  const weeks: string[] = [];
  for (let i = 0; i < 3; i++) {
    weeks.push(await store.insertMatchweek(
      pool, seasonId, 100 + i, 'playoff', new Date(Date.now() - 7_200_000), new Date(Date.now() - 60_000),
    ));
  }

  // insert as 'final' directly — state transitions are trigger-guarded
  const insertFinal = async (
    mwId: string, home: string, away: string, homeIds: string[], awayIds: string[],
    score: [number, number], seed: string, neutral = false,
  ): Promise<string> => {
    const fx = await q(
      `INSERT INTO fixtures (matchweek_id, home_club_id, away_club_id, seed, state, neutral_venue)
       VALUES ($1, $2, $3, $4, 'final', $5) RETURNING id`,
      [mwId, home, away, seed, neutral],
    );
    const { h1, h2 } = stubHalves(score, [...homeIds.slice(0, 11), ...awayIds.slice(0, 11)]);
    await store.insertHalfResult(pool, fx.rows[0].id, 1, h1);
    await store.insertHalfResult(pool, fx.rows[0].id, 2, h2);
    // tactics: the shootout derives the on-pitch XI from submissions
    for (const [clubId, ids] of [[home, homeIds], [away, awayIds]] as const) {
      await store.insertSubmission(pool, fx.rows[0].id, clubId, 1, buildTactics(ids), false);
    }
    return fx.rows[0].id as string;
  };

  const [c1, c2, c3, c4] = [clubs.One, clubs.Two, clubs.Three, clubs.Four];
  // semi1 (1v4): leg1 at LOW seed 2–1, leg2 at HIGH seed 2–0 → high 3, low 2 — decided, no shootout
  const s1l1 = await insertFinal(weeks[0], c4.clubId, c1.clubId, c4.playerIds, c1.playerIds, [2, 1], 'po-s1l1');
  const s1l2 = await insertFinal(weeks[1], c1.clubId, c4.clubId, c1.playerIds, c4.playerIds, [2, 0], 'po-s1l2');
  await store.insertPlayoffTie(pool, seasonId, 'semi1', 1, 4, c1.clubId, c4.clubId, s1l1, s1l2);
  // semi2 (2v3): 1–0 then 0–1 → aggregate 1–1 — SHOOTOUT at the leg-2 venue
  const s2l1 = await insertFinal(weeks[0], c3.clubId, c2.clubId, c3.playerIds, c2.playerIds, [1, 0], 'po-s2l1');
  const s2l2 = await insertFinal(weeks[1], c2.clubId, c3.clubId, c2.playerIds, c3.playerIds, [1, 0], 'po-s2l2');
  await store.insertPlayoffTie(pool, seasonId, 'semi2', 2, 3, c2.clubId, c3.clubId, s2l1, s2l2);

  let out = await advanceBracket(pool, seasonId);
  assert.equal(out.champion, null, 'no champion until the final resolves');
  const ties = await store.listPlayoffTies(pool, seasonId);
  const semi1 = ties.find((t) => t.round === 'semi1')!;
  assert.equal(semi1.winnerClubId, c1.clubId, 'aggregate 3–2: the high seed advances');
  assert.equal(semi1.shootout, null, 'decided ties never shoot');
  const semi2 = ties.find((t) => t.round === 'semi2')!;
  assert.ok(semi2.winnerClubId, 'level aggregate resolved');
  const so = semi2.shootout as { kicks: Array<{ side: string; scored: boolean }>; score: [number, number]; winnerClubId: string };
  assert.ok(so && so.kicks.length >= 6, 'shootout recorded with its kicks');
  assert.equal(so.winnerClubId, semi2.winnerClubId, 'the shootout decided the tie');
  // …but NEVER the 90-minute scoreline
  const h2 = await store.getHalfResult(pool, s2l2, 2);
  assert.deepEqual(h2!.endState.score, [1, 0], 'match stats stay as played');

  // the final: created automatically, neutral venue, better-seeded winner listed first
  const finalTie = ties.find((t) => t.round === 'final')!;
  assert.ok(finalTie, 'final created once both semis resolved');
  assert.equal(finalTie.highSeedClubId, c1.clubId, 'seed 1 beat seed 4 → the better seed');
  const finalFx = await store.getFixture(pool, finalTie.leg1FixtureId!);
  assert.equal(finalFx!.neutralVenue, true, 'the final is at a neutral venue');
  assert.equal(finalFx!.matchweekId, weeks[2], 'in the third playoff week');

  // sim the final as a DRAW: shootout crowns the champion. The auto-created
  // fixture is 'scheduled' (trigger-guarded), so replace it with a crafted
  // final one — repoint the tie FIRST, then drop the orphan.
  const homeClub = Object.values(clubs).find((c) => c.clubId === finalFx!.homeClubId)!;
  const awayClub = Object.values(clubs).find((c) => c.clubId === finalFx!.awayClubId)!;
  const craftedFinal = await insertFinal(
    weeks[2], finalFx!.homeClubId, finalFx!.awayClubId, homeClub.playerIds, awayClub.playerIds, [2, 2], 'po-final', true,
  );
  await q(`UPDATE playoff_ties SET leg1_fixture_id = $2 WHERE id = $1`, [finalTie.id, craftedFinal]);
  await q(`DELETE FROM fixtures WHERE id = $1`, [finalTie.leg1FixtureId]);

  out = await advanceBracket(pool, seasonId);
  assert.ok(out.champion, 'drawn final → shootout → champion');
  const resolved = (await store.listPlayoffTies(pool, seasonId)).find((t) => t.round === 'final')!;
  assert.equal(resolved.winnerClubId, out.champion);
  assert.ok(resolved.shootout, 'the final’s shootout recorded');
});

// ── part 2: full 5-club season through production paths ─────────────────────

test('e2e: a 5-club season crowns a champion through the playoffs, then rolls over', async () => {
  await bootstrapSchema(pool, DATABASE_URL);
  await seedPoolPlayers(pool, 90, 'PO');
  const names = ['Ash', 'Birch', 'Cedar', 'Doyle', 'Elm'];
  const setup = await setupSeason(pool, {
    clubs: names.map((n) => ({ name: n, managerEmail: `${n.toLowerCase()}@po5.io` })),
  });
  const seasonId = setup.seasonId;

  // balanced 13-a-side from the pool (1 GK / 4 DF / 5 MF / 3 FW per club)
  const byPos = async (pos: string): Promise<string[]> =>
    (await q(`SELECT id FROM players p WHERE p.position = $1
              AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id AND ct.released_at IS NULL)
              ORDER BY full_name`, [pos])).rows.map((r) => r.id);
  const [gks, dfs, mfs, fws] = [await byPos('GK'), await byPos('DF'), await byPos('MF'), await byPos('FW')];
  const sign = async (clubId: string, playerId: string): Promise<void> => {
    await q(`INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 2)`,
      [playerId, clubId, seasonId]);
    await q(`INSERT INTO squad_players (club_id, season_id, player_id) VALUES ($1, $2, $3)`, [clubId, seasonId, playerId]);
  };
  for (const [i, clubId] of setup.clubIds.entries()) {
    const squad = [gks[i], ...dfs.slice(i * 4, i * 4 + 4), ...mfs.slice(i * 5, i * 5 + 5), ...fws.slice(i * 3, i * 3 + 3)];
    for (const [j, id] of squad.entries()) {
      if (i === 0 && j === squad.length - 1) continue; // club 0 one short — the real lot completes
      await sign(clubId, id);
    }
  }

  const armed: string[] = [];
  const core = createCore({ pool, scheduleWeekClose: async (id) => { armed.push(id); } });
  const auction: AuctionCore = createAuctionCore({
    pool,
    armClose: async () => {},
    scheduleWeekClose: async () => {},
    tuning: { lotSeconds: 0.5, softCloseSeconds: 0.2 },
  });

  // one real lot completes the auction and generates the schedule
  const turn = (await auction.state(setup.clubIds[0])).turn!;
  const freeId = (await q(
    `SELECT id FROM players p WHERE NOT EXISTS
       (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id AND ct.released_at IS NULL) LIMIT 1`,
  )).rows[0].id;
  const { lotId } = await auction.nominate(turn.clubId, freeId);
  await auction.bid(setup.clubIds[0], lotId, 1_000);
  let res: Awaited<ReturnType<typeof auction.closeLot>> = 'skipped';
  for (let i = 0; i < 60 && res === 'skipped'; i++) {
    await new Promise((r) => setTimeout(r, 150));
    res = await auction.closeLot(lotId);
  }
  assert.equal(res, 'completed');

  // play the regular season (incl. the transfer bye) week by week
  const closeAll = async (): Promise<void> => {
    await q(`UPDATE matchweeks SET opens_at = now() - interval '2 hours', deadline_at = now() - interval '1 minute'
             WHERE season_id = $1 AND revealed_at IS NULL`, [seasonId]);
    const weeks = await q(
      `SELECT id FROM matchweeks WHERE season_id = $1 AND revealed_at IS NULL ORDER BY number`, [seasonId],
    );
    for (const w of weeks.rows) assert.equal(await core.runWeekClose(w.id), 'closed');
  };
  await closeAll(); // 10 regular rounds + the bye; the LAST close seeds the playoffs

  // rollover did NOT fire at the last regular week — the playoffs did
  assert.equal((await q(`SELECT phase FROM seasons WHERE id = $1`, [seasonId])).rows[0].phase, 'playoffs');
  assert.equal((await q(`SELECT count(*) FROM seasons`)).rows[0].count, '1', 'no season 2 yet');
  assert.equal(armed.length, 3, 'three playoff matchweeks armed for closing');

  // seeding = the FINAL table's top 4; leg 1 at the low seed, leg 2 at the high seed
  const table = await store.standings(pool, seasonId);
  const ties = await store.listPlayoffTies(pool, seasonId);
  const semi1 = ties.find((t) => t.round === 'semi1')!;
  const semi2 = ties.find((t) => t.round === 'semi2')!;
  assert.equal(semi1.highSeedClubId, table[0].clubId);
  assert.equal(semi1.lowSeedClubId, table[3].clubId);
  assert.equal(semi2.highSeedClubId, table[1].clubId);
  assert.equal(semi2.lowSeedClubId, table[2].clubId);
  for (const tie of [semi1, semi2]) {
    const leg1 = await store.getFixture(pool, tie.leg1FixtureId!);
    const leg2 = await store.getFixture(pool, tie.leg2FixtureId!);
    assert.equal(leg1!.homeClubId, tie.lowSeedClubId, 'low seed hosts leg 1');
    assert.equal(leg2!.homeClubId, tie.highSeedClubId, 'HIGH seed hosts the decisive leg 2');
    assert.equal(leg1!.neutralVenue, false);
  }
  // the 5th club is done for the season: no playoff fixtures
  const fifth = table[4].clubId;
  const fifthGames = await q(
    `SELECT count(*) FROM fixtures f JOIN matchweeks mw ON mw.id = f.matchweek_id
     WHERE mw.season_id = $1 AND mw.kind = 'playoff' AND (f.home_club_id = $2 OR f.away_club_id = $2)`,
    [seasonId, fifth],
  );
  assert.equal(Number(fifthGames.rows[0].count), 0);

  // play the playoffs: leg 1, leg 2 (semis resolve; final created), the final
  await closeAll(); // legs 1+2 and the final week are all that remain

  const done = await store.listPlayoffTies(pool, seasonId);
  for (const tie of done.filter((t) => t.round !== 'final')) {
    assert.ok(tie.winnerClubId, `${tie.round} resolved`);
    assert.ok([tie.highSeedClubId, tie.lowSeedClubId].includes(tie.winnerClubId!));
  }
  const finalTie = done.find((t) => t.round === 'final')!;
  assert.ok(finalTie.winnerClubId, 'the final resolved');
  const finalFx = await store.getFixture(pool, finalTie.leg1FixtureId!);
  assert.equal(finalFx!.neutralVenue, true, 'the final was neutral');

  // champion recorded; rollover fired AFTER the final: complete + season 2 auction
  const season = (await q(`SELECT phase, champion_club_id FROM seasons WHERE id = $1`, [seasonId])).rows[0];
  assert.equal(season.phase, 'complete');
  assert.equal(season.champion_club_id, finalTie.winnerClubId, 'the champion is the final’s winner');
  const s2 = await q(`SELECT phase FROM seasons WHERE number = 2`);
  assert.equal(s2.rows[0]?.phase, 'auction', 'the rollover ran after the final — the game repeats');
});
