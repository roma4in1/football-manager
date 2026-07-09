/**
 * penalty-shootout.ts — the playoff tiebreaker (pure; engine package).
 *
 * Triggers when a two-leg semifinal is level on aggregate (no away goals, no
 * extra time — straight to kicks) or the neutral final is drawn after 90.
 * It decides the TIE, never the 90-minute scoreline: match stats stay as
 * played, the shootout is a separate record.
 *
 * Kick model REUSES the in-match penalty resolution's base (the engines'
 * flat 0.76 conversion — CAL.penXg / AGENT_CAL.penaltyGoalProb) and adds the
 * shootout's attribute reads per the spec: taker finishing raises the
 * conversion, keeper (gkReflexes+gkPositioning)/2 lowers it, both around the
 * league-average 12, clamped to a sane band. NOT a recalibration — in-match
 * penalties are untouched; these constants live here, gated by the shootout
 * unit tests, not the stat harness (shootouts never occur in harness play).
 *
 * Structure: best-of-5 alternating kicks (home side of the deciding fixture
 * kicks first), early termination when unwinnable, then sudden-death pairs.
 * Takers: the on-pitch XI ordered by finishing (playerId breaks ties for
 * determinism) — the five best, then the rest, cycling in sudden death.
 * Keepers never leave goal, so they kick last in the cycle like anyone else.
 *
 * Determinism: every kick draws from Rng.fromSeed(`${seed}|shootout|<n>`) —
 * keyed off the fixture seed, insertion-safe, replayable.
 */

import { Rng } from './engine-rng.ts';

export const SHOOTOUT = {
  baseGoalProb: 0.76, // = the in-match penalty conversion both engines use
  finishingGain: 0.01, // per finishing point above/below 12
  keeperGain: 0.008, // per gk composite point above/below 12
  minProb: 0.55,
  maxProb: 0.92,
} as const;

export interface ShootoutTaker {
  playerId: string;
  finishing: number;
}

export interface ShootoutKeeper {
  playerId: string;
  gkReflexes: number;
  gkPositioning: number;
}

export interface ShootoutSide {
  clubId: string;
  /** the on-pitch players at full time (server derives; sent-off excluded) */
  takers: ShootoutTaker[];
  keeper: ShootoutKeeper;
}

export interface ShootoutKick {
  n: number; // 1-based kick number in the whole shootout
  side: 'home' | 'away';
  playerId: string;
  scored: boolean;
}

export interface ShootoutResult {
  kicks: ShootoutKick[];
  score: [number, number]; // home, away
  winner: 'home' | 'away';
  suddenDeath: boolean;
}

/** P(kick scores) — exported for the unit tests' monotonicity checks. */
export function kickScoreProb(taker: ShootoutTaker, keeper: ShootoutKeeper): number {
  const gk = (keeper.gkReflexes + keeper.gkPositioning) / 2;
  const p = SHOOTOUT.baseGoalProb + SHOOTOUT.finishingGain * (taker.finishing - 12) - SHOOTOUT.keeperGain * (gk - 12);
  return Math.min(SHOOTOUT.maxProb, Math.max(SHOOTOUT.minProb, p));
}

/** Kick order: five best finishers, then the rest, cycled forever. */
export function kickOrder(takers: ShootoutTaker[]): ShootoutTaker[] {
  return [...takers].sort((a, b) => b.finishing - a.finishing || (a.playerId < b.playerId ? -1 : 1));
}

export function resolveShootout(seed: string, home: ShootoutSide, away: ShootoutSide): ShootoutResult {
  const order: Record<'home' | 'away', ShootoutTaker[]> = { home: kickOrder(home.takers), away: kickOrder(away.takers) };
  const keeperOf: Record<'home' | 'away', ShootoutKeeper> = { home: away.keeper, away: home.keeper }; // faces the OPPONENT keeper
  const taken: Record<'home' | 'away', number> = { home: 0, away: 0 };
  const score: Record<'home' | 'away', number> = { home: 0, away: 0 };
  const kicks: ShootoutKick[] = [];
  let n = 0;

  const kick = (side: 'home' | 'away'): void => {
    const taker = order[side][taken[side] % order[side].length];
    taken[side] += 1;
    n += 1;
    const scored = Rng.fromSeed(`${seed}|shootout|${n}`).float() < kickScoreProb(taker, keeperOf[side]);
    if (scored) score[side] += 1;
    kicks.push({ n, side, playerId: taker.playerId, scored });
  };

  // best-of-5, alternating, stop as soon as the trailing side cannot catch up
  const decided = (): boolean => {
    const left: Record<'home' | 'away', number> = { home: 5 - taken.home, away: 5 - taken.away };
    return score.home > score.away + left.away || score.away > score.home + left.home;
  };
  for (let round = 0; round < 5 && !decided(); round++) {
    kick('home');
    if (decided()) break;
    kick('away');
  }

  // sudden death: full pairs until one side leads after both have kicked
  let suddenDeath = false;
  while (score.home === score.away) {
    suddenDeath = true;
    kick('home');
    kick('away');
  }

  return {
    kicks,
    score: [score.home, score.away],
    winner: score.home > score.away ? 'home' : 'away',
    suddenDeath,
  };
}
