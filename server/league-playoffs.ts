/**
 * league-playoffs.ts — the top-4 knockout that crowns the champion.
 *
 * Bracket (DECISIONS.md): semifinals seed 1v4 and 2v3 from the FINAL league
 * table, each a two-leg tie on aggregate — the LOWER seed hosts leg 1 so the
 * HIGHER seed hosts the decisive second leg. The final is a single match at
 * a neutral venue (fixtures.neutral_venue zeroes the home boost in both
 * engines). Level aggregate / drawn final → penalty shootout (no away-goals
 * rule, no extra time): @fm/engine/shootout, keyed off the deciding
 * fixture's seed, deciding the TIE but never the 90-minute scoreline.
 *
 * Scheduling: leg 1, leg 2 and the final are three consecutive playoff-kind
 * matchweeks on the normal weekly cadence — every existing mechanism
 * (deadlines, HT windows, embargo, ticks, suspensions) applies untouched;
 * compression would need new deadline plumbing for zero gain at human-manager
 * scale. Non-qualifiers simply have no fixtures; the between-week tick still
 * recovers/heals everyone (growth stays a season_end thing).
 *
 * Both entry points run inside the week-close tick transaction (revealed_at
 * = the exactly-once marker): seedBracket at the last regular reveal,
 * advanceBracket at every playoff-week reveal. The caller arms week-close
 * timers for the returned matchweeks AFTER the transaction commits.
 */

import { randomUUID } from 'node:crypto';
import { LEAGUE_CFG } from '@fm/engine/config';
import {
  resolveShootout,
  type ShootoutKeeper,
  type ShootoutSide,
  type ShootoutTaker,
} from '@fm/engine/shootout';
import * as store from './league-store.ts';

export interface StoredShootout {
  kicks: Array<{ n: number; side: 'home' | 'away'; playerId: string; scored: boolean }>;
  score: [number, number];
  winnerClubId: string;
  suddenDeath: boolean;
}

/** Seed the bracket from the final table; returns the 3 new matchweek ids. */
export async function seedBracket(c: store.Queryable, seasonId: string): Promise<string[]> {
  const table = await store.standings(c, seasonId);
  if (table.length < 4) throw new Error(`playoffs need 4 clubs, standings has ${table.length}`);
  const seed = (n: number) => table[n - 1]; // 1-based

  const now = await store.dbNow(c);
  const cadenceMs = LEAGUE_CFG.matchweekCadenceDays * 86_400_000;
  const lastNumber = (await c.query(
    `SELECT COALESCE(MAX(number), 0)::int AS n FROM matchweeks WHERE season_id = $1`, [seasonId],
  )).rows[0].n as number;

  const weeks: string[] = [];
  let cursor = now;
  for (let i = 1; i <= 3; i++) {
    const deadline = new Date(cursor.getTime() + cadenceMs);
    weeks.push(await store.insertMatchweek(c, seasonId, lastNumber + i, 'playoff', cursor, deadline));
    cursor = deadline;
  }
  const [leg1Week, leg2Week] = weeks; // weeks[2] awaits the final fixture

  for (const [round, hi, lo] of [['semi1', 1, 4], ['semi2', 2, 3]] as const) {
    // the HIGHER seed hosts the DECISIVE second leg
    const leg1 = await store.insertFixture(c, leg1Week, seed(lo).clubId, seed(hi).clubId, randomUUID());
    const leg2 = await store.insertFixture(c, leg2Week, seed(hi).clubId, seed(lo).clubId, randomUUID());
    await store.insertPlayoffTie(c, seasonId, round, hi, lo, seed(hi).clubId, seed(lo).clubId, leg1, leg2);
  }
  return weeks;
}

/** score of a FINAL fixture from its half-2 end state: [home, away]. */
async function finalScore(c: store.Queryable, fixtureId: string): Promise<[number, number] | null> {
  const fx = await store.getFixture(c, fixtureId);
  if (!fx || fx.state !== 'final') return null;
  const h2 = await store.getHalfResult(c, fixtureId, 2);
  return h2 ? (h2.endState.score as [number, number]) : null;
}

/** The on-pitch XI at full time: half-2 tactics (or carried half-1), minus sent-off. */
async function shootoutSide(
  c: store.Queryable, seasonId: string, fixtureId: string, clubId: string,
): Promise<ShootoutSide> {
  const subs2 = await store.getSubmissions(c, fixtureId, 2);
  const subs1 = await store.getSubmissions(c, fixtureId, 1);
  const payload = (subs2.find((s) => s.clubId === clubId) ?? subs1.find((s) => s.clubId === clubId))?.payload;
  if (!payload) throw new Error(`fixture ${fixtureId}: no tactics for ${clubId} at shootout time`);
  const h2 = await store.getHalfResult(c, fixtureId, 2);
  const sentOff = new Set(
    Object.entries(h2?.endState.playerState ?? {}).filter(([, st]) => st.cards.sentOff).map(([id]) => id),
  );
  const onPitch = payload.players.map((p) => p.playerId).filter((id) => !sentOff.has(id));

  const squad = new Map((await store.loadSquad(c, clubId, seasonId)).map((p) => [p.playerId, p]));
  const positions = new Map((await store.loadEligibilitySquad(c, clubId, seasonId)).map((p) => [p.playerId, p.position]));
  const takers: ShootoutTaker[] = onPitch
    .filter((id) => squad.has(id))
    .map((id) => ({ playerId: id, finishing: squad.get(id)!.attributes.finishing }));
  // keeper: the on-pitch GK; if he was sent off, the best gk-rated outfielder gloves up
  const gkId =
    onPitch.find((id) => positions.get(id) === 'GK') ??
    [...takers].sort((a, b) =>
      squad.get(b.playerId)!.attributes.gkReflexes - squad.get(a.playerId)!.attributes.gkReflexes)[0].playerId;
  const gk = squad.get(gkId)!.attributes;
  const keeper: ShootoutKeeper = { playerId: gkId, gkReflexes: gk.gkReflexes, gkPositioning: gk.gkPositioning };
  return { clubId, takers, keeper };
}

async function runShootout(
  c: store.Queryable, seasonId: string, fixtureId: string,
): Promise<StoredShootout> {
  const fx = (await store.getFixture(c, fixtureId))!;
  const home = await shootoutSide(c, seasonId, fixtureId, fx.homeClubId);
  const away = await shootoutSide(c, seasonId, fixtureId, fx.awayClubId);
  const result = resolveShootout(fx.seed, home, away);
  return {
    kicks: result.kicks,
    score: result.score,
    winnerClubId: result.winner === 'home' ? fx.homeClubId : fx.awayClubId,
    suddenDeath: result.suddenDeath,
  };
}

/**
 * Resolve whatever this playoff week made resolvable: semis on aggregate
 * (shootout if level, at the leg-2 venue), then create the neutral final
 * once both semis have winners, then the final itself (shootout if drawn).
 * Returns the champion when the final resolves.
 */
export async function advanceBracket(
  c: store.Queryable, seasonId: string,
): Promise<{ champion: string | null }> {
  const ties = await store.listPlayoffTies(c, seasonId);

  for (const tie of ties.filter((t) => t.round !== 'final' && !t.winnerClubId)) {
    const leg1 = await finalScore(c, tie.leg1FixtureId!);
    const leg2 = await finalScore(c, tie.leg2FixtureId!);
    if (!leg1 || !leg2) continue; // legs still to play
    // leg 1 hosted by the LOW seed, leg 2 by the HIGH seed
    const aggHigh = leg1[1] + leg2[0];
    const aggLow = leg1[0] + leg2[1];
    if (aggHigh !== aggLow) {
      await store.setTieWinner(c, tie.id, aggHigh > aggLow ? tie.highSeedClubId : tie.lowSeedClubId, null);
    } else {
      const shootout = await runShootout(c, seasonId, tie.leg2FixtureId!);
      await store.setTieWinner(c, tie.id, shootout.winnerClubId, shootout);
    }
  }

  // both semis in, final not yet created → the single neutral-venue match
  const fresh = await store.listPlayoffTies(c, seasonId);
  const semis = fresh.filter((t) => t.round !== 'final');
  if (!fresh.some((t) => t.round === 'final') && semis.length === 2 && semis.every((t) => t.winnerClubId)) {
    const winners = semis.map((t) => ({
      clubId: t.winnerClubId!,
      seed: t.winnerClubId === t.highSeedClubId ? t.highSeed : t.lowSeed,
    })).sort((a, b) => a.seed - b.seed);
    const finalWeek = (await c.query(
      `SELECT id FROM matchweeks WHERE season_id = $1 AND kind = 'playoff' ORDER BY number DESC LIMIT 1`,
      [seasonId],
    )).rows[0].id as string;
    const fixtureId = await store.insertFixture(
      c, finalWeek, winners[0].clubId, winners[1].clubId, randomUUID(), true, // NEUTRAL venue
    );
    await store.insertPlayoffTie(
      c, seasonId, 'final', winners[0].seed, winners[1].seed, winners[0].clubId, winners[1].clubId, fixtureId, null,
    );
  }

  const finalTie = (await store.listPlayoffTies(c, seasonId)).find((t) => t.round === 'final');
  if (finalTie && !finalTie.winnerClubId) {
    const score = await finalScore(c, finalTie.leg1FixtureId!);
    if (score) {
      if (score[0] !== score[1]) {
        const fx = (await store.getFixture(c, finalTie.leg1FixtureId!))!;
        const winner = score[0] > score[1] ? fx.homeClubId : fx.awayClubId;
        await store.setTieWinner(c, finalTie.id, winner, null);
        return { champion: winner };
      }
      const shootout = await runShootout(c, seasonId, finalTie.leg1FixtureId!);
      await store.setTieWinner(c, finalTie.id, shootout.winnerClubId, shootout);
      return { champion: shootout.winnerClubId };
    }
  }
  return { champion: finalTie?.winnerClubId ?? null };
}
