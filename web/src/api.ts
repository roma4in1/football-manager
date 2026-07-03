/**
 * Typed API client. Response shapes mirror league-api.ts; engine types come
 * from the shared modules — no duplication.
 */

import type { Attributes, HalfStats, MatchEvent, Tactics } from '@fm/engine/types';
import type { EligibilityIssue } from '@fm/engine/eligibility';
import type { FixtureState } from '@fm/engine/state-machine';

export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; issues?: EligibilityIssue[] };
  constructor(status: number, body: ApiError['body']) {
    super(body.error ?? `http ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function req<T>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export interface Me {
  manager: { id: string; email: string; displayName: string };
  club: { id: string; name: string };
  season: { id: string; number: number; phase: string };
}

export interface SquadPlayerView {
  playerId: string;
  fullName: string;
  position: string;
  attributes: Attributes;
  fatigue: number;
  injuryWeeksLeft: number;
  suspendedNext: boolean;
  justReturned: boolean;
  seasonMinutes: number;
}

export interface SubmissionFlags {
  half1: boolean;
  half2: boolean;
}

export interface MatchweekView {
  matchweek: { id: string; number: number; kind: string; opensAt: string; deadlineAt: string; revealedAt: string | null };
  fixture: {
    id: string;
    state: FixtureState;
    htDeadline: string | null;
    home: { clubId: string; name: string };
    away: { clubId: string; name: string };
    submissions: { you: SubmissionFlags; opponent: SubmissionFlags };
  } | null;
}

export interface HtView {
  fixtureId: string;
  state: FixtureState;
  htDeadline: string | null;
  home: string;
  away: string;
  score: [number, number];
  stats: HalfStats;
  events: MatchEvent[];
  players: Record<string, string>;
}

export interface ResultView {
  fixtureId: string;
  home: string;
  away: string;
  finalScore: [number, number];
  halves: Array<{ half: 1 | 2; score: [number, number]; stats: HalfStats; events: MatchEvent[] }>;
  players: Record<string, string>;
}

export interface StandingsRow {
  clubId: string;
  name: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export interface OwnTactics {
  half: 1 | 2;
  isDefault: boolean;
  payload: Tactics;
}

export interface PoolPlayerView {
  playerId: string;
  fullName: string;
  position: string;
  marketValue: number;
}

export interface AuctionStateView {
  phase: string;
  lot: {
    lotId: string;
    player: PoolPlayerView;
    opensAt: string;
    closesAt: string;
    highBid: { clubId: string; clubName: string; amount: number } | null;
  } | null;
  turn: { clubId: string; name: string; you: boolean } | null;
  clubs: Array<{ clubId: string; name: string; remaining: number; squadCount: number; you: boolean }>;
  you: { remaining: number; squadCount: number; wageBill: number; wageCap: number };
  signings: Array<{ playerId: string; fullName: string; position: string; wage: number; duration: number; price: number }>;
  squadMin: number;
  squadMax: number;
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  requestLink: (email: string) => req<void>('POST', '/api/auth/request-link', { email }),
  squad: () => req<{ players: SquadPlayerView[] }>('GET', '/api/squad'),
  matchweekCurrent: () => req<MatchweekView>('GET', '/api/matchweek/current'),
  submitTactics: (fixtureId: string, half: 1 | 2, tactics: Tactics) =>
    req<void>('PUT', `/api/fixture/${fixtureId}/tactics/${half}`, tactics),
  ownTactics: (fixtureId: string, half: 1 | 2) => req<OwnTactics>('GET', `/api/fixture/${fixtureId}/tactics/${half}`),
  ht: (fixtureId: string) => req<HtView>('GET', `/api/fixture/${fixtureId}/ht`),
  result: (fixtureId: string) => req<ResultView>('GET', `/api/fixture/${fixtureId}/result`),
  standings: () => req<{ season: { number: number }; table: StandingsRow[] }>('GET', '/api/standings'),
  saveDefaultTactics: (tactics: Tactics) => req<void>('PUT', '/api/default-tactics', tactics),
  auctionState: () => req<AuctionStateView>('GET', '/api/auction/state'),
  auctionPool: () => req<{ players: PoolPlayerView[] }>('GET', '/api/auction/pool'),
  nominate: (playerId: string) => req<{ lotId: string; closesAt: string }>('POST', '/api/auction/nominate', { playerId }),
  bid: (lotId: string, amount: number) => req<{ closesAt: string }>('POST', '/api/auction/bid', { lotId, amount }),
  setContractDuration: (playerId: string, duration: number) =>
    req<void>('PUT', '/api/auction/contract-duration', { playerId, duration }),
};
