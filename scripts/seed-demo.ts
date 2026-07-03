/**
 * scripts/seed-demo.ts — reset a database and seed the 2-club demo starting at
 * the SEASON AUCTION (manual smoke path in DECISIONS.md).
 *
 * DESTRUCTIVE: drops schemas `public` and `pgboss` in the target database.
 *
 *   npm run db:test:up
 *   DATABASE_URL=postgres://postgres:fm@localhost:54329/fm_test node scripts/seed-demo.ts
 *
 * Then: SESSION_SECRET=dev DATABASE_URL=... npm run serve
 * Log in as alice@demo.io / bob@demo.io (links print on the server console),
 * run the auction to squadMin per club; completion generates the fixture list
 * and opens matchweek 1.
 */

import pg from 'pg';
import { LEAGUE_CFG } from '../league-config.ts';
import { bootstrapSchema, seedBareClub, seedPoolPlayers, seedSeason } from '../league-test-helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:fm@localhost:54329/fm_test';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
await bootstrapSchema(pool, DATABASE_URL);
const seasonId = await seedSeason(pool, 'auction');

await seedBareClub(pool, seasonId, 'Alpha FC', 'alice@demo.io');
await seedBareClub(pool, seasonId, 'Beta United', 'bob@demo.io');
const poolIds = await seedPoolPlayers(pool, 2 * LEAGUE_CFG.squadMin + 8, 'Demo');

console.log(`demo season seeded on ${DATABASE_URL} — phase: auction`);
console.log(`  season   ${seasonId}`);
console.log(`  clubs    Alpha FC (alice@demo.io), Beta United (bob@demo.io) — no players yet`);
console.log(`  pool     ${poolIds.length} players; each club needs ${LEAGUE_CFG.squadMin} to finish the auction`);
console.log(`  nominate snake starts with the reverse seed order (Beta United first)`);
console.log(`next: SESSION_SECRET=dev DATABASE_URL=${DATABASE_URL} npm run serve`);

await pool.end();
