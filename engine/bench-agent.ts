/**
 * bench-agent.ts — sim-cost measurement for the AgentEngine (the engine-switch
 * gate: DECISIONS 2026-08-28). Synthetic 11v11 squads — engine cost depends on
 * player count and tick count, not attribute values — full halves with resume,
 * wall time + memory + frame-payload size.
 *
 *   node bench-agent.ts [nMatches]         (default 10)
 *
 * Run it on the PRODUCTION machine profile before trusting the numbers: local
 * dev hardware flatters the sim (fly ssh console → node /tmp/bench-agent.ts
 * with the import path pointed at /app/engine).
 */

import { AgentEngine } from './agent-engine.ts';
import type { Attributes, PlayerTactic, SquadPlayer, Tactics, Vec2, Phase } from './engine-types.ts';

const N = Number(process.argv[2] ?? 10);

const ATTR_KEYS: Array<keyof Attributes> = [
  'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
  'tackling', 'marking', 'setPieceDelivery', 'pace', 'acceleration', 'stamina', 'strength', 'jumping',
  'agility', 'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
  'aggression', 'gkReflexes', 'gkPositioning', 'gkDistribution',
];
const flat = (v: number): Attributes =>
  Object.fromEntries(ATTR_KEYS.map((k) => [k, v])) as unknown as Attributes;

const SLOTS: Vec2[] = [
  { x: 6, y: 34 },
  { x: 25, y: 10 }, { x: 22, y: 25 }, { x: 22, y: 43 }, { x: 25, y: 58 },
  { x: 45, y: 12 }, { x: 42, y: 27 }, { x: 42, y: 41 }, { x: 45, y: 56 },
  { x: 62, y: 26 }, { x: 62, y: 42 },
];
const PHASES: Phase[] = ['buildUp', 'progression', 'finalThird', 'defensiveBlock', 'counterPress', 'counterAttack'];

function side(name: string): { squad: SquadPlayer[]; tactics: Tactics } {
  const squad: SquadPlayer[] = [];
  const players: PlayerTactic[] = [];
  for (let i = 0; i < 11; i++) {
    const id = `${name}${i}`;
    squad.push({
      playerId: id,
      attributes: flat(12),
      physical: { heightCm: 183, weightKg: 78, preferredFoot: 'R', injuryProneness: 10 },
      fatigue: 0.1,
      familiarity: {},
    } as SquadPlayer);
    const anchors = {} as Record<Phase, Vec2>;
    for (const ph of PHASES) anchors[ph] = { ...SLOTS[i] };
    players.push({
      playerId: id,
      anchors,
      instructions: { riskAppetite: 0.5, shootingBias: 0.5, dribbleBias: 0.5, pressingIntensity: 0.5, holdPosition: 0.5, crossBias: 0.5 },
      zones: {},
    });
  }
  return {
    squad,
    tactics: {
      players,
      team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
      bench: [],
      setPieceTakers: { corners: `${name}8`, freeKicks: `${name}5`, penalties: `${name}9` },
    },
  };
}

const engine = new AgentEngine();
const home = side('H');
const away = side('A');
const squads = { home: home.squad, away: away.squad };
const tactics = { home: home.tactics, away: away.tactics };

// warm-up (JIT) — excluded from stats
engine.simulateHalf({ fixtureId: 'warm', homeClubId: 'H', awayClubId: 'A', half: 1 }, squads, tactics, 'warm');

const halfMs: number[] = [];
let frameBytes = 0;
for (let i = 0; i < N; i++) {
  const t1 = performance.now();
  const h1 = engine.simulateHalf({ fixtureId: `b${i}`, homeClubId: 'H', awayClubId: 'A', half: 1 }, squads, tactics, `b${i}`);
  const t2 = performance.now();
  const h2 = engine.simulateHalf(
    { fixtureId: `b${i}`, homeClubId: 'H', awayClubId: 'A', half: 2, resumeState: h1.endState },
    squads, tactics, `b${i}`,
  );
  const t3 = performance.now();
  halfMs.push(t2 - t1, t3 - t2);
  if (i === 0) frameBytes = JSON.stringify(h1.frames).length + JSON.stringify(h2.frames).length;
}

halfMs.sort((a, b) => a - b);
const mean = halfMs.reduce((a, b) => a + b, 0) / halfMs.length;
const p95 = halfMs[Math.floor(halfMs.length * 0.95)];
const mem = process.memoryUsage();

console.log(`bench-agent: ${N} matches (${halfMs.length} halves), 11v11, 5400 ticks/half`);
console.log(`  half wall time  mean ${mean.toFixed(0)} ms · p95 ${p95.toFixed(0)} ms · max ${halfMs[halfMs.length - 1].toFixed(0)} ms`);
console.log(`  match (2 halves) ~${(mean * 2 / 1000).toFixed(1)} s`);
console.log(`  frames payload  ~${Math.round(frameBytes / 1024)} KiB per match (both halves, JSON)`);
console.log(`  memory          rss ${Math.round(mem.rss / 1e6)} MB · heapUsed ${Math.round(mem.heapUsed / 1e6)} MB`);
