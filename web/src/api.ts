/**
 * Typed API client. Response shapes mirror league-api.ts; engine types come
 * from the shared modules — no duplication.
 */

import type { Attributes, HalfStats, MatchEvent, ReplayFrame, Tactics } from '@fm/engine/types';
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
  /** null until the account has a club (created in a later accounts-arc phase). */
  club: { id: string; name: string } | null;
  /** null when no season is configured yet. */
  season: { id: string; number: number; phase: string } | null;
}

/** Me narrowed to an account that has a club in a configured season — the shape
 *  every gameplay screen needs (App gates on it before rendering them). */
export type MeWithClub = Me & {
  club: NonNullable<Me['club']>;
  season: NonNullable<Me['season']>;
};

export interface SquadPlayerView {
  playerId: string;
  fullName: string;
  position: string;
  attributes: Attributes;
  fatigue: number;
  sharpness: number;
  injuryWeeksLeft: number;
  suspendedNext: boolean;
  justReturned: boolean;
  seasonMinutes: number;
}

export interface TrainingView {
  focus: string;
  intensity: number;
  trainingLevel: number;
  focuses: string[];
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

export interface FacilityView {
  level: number;
  nextCost: number | null;
}

export interface FacilitiesView {
  phase: string;
  investmentOpen: boolean;
  budgetRemaining: number;
  training: FacilityView;
  medical: FacilityView;
}

export interface ReplayView {
  fixtureId: string;
  home: string;
  away: string;
  homePlayers: string[];
  awayPlayers: string[];
  halves: Array<{ half: number; frames: ReplayFrame[] }>;
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
  /** full attribute blob — bid-time role summary + tap-for-profile */
  attributes: Attributes;
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
  you: {
    remaining: number;
    squadCount: number;
    wageBill: number;
    wageCap: number;
    totalPot: number;
    auctionBudget: number;
    reserve: number;
    splitLocked: boolean;
  };
  signings: Array<{ playerId: string; fullName: string; position: string; wage: number; duration: number; price: number }>;
  squadMin: number;
  squadMax: number;
}

export interface OfferView {
  id: string;
  playerId: string;
  playerName: string;
  buyerClubId: string;
  buyerName: string;
  sellerClubId: string;
  sellerName: string;
  fee: number;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
}

export interface TransferStateView {
  phase: string;
  windowOpen: boolean;
  deadlineAt: string | null;
  you: {
    budgetRemaining: number;
    wageBill: number;
    wageCap: number;
    squadCount: number;
    squadMin: number;
    squadMax: number;
  };
  offers: OfferView[];
}

export interface MarketPlayerView {
  playerId: string;
  fullName: string;
  position: string;
  wage: number;
  marketValue: number;
  injuryWeeksLeft: number;
}

export interface MarketView {
  pool: Array<PoolPlayerView & { wage: number }>;
  clubs: Array<{ clubId: string; name: string; you: boolean; players: MarketPlayerView[] }>;
}

export interface PlayerDetailView {
  contract: { wage: number; duration: number; seasonsRemaining: number } | null;
  seasonStats: { apps: number; goals: number; avgRating: number | null; minutes: number };
  growth: Array<{ seasonNumber: number; before: Record<string, number>; after: Record<string, number> }>;
}

export interface ResultsView {
  matchweeks: Array<{
    number: number;
    kind: 'regular' | 'transfer' | 'playoff';
    fixtures: Array<{ fixtureId: string; home: string; away: string; score: [number, number] }>;
  }>;
  clubNames: Record<string, string>;
}

export interface PlayoffTieView {
  round: 'semi1' | 'semi2' | 'final';
  highSeed: number;
  lowSeed: number;
  highSeedClubId: string;
  lowSeedClubId: string;
  legs: Array<{ fixtureId: string; score: [number, number] | null }>;
  winnerClubId: string | null;
  shootout: {
    kicks: Array<{ n: number; side: 'home' | 'away'; playerId: string; scored: boolean }>;
    score: [number, number];
    winnerClubId: string;
    suddenDeath: boolean;
  } | null;
}

export interface PlayoffsView {
  phase: string;
  champion: string | null;
  clubNames: Record<string, string>;
  playerNames: Record<string, string>;
  ties: PlayoffTieView[];
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  signup: (email: string, password: string) => req<{ ok: true }>('POST', '/api/auth/signup', { email, password }),
  login: (email: string, password: string) => req<{ ok: true }>('POST', '/api/auth/login', { email, password }),
  logout: () => req<void>('POST', '/api/auth/logout'),
  forgotPassword: (email: string) => req<void>('POST', '/api/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) => req<{ ok: true }>('POST', '/api/auth/reset-password', { token, password }),
  squad: () => req<{ players: SquadPlayerView[] }>('GET', '/api/squad'),
  playerDetail: (playerId: string) => req<PlayerDetailView>('GET', `/api/squad/player/${playerId}`),
  defaultTactics: () => req<{ payload: Tactics }>('GET', '/api/default-tactics'),
  matchweekCurrent: () => req<MatchweekView>('GET', '/api/matchweek/current'),
  submitTactics: (fixtureId: string, half: 1 | 2, tactics: Tactics) =>
    req<void>('PUT', `/api/fixture/${fixtureId}/tactics/${half}`, tactics),
  ownTactics: (fixtureId: string, half: 1 | 2) => req<OwnTactics>('GET', `/api/fixture/${fixtureId}/tactics/${half}`),
  ht: (fixtureId: string) => req<HtView>('GET', `/api/fixture/${fixtureId}/ht`),
  result: (fixtureId: string) => req<ResultView>('GET', `/api/fixture/${fixtureId}/result`),
  replay: (fixtureId: string) => req<ReplayView>('GET', `/api/fixture/${fixtureId}/replay`),
  facilities: () => req<FacilitiesView>('GET', '/api/facilities'),
  investFacility: (facility: 'training' | 'medical') => req<void>('POST', '/api/facilities/invest', { facility }),
  training: () => req<TrainingView>('GET', '/api/training'),
  setTraining: (focus: string, intensity: number) => req<void>('PUT', '/api/training', { focus, intensity }),
  transferState: () => req<TransferStateView>('GET', '/api/transfer/state'),
  transferMarket: () => req<MarketView>('GET', '/api/transfer/market'),
  makeOffer: (playerId: string, fee: number) =>
    req<{ offerId: string }>('POST', '/api/transfer/offer', { playerId, fee }),
  acceptOffer: (offerId: string) => req<void>('POST', `/api/transfer/offer/${offerId}/accept`),
  rejectOffer: (offerId: string) => req<void>('POST', `/api/transfer/offer/${offerId}/reject`),
  signPoolPlayer: (playerId: string) => req<void>('POST', '/api/transfer/sign', { playerId }),
  standings: () => req<{ season: { number: number }; table: StandingsRow[] }>('GET', '/api/standings'),
  results: () => req<ResultsView>('GET', '/api/results'),
  playoffs: () => req<PlayoffsView>('GET', '/api/playoffs'),
  saveDefaultTactics: (tactics: Tactics) => req<void>('PUT', '/api/default-tactics', tactics),
  auctionState: () => req<AuctionStateView>('GET', '/api/auction/state'),
  setAuctionSplit: (reserve: number) => req<void>('PUT', '/api/auction/split', { reserve }),
  auctionPool: () => req<{ players: PoolPlayerView[] }>('GET', '/api/auction/pool'),
  nominate: (playerId: string) => req<{ lotId: string; closesAt: string }>('POST', '/api/auction/nominate', { playerId }),
  bid: (lotId: string, amount: number) => req<{ closesAt: string }>('POST', '/api/auction/bid', { lotId, amount }),
  setContractDuration: (playerId: string, duration: number) =>
    req<void>('PUT', '/api/auction/contract-duration', { playerId, duration }),
};
