/**
 * league-test-helpers.ts — shared seeding for the DB-backed test suites
 * (league-integration.test.ts, league-api.test.ts). Test-only module.
 *
 * Squads are deterministic and flat-attributed: 13 players per club (11
 * lineup + 2 reserves), realism lives in the stat harness, not here.
 */

import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Attributes, Phase, Tactics, Vec2 } from '@fm/engine/types';
import { SESSION_COOKIE } from './league-api.ts';

/**
 * Get a session cookie for `email` via the real password flow. Sign-up either
 * creates the account (claiming a seeded manager row with the same email, so
 * its club/season stays reachable) or 409s if it already exists — either way we
 * then log in and return the fm_session cookie. Test-only convenience.
 */
export async function apiLogin(app: FastifyInstance, email: string, password = 'password123'): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password } });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error(`apiLogin(${email}) failed: ${res.statusCode} ${res.body}`);
  return cookie.value;
}

export const ATTR_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing', 'tackling', 'marking',
  'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility', 'decisions',
  'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate', 'aggression',
  'gkReflexes', 'gkPositioning', 'gkDistribution',
];

export function flatAttributes(isGk: boolean): Attributes {
  const attrs = {} as Attributes;
  for (const k of ATTR_KEYS) {
    attrs[k] = k.startsWith('gk') ? (isGk ? 16 : 4) : isGk ? 10 : 12;
  }
  return attrs;
}

const FORMATION: Array<{ def: Vec2; att: Vec2 }> = [
  { def: { x: 6, y: 34 }, att: { x: 13, y: 34 } },
  { def: { x: 16, y: 25 }, att: { x: 40, y: 25 } },
  { def: { x: 16, y: 43 }, att: { x: 40, y: 43 } },
  { def: { x: 19, y: 9 }, att: { x: 58, y: 8 } },
  { def: { x: 19, y: 59 }, att: { x: 58, y: 60 } },
  { def: { x: 30, y: 34 }, att: { x: 55, y: 34 } },
  { def: { x: 34, y: 20 }, att: { x: 66, y: 20 } },
  { def: { x: 34, y: 48 }, att: { x: 66, y: 48 } },
  { def: { x: 44, y: 10 }, att: { x: 86, y: 11 } },
  { def: { x: 44, y: 58 }, att: { x: 86, y: 57 } },
  { def: { x: 46, y: 34 }, att: { x: 93, y: 34 } },
];

const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05, buildUp: 0.3, counterPress: 0.55,
  progression: 0.6, counterAttack: 0.85, finalThird: 1.0,
};

/** Lineup = first 11 of the squad ids; reserves stay off the sheet. */
export function buildTactics(squadIds: string[]): Tactics {
  const playerIds = squadIds.slice(0, 11);
  return {
    players: playerIds.map((playerId, i) => {
      const slot = FORMATION[i];
      const anchors = {} as Record<Phase, Vec2>;
      for (const [phase, t] of Object.entries(PHASE_BLEND) as Array<[Phase, number]>) {
        anchors[phase] = { x: slot.def.x + (slot.att.x - slot.def.x) * t, y: slot.def.y + (slot.att.y - slot.def.y) * t };
      }
      return {
        playerId,
        anchors,
        instructions: {
          riskAppetite: 0.5, shootingBias: i === 10 ? 0.7 : 0.4, dribbleBias: 0.4,
          pressingIntensity: 0.5, holdPosition: i === 0 ? 0.95 : 0.5, crossBias: 0.4,
        },
        zones: {},
      };
    }),
    team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
    bench: [],
    setPieceTakers: { corners: playerIds[8], freeKicks: playerIds[5], penalties: playerIds[10] },
  };
}

/** DROPs schemas public + pgboss and re-applies schema.sql. Test databases only. */
export async function bootstrapSchema(pool: pg.Pool, databaseUrl: string): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new Error(`cannot reach test database at ${databaseUrl} — run \`npm run db:test:up\` first`, { cause: err });
  }
  await pool.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public`);
  await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

/** Season 1, 10 matchweeks, transfer week 5, phase walked to the target. */
export async function seedSeason(pool: pg.Pool, phase: 'regular' | 'auction' = 'regular'): Promise<string> {
  const season = await pool.query(
    `INSERT INTO seasons (number, matchweek_count, transfer_week) VALUES (1, 10, 5) RETURNING id`,
  );
  const seasonId = season.rows[0].id as string;
  await pool.query(`UPDATE seasons SET phase = 'auction' WHERE id = $1`, [seasonId]);
  if (phase === 'regular') await pool.query(`UPDATE seasons SET phase = 'regular' WHERE id = $1`, [seasonId]);
  return seasonId;
}

/** Club with a manager and a budget but NO players — auction drafts the squad. */
export async function seedBareClub(
  pool: pg.Pool, seasonId: string, name: string, managerEmail: string,
  budget = 100_000, wageCap = 10_000,
): Promise<{ clubId: string }> {
  const manager = await pool.query(
    `INSERT INTO managers (email, display_name) VALUES ($1, $2) RETURNING id`, [managerEmail, name],
  );
  const club = await pool.query(
    `INSERT INTO clubs (manager_id, name) VALUES ($1, $2) RETURNING id`, [manager.rows[0].id, name],
  );
  await pool.query(
    `INSERT INTO club_seasons (club_id, season_id, transfer_budget, wage_cap) VALUES ($1, $2, $3, $4)`,
    [club.rows[0].id, seasonId, budget, wageCap],
  );
  return { clubId: club.rows[0].id };
}

/** Uncontracted pool players for the auction; positions cycle GK/DF/DF/MF/MF/FW. */
export async function seedPoolPlayers(pool: pg.Pool, count: number, prefix = 'Pool'): Promise<string[]> {
  const positions = ['GK', 'DF', 'DF', 'MF', 'MF', 'FW'];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const position = positions[i % positions.length];
    const p = await pool.query(
      `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, market_value, attributes, physical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [`${prefix} Player ${i}`, '2001-03-01', position, position === 'GK' ? 190 : 180, 78,
        500_000 + i * 50_000,
        JSON.stringify(flatAttributes(position === 'GK')), JSON.stringify({ injuryProneness: 10 })],
    );
    ids.push(p.rows[0].id as string);
  }
  return ids;
}

/** Manager + club + 13 contracted players (wage 100 each) + default tactics. */
export async function seedClub(
  pool: pg.Pool, seasonId: string, name: string, managerEmail: string,
): Promise<{ clubId: string; playerIds: string[] }> {
  const manager = await pool.query(
    `INSERT INTO managers (email, display_name) VALUES ($1, $2) RETURNING id`, [managerEmail, name],
  );
  const club = await pool.query(
    `INSERT INTO clubs (manager_id, name) VALUES ($1, $2) RETURNING id`, [manager.rows[0].id, name],
  );
  const clubId = club.rows[0].id as string;
  // mid-season suites: the whole allotment sits in RESERVE (facilities + the
  // transfer window spend from it since the 6b split — these clubs never
  // ran an auction, so treat everything as banked)
  await pool.query(
    `INSERT INTO club_seasons (club_id, season_id, transfer_budget, wage_cap, reserve_balance)
     VALUES ($1, $2, 100000, 10000, 100000)`,
    [clubId, seasonId],
  );
  const playerIds: string[] = [];
  const positionFor = (i: number): string => (i === 0 ? 'GK' : i === 11 ? 'DF' : i === 12 ? 'FW' : 'MF');
  for (let i = 0; i < 13; i++) {
    const p = await pool.query(
      `INSERT INTO players (full_name, birth_date, position, height_cm, weight_kg, market_value, attributes, physical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [`${name} Player ${i}`, '2000-01-15', positionFor(i), i === 0 ? 190 : 180, 78, 1_000_000,
        JSON.stringify(flatAttributes(i === 0)), JSON.stringify({ injuryProneness: 10 })],
    );
    const playerId = p.rows[0].id as string;
    playerIds.push(playerId);
    await pool.query(
      `INSERT INTO contracts (player_id, club_id, season_signed, wage, duration) VALUES ($1, $2, $3, 100, 1)`,
      [playerId, clubId, seasonId],
    );
    await pool.query(
      `INSERT INTO squad_players (club_id, season_id, player_id, fatigue) VALUES ($1, $2, $3, 0.1)`,
      [clubId, seasonId, playerId],
    );
  }
  await pool.query(
    `INSERT INTO default_tactics (club_id, payload) VALUES ($1, $2)`,
    [clubId, JSON.stringify(buildTactics(playerIds))],
  );
  return { clubId, playerIds };
}

export async function waitFor(pred: () => Promise<boolean>, what: string, timeoutMs = 25_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for: ${what}`);
}
