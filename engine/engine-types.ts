/**
 * engine/types.ts — frozen core interfaces, phase 1
 *
 * Invariants:
 *  - simulate() is pure: no I/O, no Date.now(), no Math.random(). All randomness via seeded RNG.
 *  - Instructions bias option SCORING only; execution noise is attribute-driven only.
 *  - Same (fixture, squads, tactics, seed) → byte-identical ReplayLog.
 */

// ── Attributes ────────────────────────────────────────────────────────────
// ~25 attributes, 1–20 scale. Comment = which engine model consumes it.
// Derivation source noted where non-obvious.

export interface Attributes {
  // Technical
  passing: number;        // execution noise on ground/driven passes
  longPassing: number;    // lofted/high NON-CROSS deliveries: switches, over-the-top balls
                          // (crossing keeps wide deliveries into the box)
  vision: number;         // option-set size + scoring of line-breaking passes
  firstTouch: number;     // receive noise; touch quality under pressure
  dribbling: number;      // carry execution noise
  finishing: number;      // shot execution noise (foot)
  heading: number;        // aerial duel + headed-shot execution
  crossing: number;       // execution noise on lofted/high deliveries
  tackling: number;       // challenge success in ground duels
  marking: number;        // defensive positioning tightness in duel/track models
  setPieceDelivery: number; // set-piece mini-sim delivery quality

  // Physical (derive: height/weight from DB, pace/stamina from event data + age prior)
  pace: number;           // arrival-time model (pitch control), foot races
  acceleration: number;   // arrival time over short distances; press burst
  stamina: number;        // fatigue accumulation rate
  strength: number;       // ground duel shielding, aerial duel weight
  jumping: number;        // aerial duel reach (blend with height, factual prior)
  agility: number;        // turn cost in arrival-time model; GK reflex component

  // Mental
  decisions: number;      // softmax temperature on option scoring (lower noise)
  composure: number;      // pressure penalty attenuation on execution
  positioning: number;    // defensive anchor-tracking error
  offTheBall: number;     // run generator: candidate quality + timing noise
  anticipation: number;   // interception trigger radius; duel positioning advantage
  workRate: number;       // willingness to act outside operating zone; press chase distance
  aggression: number;     // challenge frequency; foul probability

  // GK-only (null-effective for outfield; keep flat, not a subtype)
  gkReflexes: number;
  gkPositioning: number;
  gkDistribution: number;
}

export interface PlayerPhysical {
  heightCm: number;       // factual; strongest aerial prior
  weightKg: number;
  preferredFoot: 'L' | 'R' | 'B';
  injuryProneness: number; // 1–20; derived from injury history + age (verify scrape tolerance)
}

// ── Ball & phases ─────────────────────────────────────────────────────────

export type BallFlight = 'ground' | 'driven' | 'lofted' | 'high';

export type Phase =
  | 'buildUp'        // own third, controlled possession
  | 'progression'    // middle third possession
  | 'finalThird'     // attacking third possession
  | 'defensiveBlock' // opponent settled possession
  | 'counterPress'   // ≤ T seconds after losing ball (T tunable, ~6s)
  | 'counterAttack'; // ≤ T seconds after winning ball, opponent unset

// ── Tactics (per club, per fixture, re-enterable at HT) ───────────────────

export interface Vec2 { x: number; y: number } // pitch coords: 105×68m, origin own-goal-line/left-touchline

export type ZoneType = 'runTarget' | 'operating' | 'pressing';

export interface InstructionZone {
  zoneType: ZoneType;
  polygon: Vec2[];        // convex, ≤8 vertices (UI enforces; engine assumes)
  weight: number;         // 0–1 bias strength
}

export interface PlayerInstructions {
  riskAppetite: number;      // 0–1 → pass-option softmax temperature shift
  shootingBias: number;      // 0–1 → shot/pass threshold, final third
  dribbleBias: number;       // 0–1 → carry vs release
  pressingIntensity: number; // 0–1 → trigger sensitivity + chase distance
  holdPosition: number;      // 0–1 → anchor stiffness vs run frequency
  crossBias: number;         // 0–1 → cross vs cutback from wide final-third zones
}

export interface PlayerTactic {
  playerId: string;
  anchors: Record<Phase, Vec2>;      // UI ships 2 anchors (in/out poss) in v1 and expands
                                     // to 6 phase anchors via interpolation defaults;
                                     // engine contract is per-phase from day one.
  instructions: PlayerInstructions;
  zones: Partial<Record<Phase, InstructionZone[]>>; // per-phase zone sets; omitted phase = no zones
}

export interface TeamInstructions {
  lineHeight: number;        // 0–1, defensive anchor Y-offset
  width: number;             // 0–1, lateral anchor spread
  compactness: number;       // 0–1, inter-line distance
  pressTrigger: number;      // 0–1, global trigger sensitivity (per-player intensity stacks)
  counterPressDuration: number; // seconds in counterPress phase before dropping
  tempo: number;             // 0–1, decision tick urgency / hold-ball tolerance
}

export interface Tactics {
  players: PlayerTactic[];   // exactly 11 starting
  team: TeamInstructions;
  bench: string[];           // playerIds, ≤9
  setPieceTakers: { corners: string; freeKicks: string; penalties: string };
}

// ── Match inputs ──────────────────────────────────────────────────────────

export interface SquadPlayer {
  playerId: string;
  attributes: Attributes;
  physical: PlayerPhysical;
  fatigue: number;           // 0–1 carried in from league layer (matchweek units)
  /** match sharpness 0–1 (condition/sharpness split); absent = 1 (match-sharp) so pre-split blobs degrade gracefully */
  sharpness?: number;
  familiarity: Record<string, number>; // playerId → 0–1 dyadic link (own squad only)
}

export interface Fixture {
  fixtureId: string;
  homeClubId: string;
  awayClubId: string;
  half: 1 | 2;               // engine always sims one half per invocation
  resumeState?: HalfTimeState; // required iff half === 2
}

export interface HalfTimeState {
  v: 2;                      // state-blob version; engines throw on anything else (no v1 blobs exist)
  score: [number, number];
  playerState: Record<string, {
    fatigue: number;
    cards: { yellows: 0 | 1; sentOff: boolean }; // sentOff = straight red or second yellow
    injured: boolean;
    minutesPlayed: number;
  }>;
  subsUsed: [number, number];
  rngState: string;          // serialized RNG so 2nd half continues the same stream
}

// ── Outputs ───────────────────────────────────────────────────────────────

export type MatchEventType =
  | 'pass' | 'carry' | 'shot' | 'goal' | 'interception' | 'tackle'
  | 'aerialDuel' | 'foul' | 'card' | 'injury' | 'save' | 'clearance'
  | 'cornerAwarded' | 'setPiece' | 'sub' | 'phaseChange' | 'kickoff' | 'halfEnd' | 'offside';

export interface MatchEvent {
  t: number;                 // sim seconds
  type: MatchEventType;
  playerId?: string;
  targetPlayerId?: string;
  from?: Vec2;
  to?: Vec2;
  flight?: BallFlight;
  outcome?: 'success' | 'fail' | 'contested';
  meta?: Record<string, number | string>; // xG on shots, duel margins, etc.
}

export interface ReplayFrame {
  t: number;
  ball: Vec2 & { flight: BallFlight };
  players: Record<string, Vec2>; // sampled at render rate (~4 Hz), not sim rate
}

export interface HalfStats {
  possession: [number, number];
  shots: [number, number];
  shotsOnTarget: [number, number];
  xg: [number, number];
  passAccuracy: [number, number];
  aerialsWon: [number, number];
  ppda: [number, number];
  fieldTilt: [number, number];
  playerRatings: Record<string, number>;
  heatmaps: Record<string, number[]>; // flattened coarse grid, harness decodes
}

export interface HalfResult {
  events: MatchEvent[];
  frames: ReplayFrame[];
  stats: HalfStats;
  endState: HalfTimeState;   // after H1: feeds HT screen + resume; after H2: final bookkeeping
}

// ── Engine entrypoint ─────────────────────────────────────────────────────

export interface SimEngine {
  simulateHalf(
    fixture: Fixture,
    squads: { home: SquadPlayer[]; away: SquadPlayer[] },
    tactics: { home: Tactics; away: Tactics },
    seed: string,
  ): HalfResult;
}

// Two implementations behind this interface:
//   AggregateEngine  — Poisson/aggregate fallback, ships first (M3 playable league)
//   AgentEngine      — pitch-control agent sim (M1/M2 target, mid-season upgrade)
// The aggregate engine fabricates coarse frames/events sufficient for the result
// card and stats; replay viewer degrades gracefully.
