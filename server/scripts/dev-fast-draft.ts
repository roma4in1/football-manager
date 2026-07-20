/**
 * dev-fast-draft.ts — drive the REAL auction to completion in seconds (dev only).
 *
 * Drafts a balanced, wage-cap-feasible 20-man squad for every club through the
 * production auction core (nominate → bid → closeLot), so completion runs the
 * real path: signings, phase flip to 'regular', schedule dates (honouring
 * MATCHWEEK_CADENCE_MINUTES_TEST when set). Nothing is written outside what a
 * played auction would write.
 *
 * Stop the league server before running (its orchestrator also arms lot
 * closes; two closers race harmlessly but noisily).
 *
 *   DATABASE_URL=... MATCHWEEK_CADENCE_MINUTES_TEST=60 node scripts/dev-fast-draft.ts
 */

import pg from 'pg';
import { LEAGUE_CFG, wageFromMarketValue } from '@fm/engine/config';
import { createAuctionCore } from '../league-auction.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// per-club composition: 4-4-2-able with real depth at every line
const QUOTA: Array<[string, number]> = [['GK', 2], ['DF', 7], ['MF', 7], ['FW', 4]];
const WAGE_TARGET = LEAGUE_CFG.defaultWageCap - 1_000; // leave a sliver under the cap

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const season = (await pool.query(
  `SELECT id, phase FROM seasons ORDER BY created_at DESC LIMIT 1`,
)).rows[0];
if (!season || season.phase !== 'auction') {
  throw new Error(`no season in auction phase (found: ${season?.phase ?? 'none'})`);
}

const clubs = (await pool.query(
  `SELECT c.id, c.name FROM clubs c JOIN club_seasons cs ON cs.club_id = c.id WHERE cs.season_id = $1 ORDER BY c.name`,
  [season.id],
)).rows as Array<{ id: string; name: string }>;

// free agents by position, best first
const byPos = new Map<string, Array<{ id: string; mv: number; name: string }>>();
for (const [pos] of QUOTA) {
  byPos.set(pos, (await pool.query(
    `SELECT p.id, p.full_name, p.market_value FROM players p
     WHERE p.position = $1
       AND NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.player_id = p.id AND ct.released_at IS NULL)
     ORDER BY p.market_value DESC, p.full_name`, [pos],
  )).rows.map((r) => ({ id: r.id, mv: Number(r.market_value), name: r.full_name })));
}

// alternating greedy: for each position slot, clubs pick best-available in
// turn (snake per slot so neither club gets every top player), constrained so
// the remaining slots can always be filled by cheap players under the cap
const wishlists = new Map<string, string[]>(clubs.map((c) => [c.id, []]));
const wageSum = new Map<string, number>(clubs.map((c) => [c.id, 0]));
const slotsLeft = new Map<string, number>(clubs.map((c) => [c.id, QUOTA.reduce((a, [, n]) => a + n, 0)]));
const CHEAP_FLOOR = 600; // a ~5M journeyman's wage — reachable in every position

for (const [pos, n] of QUOTA) {
  const list = byPos.get(pos)!;
  for (let slot = 0; slot < n; slot++) {
    const order = slot % 2 === 0 ? clubs : [...clubs].reverse();
    for (const club of order) {
      const w = wageSum.get(club.id)!;
      const left = slotsLeft.get(club.id)!;
      const budget = WAGE_TARGET - w - CHEAP_FLOOR * (left - 1);
      const i = list.findIndex((p) => wageFromMarketValue(p.mv) <= budget);
      if (i < 0) throw new Error(`no affordable ${pos} for ${club.name} (budget ${budget})`);
      const pick = list.splice(i, 1)[0];
      wishlists.get(club.id)!.push(pick.id);
      wageSum.set(club.id, w + wageFromMarketValue(pick.mv));
      slotsLeft.set(club.id, left - 1);
    }
  }
}
for (const c of clubs) console.log(`${c.name}: 20 picks, wage bill ${wageSum.get(c.id)} / cap ${LEAGUE_CFG.defaultWageCap}`);

const auction = createAuctionCore({
  pool,
  armClose: async () => {},
  scheduleWeekClose: async () => {},
  tuning: { lotSeconds: 0.3, softCloseSeconds: 0.1, bidIncrementMin: 1 },
});

const cursors = new Map<string, number>(clubs.map((c) => [c.id, 0]));
let lots = 0;
let done = false;
while (!done) {
  const st = await auction.state(clubs[0].id);
  if (!st.turn) throw new Error('no nomination turn while auction incomplete');
  const turnId = st.turn.clubId;
  const cur = cursors.get(turnId)!;
  const list = wishlists.get(turnId)!;
  // a club that is already full keeps its nomination turn: nominate FOR the
  // other club's wishlist (the bidder decides who signs, not the nominator)
  const [player, bidder] = cur < list.length
    ? [list[cur], turnId]
    : (() => {
        const other = clubs.find((c) => c.id !== turnId)!;
        return [wishlists.get(other.id)![cursors.get(other.id)!], other.id] as const;
      })();
  cursors.set(bidder, cursors.get(bidder)! + 1);

  const { lotId } = await auction.nominate(turnId, player);
  await auction.bid(bidder, lotId, 1_000_000);
  let res: Awaited<ReturnType<typeof auction.closeLot>> = 'skipped';
  while (res === 'skipped') { await sleep(120); res = await auction.closeLot(lotId); }
  lots++;
  if (res === 'completed') done = true;
  else if (res !== 'won') throw new Error(`lot ${lots} unexpectedly ${res}`);
}

const after = (await pool.query(`SELECT phase FROM seasons WHERE id = $1`, [season.id])).rows[0];
const counts = (await pool.query(
  `SELECT c.name, count(*) FROM squad_players sp JOIN clubs c ON c.id = sp.club_id
   WHERE sp.season_id = $1 GROUP BY c.name ORDER BY c.name`, [season.id],
)).rows;
const weeks = (await pool.query(
  `SELECT number, deadline_at FROM matchweeks WHERE season_id = $1 ORDER BY number`, [season.id],
)).rows;
console.log(`auction complete after ${lots} lots — phase: ${after.phase}`);
for (const r of counts) console.log(`  ${r.name}: ${r.count} players`);
for (const w of weeks) console.log(`  week ${w.number} deadline ${w.deadline_at}`);
await pool.end();
