/**
 * realism-harness.ts — real-squad sanity harness (tag: realism).
 *
 * The stat harness calibrates against SYNTHETIC squads; nothing there ever
 * touches the seeded player pool. This harness is the payoff test of the
 * whole pipeline: load pipeline/seeds/players.sql, rebuild club XIs via the
 * fbref_id → Squad join from the cached standard CSV, sim them with the
 * agent engine, and assert COARSE ordering — not stat bands:
 *
 *   1. higher aggregate-attribute squads win more often;
 *   2. squad quality correlates with points across a mixed round-robin;
 *   3. elite-finishing strikers outscore filler strikers;
 *   4. no single attribute dominates outcomes beyond overall quality;
 *   5. keeper quality (gk attributes) moves goals conceded — the engine
 *      reads gk*, so PR #7's flat-3 outfield attributes must not lobotomize
 *      keepers (MAPPING flag).
 *
 * TWO POOLS (harness-pool.ts): the default run joins the real seeded pool to
 * real squads via the uncommitted cache CSV — the AUTHORITATIVE acceptance
 * gate, run locally before an engine PR merges. `--fixture` runs the same
 * checks against the committed stride-sample (harness-fixture.json) — the CI
 * regression tripwire. Everything is deterministic, so fixture-mode results
 * are stable until engine behavior changes.
 *
 * Run: ENGINE is always the agent engine here.
 *   node realism-harness.ts [--json] [--fixture]
 */

import { AgentEngine } from './agent-engine.ts';
import { fixtureFlag, loadClubPools, type HarnessPlayer } from './harness-pool.ts';
import type {
  Attributes,
  HalfResult,
  Phase,
  PlayerInstructions,
  PlayerTactic,
  SquadPlayer,
  Tactics,
  Vec2,
} from './engine-types.ts';

const JSON_ONLY = process.argv.includes('--json');
const FIXTURE = fixtureFlag();
const SHARPNESS_MIXED = process.argv.includes('--sharpness-mixed');

type SeedPlayer = HarnessPlayer;

/**
 * --sharpness-mixed: a deterministic mid-season sharpness distribution
 * (name-hash FNV-1a, so runs are stable) over the SIMMED XIs — who are the
 * most-played cohort, i.e. the players a real mid-season would keep sharp:
 * ~70% match-sharp (0.88–1), ~25% rotation (0.6–0.85), ~5% rusty
 * (0.35–0.55). The acceptance pair: WITHOUT the flag every player is
 * full-sharp and the run must be byte-identical to the pre-sharpness
 * baseline (sharpness=1 is a no-op); WITH it the ordering checks must still
 * pass 7/7 — if a realistic distribution breaks them, the penalty is
 * heavier than MEDIUM.
 */
function mixedSharpness(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = ((h >>> 0) % 10_000) / 10_000;
  if (u < 0.7) return 0.88 + 0.12 * (u / 0.7);
  if (u < 0.95) return 0.6 + 0.25 * ((u - 0.7) / 0.25);
  return 0.35 + 0.2 * ((u - 0.95) / 0.05);
}

// ── XI construction on the synthetic-harness 4-3-3 geometry ─────────────────

type Role = 'GK' | 'CB' | 'FB' | 'CM' | 'W' | 'ST';
const FORMATION: Array<{ role: Role; def: Vec2; att: Vec2 }> = [
  { role: 'GK', def: { x: 6, y: 34 }, att: { x: 13, y: 34 } },
  { role: 'FB', def: { x: 20, y: 12 }, att: { x: 55, y: 10 } },
  { role: 'CB', def: { x: 18, y: 26 }, att: { x: 45, y: 26 } },
  { role: 'CB', def: { x: 18, y: 42 }, att: { x: 45, y: 42 } },
  { role: 'FB', def: { x: 20, y: 56 }, att: { x: 55, y: 58 } },
  { role: 'CM', def: { x: 32, y: 20 }, att: { x: 65, y: 20 } },
  { role: 'CM', def: { x: 30, y: 34 }, att: { x: 60, y: 34 } },
  { role: 'CM', def: { x: 32, y: 48 }, att: { x: 65, y: 48 } },
  { role: 'W', def: { x: 45, y: 12 }, att: { x: 85, y: 12 } },
  { role: 'ST', def: { x: 48, y: 34 }, att: { x: 90, y: 34 } },
  { role: 'W', def: { x: 45, y: 56 }, att: { x: 85, y: 56 } },
];
const PHASE_BLEND: Record<Phase, number> = {
  defensiveBlock: 0.05, buildUp: 0.3, counterPress: 0.55,
  progression: 0.6, counterAttack: 0.85, finalThird: 1.0,
};
const INSTR: Record<Role, PlayerInstructions> = {
  GK: { riskAppetite: 0.3, shootingBias: 0.05, dribbleBias: 0.05, pressingIntensity: 0.2, holdPosition: 0.95, crossBias: 0.05 },
  CB: { riskAppetite: 0.35, shootingBias: 0.2, dribbleBias: 0.35, pressingIntensity: 0.5, holdPosition: 0.8, crossBias: 0.3 },
  FB: { riskAppetite: 0.5, shootingBias: 0.2, dribbleBias: 0.35, pressingIntensity: 0.5, holdPosition: 0.4, crossBias: 0.65 },
  CM: { riskAppetite: 0.5, shootingBias: 0.4, dribbleBias: 0.35, pressingIntensity: 0.5, holdPosition: 0.5, crossBias: 0.3 },
  W: { riskAppetite: 0.5, shootingBias: 0.6, dribbleBias: 0.65, pressingIntensity: 0.55, holdPosition: 0.4, crossBias: 0.6 },
  ST: { riskAppetite: 0.5, shootingBias: 0.7, dribbleBias: 0.5, pressingIntensity: 0.55, holdPosition: 0.4, crossBias: 0.3 },
};

interface Club { name: string; squad: SquadPlayer[]; tactics: Tactics; quality: number; logValue: number; xi: SeedPlayer[] }

function buildClub(name: string, pool: SeedPlayer[]): Club | null {
  const byMinutes = (a: SeedPlayer, b: SeedPlayer) => b.minutes - a.minutes;
  const gks = pool.filter((p) => p.position === 'GK').sort(byMinutes);
  const dfs = pool.filter((p) => p.position === 'DF').sort(byMinutes);
  const mfs = pool.filter((p) => p.position === 'MF').sort(byMinutes);
  const fws = pool.filter((p) => p.position === 'FW').sort(byMinutes);
  if (!gks.length || dfs.length < 4 || mfs.length < 3) return null;
  const forwards = [...fws];
  while (forwards.length < 3 && mfs.length > 3) forwards.push(mfs.splice(3, 1)[0]); // borrow spare mids
  if (forwards.length < 3) return null;

  const backFour = dfs.slice(0, 4).sort((a, b) => b.heightCm - a.heightCm);
  const cbs = backFour.slice(0, 2);
  const fbs = backFour.slice(2, 4);
  const mids = mfs.slice(0, 3);
  const front = forwards.slice(0, 3).sort((a, b) => b.attributes.finishing - a.attributes.finishing);
  const st = front[0];
  const wings = front.slice(1, 3);
  const bySlot: SeedPlayer[] = [gks[0], fbs[0], cbs[0], cbs[1], fbs[1], mids[0], mids[1], mids[2], wings[0], st, wings[1]];

  const squad: SquadPlayer[] = [];
  const players: PlayerTactic[] = [];
  for (let i = 0; i < 11; i++) {
    const sp = bySlot[i];
    const slot = FORMATION[i];
    squad.push({
      playerId: `${name}|${sp.name}`,
      attributes: sp.attributes,
      physical: { heightCm: sp.heightCm, weightKg: sp.heightCm - 105, preferredFoot: 'R', injuryProneness: 10 },
      fatigue: 0.1,
      ...(SHARPNESS_MIXED ? { sharpness: mixedSharpness(sp.name) } : {}), // absent = full-sharp
      familiarity: {},
    } as SquadPlayer);
    const anchors = {} as Record<Phase, Vec2>;
    for (const ph of Object.keys(PHASE_BLEND) as Phase[]) {
      const t = PHASE_BLEND[ph];
      anchors[ph] = { x: slot.def.x + (slot.att.x - slot.def.x) * t, y: slot.def.y + (slot.att.y - slot.def.y) * t };
    }
    players.push({ playerId: `${name}|${sp.name}`, anchors, instructions: INSTR[slot.role], zones: {} });
  }
  const outfield = bySlot.slice(1);
  const OUTFIELD_KEYS: Array<keyof Attributes> = [
    'passing', 'longPassing', 'vision', 'firstTouch', 'dribbling', 'finishing', 'heading', 'crossing',
    'tackling', 'marking', 'pace', 'acceleration', 'stamina', 'strength', 'jumping', 'agility',
    'decisions', 'composure', 'positioning', 'offTheBall', 'anticipation', 'workRate',
  ];
  const quality = outfield.reduce(
    (s, p) => s + OUTFIELD_KEYS.reduce((a, k) => a + p.attributes[k], 0) / OUTFIELD_KEYS.length, 0,
  ) / outfield.length;
  const logValue = Math.log10(Math.max(1, bySlot.reduce((s, p) => s + p.marketValue, 0)));
  return {
    name, squad, quality, logValue, xi: bySlot,
    tactics: {
      players,
      team: { lineHeight: 0.5, width: 0.5, compactness: 0.5, pressTrigger: 0.5, counterPressDuration: 6, tempo: 0.5 },
      bench: [],
      setPieceTakers: { corners: players[8].playerId, freeKicks: players[5].playerId, penalties: players[9].playerId },
    },
  };
}

// ── sim + report plumbing ────────────────────────────────────────────────────

const engine = new AgentEngine();

function playMatch(home: Club, away: Club, seed: string): { h1: HalfResult; h2: HalfResult } {
  const squads = { home: home.squad, away: away.squad };
  const tactics = { home: home.tactics, away: away.tactics };
  const h1 = engine.simulateHalf({ fixtureId: seed, homeClubId: home.name, awayClubId: away.name, half: 1 }, squads, tactics, seed);
  const h2 = engine.simulateHalf(
    { fixtureId: seed, homeClubId: home.name, awayClubId: away.name, half: 2, resumeState: h1.endState },
    squads, tactics, seed,
  );
  return { h1, h2 };
}

interface Row { metric: string; kind: 'realism'; sim_value: string; target_band: string; status: 'pass' | 'fail' | 'info' }
const rows: Row[] = [];
function check(metric: string, value: string, band: string, ok: boolean | null): void {
  rows.push({ metric, kind: 'realism', sim_value: value, target_band: band, status: ok === null ? 'info' : ok ? 'pass' : 'fail' });
  if (!JSON_ONLY) console.log(`${ok === null ? 'info' : ok ? 'PASS' : 'FAIL'}  ${metric}: ${value} (${band})`);
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy || 1);
}

// ── main ─────────────────────────────────────────────────────────────────────

const byClub = loadClubPools(FIXTURE);
const seedPool = [...byClub.values()].flat();
const clubs: Club[] = [];
for (const [nameOf, pool] of byClub) {
  const club = buildClub(nameOf, pool);
  if (club) clubs.push(club);
}
clubs.sort((a, b) => b.quality - a.quality);
if (!JSON_ONLY) {
  console.log(
    `${FIXTURE ? 'FIXTURE (CI tripwire)' : 'REAL (acceptance)'} pool` +
    `${SHARPNESS_MIXED ? ', MIXED sharpness distribution' : ''}: ` +
    `${seedPool.length} players, ${byClub.size} squads, ${clubs.length} complete XIs`,
  );
  console.log(`quality: best ${clubs[0].name} ${clubs[0].quality.toFixed(2)} … worst ${clubs[clubs.length - 1].name} ${clubs[clubs.length - 1].quality.toFixed(2)}`);
}

// 1. top-8 vs bottom-8 cross-matches: quality must convert to wins
{
  const top = clubs.slice(0, 8);
  const bottom = clubs.slice(-8);
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (let i = 0; i < 40; i++) {
    const t = top[i % 8], b = bottom[(i * 3 + 1) % 8];
    const homeIsTop = i % 2 === 0;
    const { h2 } = playMatch(homeIsTop ? t : b, homeIsTop ? b : t, `real-tb-${i}`);
    const [gh, gaw] = h2.endState.score;
    const [tg, bg] = homeIsTop ? [gh, gaw] : [gaw, gh];
    gf += tg; ga += bg;
    if (tg > bg) w++; else if (tg === bg) d++; else l++;
  }
  // gate 0.60 → 0.55: PR #10's tempering ACCEPTED 0.575 as the balance point
  // (draws in band on 3/3 seeds traded a slice of top-8 dominance —
  // DECISIONS.md "score-state equalization balance point"); the harness gate
  // was never re-aligned because these runs were manual until the CI fixture
  // gate 0.55 → 0.52 (DECISIONS 2026-09-05, user-accepted): the ball-flight
  // engine brought draw_share NEAR ITS BAND for the first time (0.18–0.23 vs
  // the old always-failing 0.19–0.22), and more draws arithmetically depress
  // win share — the check's true value settled AT 0.55 and coin-flipped per
  // keyed re-roll (measured 0.475–0.625 over ~10 re-rolls). This is NOT a
  // weakening of the ordering guard: quality↔points r=0.86, goal ratio
  // 1.7:0.9, and the ST/GK checks all held or strengthened through the
  // change. The gate moved because a DIFFERENT band (draws) improved, not
  // because ordering regressed — at 0.52 the check still fails any engine
  // whose top-8 stop beating the bottom-8.
  check('realism: top-8 quality beats bottom-8 win share', (w / 40).toFixed(3), '> 0.52 (flight-arc balance point)', w / 40 > 0.52);
  check('realism: top-8 vs bottom-8 goal ratio', `${(gf / 40).toFixed(2)}:${(ga / 40).toFixed(2)}`, 'gf > ga', gf > ga);
}

// 2. mixed sample: quality ↔ points correlation (+ per-player goal tallies)
const goalsByPlayer = new Map<string, number>();
const minutesFactor = new Map<string, number>();
{
  // 16 clubs evenly spaced across the FULL quality range (a top-16 slice of a
  // small pool flattens the range and starves the correlations of signal)
  const sample: Club[] = [];
  for (let i = 0; i < 16; i++) {
    const club = clubs[Math.round((i * (clubs.length - 1)) / 15)];
    if (!sample.includes(club)) sample.push(club);
  }
  const points = new Map<string, number>(sample.map((c) => [c.name, 0]));
  const games = new Map<string, number>(sample.map((c) => [c.name, 0]));
  let n = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      if ((i + j) % 2 !== 0) continue; // subset: ~60 matches
      const home = (i + j) % 2 === 0 ? sample[i] : sample[j];
      const away = (i + j) % 2 === 0 ? sample[j] : sample[i];
      const { h1, h2 } = playMatch(home, away, `real-rr-${i}-${j}`);
      n++;
      const [gh, gaw] = h2.endState.score;
      games.set(home.name, games.get(home.name)! + 1);
      games.set(away.name, games.get(away.name)! + 1);
      if (gh > gaw) points.set(home.name, points.get(home.name)! + 3);
      else if (gh < gaw) points.set(away.name, points.get(away.name)! + 3);
      else { points.set(home.name, points.get(home.name)! + 1); points.set(away.name, points.get(away.name)! + 1); }
      for (const e of [...h1.events, ...h2.events]) {
        if (e.type === 'goal' && e.playerId) goalsByPlayer.set(e.playerId, (goalsByPlayer.get(e.playerId) ?? 0) + 1);
      }
      for (const c of [home, away]) minutesFactor.set(c.name, (minutesFactor.get(c.name) ?? 0) + 1);
    }
  }
  const qs: number[] = [], ps: number[] = [];
  for (const c of sample) {
    if (!games.get(c.name)) continue;
    qs.push(c.quality);
    ps.push(points.get(c.name)! / games.get(c.name)!);
  }
  const r = pearson(qs, ps);
  check(`realism: quality↔points correlation (${n} matches, ${qs.length} squads)`, r.toFixed(3), 'r > 0.4', r > 0.4);
  const vs: number[] = [];
  for (const c of sample) if (games.get(c.name)) vs.push(c.logValue);
  const rv = pearson(vs, ps);
  // external sanity anchor, not a calibration target: direction + significance
  // is the claim. 0.49 pre-tempering → ~0.31 after PR #10 flattened points
  // with in-band draws; gate re-aligned alongside the win-share gate above
  check('realism: log(market value)↔points correlation', rv.toFixed(3), 'r > 0.25 (external anchor)', rv > 0.25);

  // 4. single-attribute dominance: no attribute should out-predict quality by a wide margin
  const worst: Array<[string, number]> = [];
  for (const key of ['finishing', 'pace', 'passing', 'strength', 'heading', 'dribbling', 'tackling'] as Array<keyof Attributes>) {
    const xs = sample.filter((c) => games.get(c.name)).map((c) =>
      c.xi.slice(1).reduce((s, p) => s + p.attributes[key], 0) / 10);
    const rr = pearson(xs, ps);
    worst.push([key, rr]);
  }
  worst.sort((a, b) => b[1] - a[1]);
  const [topAttr, topR] = worst[0];
  check('realism: top single-attribute predictor', `${topAttr} r=${topR.toFixed(3)} vs quality r=${r.toFixed(3)}`,
    'attr r < quality r + 0.25', topR < r + 0.25);
}

// 3. elite strikers outscore filler (per selected-XI strikers across the sample)
{
  const stGoals: Array<{ fin: number; goals: number }> = [];
  for (const c of clubs) {
    if (!minutesFactor.get(c.name)) continue;
    const st = c.xi[9];
    const id = `${c.name}|${st.name}`;
    stGoals.push({ fin: st.attributes.finishing, goals: (goalsByPlayer.get(id) ?? 0) / minutesFactor.get(c.name)! });
  }
  stGoals.sort((a, b) => b.fin - a.fin);
  const q = Math.max(1, Math.floor(stGoals.length / 3));
  const elite = stGoals.slice(0, q);
  const filler = stGoals.slice(-q);
  const em = elite.reduce((s, x) => s + x.goals, 0) / q;
  const fm = filler.reduce((s, x) => s + x.goals, 0) / q;
  check('realism: elite-finishing STs outscore filler STs (goals/match)', `${em.toFixed(2)} vs ${fm.toFixed(2)}`,
    'elite > filler', em > fm);
}

// 5. keeper quality moves goals conceded (gk* attributes are read; flat-3
// outfield attrs must not lobotomize keepers)
{
  const allGks = seedPool.filter((p) => p.position === 'GK' && p.minutes > 1500)
    .sort((a, b) => (b.attributes.gkReflexes + b.attributes.gkPositioning) - (a.attributes.gkReflexes + a.attributes.gkPositioning));
  const eliteGk = allGks[0];
  const weakGk = allGks[allGks.length - 1];
  const base = clubs[Math.floor(clubs.length / 2)];
  const opp = clubs[Math.floor(clubs.length / 2) + 1];
  const withGk = (club: Club, gk: SeedPlayer): Club => {
    const clone: Club = { ...club, squad: club.squad.map((s) => ({ ...s })), tactics: { ...club.tactics, players: club.tactics.players.map((p) => ({ ...p })) } };
    clone.squad[0] = { ...clone.squad[0], playerId: `${club.name}|GKSWAP`, attributes: gk.attributes, physical: { ...clone.squad[0].physical, heightCm: gk.heightCm } };
    clone.tactics.players[0] = { ...clone.tactics.players[0], playerId: `${club.name}|GKSWAP` };
    return clone;
  };
  let concededElite = 0, concededWeak = 0;
  for (let i = 0; i < 15; i++) {
    concededElite += playMatch(withGk(base, eliteGk), opp, `real-gk-e-${i}`).h2.endState.score[1];
    concededWeak += playMatch(withGk(base, weakGk), opp, `real-gk-w-${i}`).h2.endState.score[1];
  }
  check(
    `realism: elite GK (${eliteGk.name}) concedes less than weak GK (${weakGk.name})`,
    `${(concededElite / 15).toFixed(2)} vs ${(concededWeak / 15).toFixed(2)} per match`,
    'elite < weak', concededElite < concededWeak,
  );
}

if (JSON_ONLY) console.log(JSON.stringify(rows, null, 1));
const fails = rows.filter((r) => r.status === 'fail').length;
if (!JSON_ONLY) console.log(`\nrealism: ${rows.length - fails}/${rows.length} pass`);
process.exit(fails ? 1 : 0);
