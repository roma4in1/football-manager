/**
 * engine/aggregate.ts — AggregateEngine: the Poisson/aggregate fallback behind
 * SimEngine (M3 playable league). AgentEngine replaces it behind the same
 * interface mid-season.
 *
 * What it does:
 *  - Team strength profiles from attribute means; Poisson shot counts scaled by
 *    attack/defense ratio, home boost, tempo; per-shot xG draw decides goals.
 *  - Fabricates coarse events (shots/goals/saves/fouls/cards/corners/offsides/
 *    injuries) and low-rate frames (one per 6s) — enough for result card, stats,
 *    and a degraded replay. Heatmaps from phase-blended anchors.
 *  - Consumes tactics coarsely: team sliders + player-instruction means move
 *    aggregate rates (press→PPDA/fatigue, risk→passAcc/xG-per-shot, lineHeight→
 *    opponent offsides, crossBias→aerials/headers). Anchors drive heatmaps and
 *    frames. `zones` are IGNORED here — only the agent engine consumes them.
 *
 * Cards v2 (HalfTimeState v: 2 — resume throws on any other version):
 *  - Second yellow (incl. cross-half: H1 yellow + H2 yellow) or straight red →
 *    cards.sentOff in end_state. Within the half, a red thins own shots and
 *    boosts the opponent from its timestamp.
 *  - On H2 resume, sent-off players are excluded entirely (no minutes, no
 *    fatigue delta, no events) and the shorthanded team's attack AND defense
 *    ratios take CAL.sentOffPenalty per missing player (rough 10-men-concede-
 *    more behavior; exact calibration deferred to the agent engine).
 *  - Scorelines get a Dixon-Coles-style low-score adjustment (CAL.dixonColesTau):
 *    openers at 0-0 damped ×(1−τ), 0-1 → 1-1 equalizers boosted ×(1+τ).
 *
 * Not modeled (known stub gaps):
 *  - Subs: bench unused, no 'sub' events; minutesPlayed is 45/half for every
 *    active player (a mid-half send-off still counts the full 45 that half).
 *  - Injured players are flagged but keep playing (no sub model).
 *
 * Determinism: all randomness via Rng seeded from `${fixtureId}|${seed}`; half 2
 * resumes the serialized stream from resumeState.rngState. No I/O, no Date.now(),
 * no Math.random().
 *
 * Coordinate conventions: tactics anchors are team-relative (own goal line x=0,
 * attacking toward x=105). Events and frames are in the GLOBAL frame (home
 * attacks +x, away positions flipped). Heatmaps stay team-relative (each team
 * attacks left→right) — harness/UI decodes.
 */

import type {
  Attributes,
  BallFlight,
  Fixture,
  HalfResult,
  HalfStats,
  HalfTimeState,
  MatchEvent,
  Phase,
  PlayerTactic,
  SimEngine,
  SquadPlayer,
  Tactics,
  Vec2,
} from './engine-types.ts';
import { Rng } from './engine-rng.ts';

export const HALF_SECONDS = 2700;

/** Calibration knobs. Tuned against calibration-reference.md via stat-harness.ts. */
export const CAL = {
  baseShotsPerHalf: 6.45, // per team, equal-strength, before boosts
  shotStrengthExp: 1.25, // shots × (attack/oppDefense)^exp
  homeShotBoost: 1.15,
  awayShotBoost: 0.84,
  h1Factor: 0.91, // → 2nd-half goal share ~53% after DC/send-off drag
  h2Factor: 1.09,
  tempoShotGain: 0.2, // ×(0.9 + gain×meanTempo)
  fatigueAttackPenalty: 0.15, // attack/control ×(1 − pen×meanFatigue)

  pensPerHalf: 0.07,
  srcSetPiece: 0.27, // shot source mix (rest open play)
  srcCounter: 0.1,
  xgOpen: [0.02, 0.45] as const, // xg = a + b·u^xgPow
  xgCounter: [0.03, 0.55] as const,
  xgSetPiece: [0.015, 0.35] as const,
  xgPow: 4,
  penXg: 0.76,
  riskXgGain: 0.2, // xg ×(1 + gain×(risk−0.5))
  finishAdjPerPt: 0.02, // pGoal ×(1 + adj×(finishing−12))
  onTargetBase: 0.28, // non-goal shots on target
  headerSetPiece: 0.68,
  headerOpenBase: 0.075,
  headerCrossGain: 0.12,
  cornerAmbientPerHalf: 1.6,
  cornerAfterSave: 0.3,

  foulsPerHalf: 5.5,
  yellowPerFoul: 0.18,
  redPerFoul: 0.005, // straight reds only; second yellows add on top
  cardedFoulWeight: 0.18, // booked players foul much less (tightrope) — tunes 2nd-yellow rate
  redShotThin: 0.35, // own shots dropped after a red
  redOppShotGain: 0.25, // opponent extra-shot λ share after a red
  sentOffPenalty: 0.15, // attack+defense ratio hit per sent-off player on H2 resume
  dixonColesTau: 0.072, // low-score dependence: 0-0 opener ×(1−τ), 0-1→1-1 equalizer ×(1+τ)
  offsidesPerHalf: 1.0, // ×(0.5 + opponent lineHeight)
  injuryBasePerHalf: 0.016,

  aerialDuelsPerHalf: 18, // both teams
  longBallsPerHalf: 20, // per team; ≈8–10% of a ~450-pass match (calibration long-ball share band)
  longBallPropensityGain: 0.7, // attempts ×(0.6 + gain×teamLongPass) — good long passers play more of them
  longBallCompletionBase: 0.25, // completion p = base + gain×teamLongPass (~0.55 at league-average skill)
  longBallCompletionGain: 0.5,
  possPerCtrlDiff: 55,
  possNoiseSd: 3,
  passAccBase: 82,
  passAccCtrlGain: 30,
  passAccRiskLoss: 8, // −loss×(risk−0.5)
  ppdaBase: 16,
  ppdaPressGain: 8,

  fatigueBasePerHalf: 0.22,
  fatigueTempoGain: 0.1,
  fatiguePressGain: 0.12,

  heatmapCols: 12,
  heatmapRows: 8,
  frameDt: 6, // seconds between fabricated frames
} as const;

// ── internal shapes ──────────────────────────────────────────────────────────

interface ActivePlayer {
  id: string;
  sp: SquadPlayer;
  pt: PlayerTactic;
  isGk: boolean;
  startFatigue: number;
}

interface TeamCtx {
  side: 'home' | 'away';
  tactics: Tactics;
  players: ActivePlayer[]; // active this half (resume sent-offs excluded)
  inactive: ActivePlayer[]; // sent off in a previous half; state carried, never simmed
  gk: ActivePlayer;
  attack: number; // 0–1 scale (attr means /20)
  defense: number;
  control: number; // ground game — reads passing; feeds possession + passAccuracy
  longPass: number; // lofted/high non-cross deliveries — reads longPassing only
  aerial: number;
  press: number; // 0–1 blended team+player pressing
  risk: number;
  cross: number;
  aggression: number; // 0–1
  tempo: number;
  lineHeight: number;
  meanFatigue: number;
}

interface ShotPlan {
  t: number;
  team: TeamCtx;
  source: 'openPlay' | 'counter' | 'setPiece' | 'penalty';
}

interface PlayerTally {
  goals: number;
  sot: number;
  saves: number;
  yellows: 0 | 1; // seeded from resume state so a H1 yellow + H2 yellow = send-off
  sentOff: boolean;
  sentOffAt: number; // sim seconds; Infinity when not sent off
  injured: boolean;
}

const round = (x: number, d: number): number => {
  const m = 10 ** d;
  return Math.round(x * m) / m;
};
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const attrMean = (ps: ActivePlayer[], f: (a: Attributes) => number): number =>
  mean(ps.map((p) => f(p.sp.attributes))) / 20;
const flip = (v: Vec2): Vec2 => ({ x: 105 - v.x, y: 68 - v.y });

// ── engine ───────────────────────────────────────────────────────────────────

export class AggregateEngine implements SimEngine {
  simulateHalf(
    fixture: Fixture,
    squads: { home: SquadPlayer[]; away: SquadPlayer[] },
    tactics: { home: Tactics; away: Tactics },
    seed: string,
  ): HalfResult {
    const resume = fixture.resumeState;
    if (fixture.half === 2 && !resume) throw new Error('half 2 requires resumeState');
    if (fixture.half === 1 && resume) throw new Error('half 1 must not carry resumeState');
    if (resume && (resume as { v?: unknown }).v !== 2) {
      throw new Error('unsupported HalfTimeState version: expected v=2 (no migration path — v1 blobs must not exist)');
    }

    const rng = fixture.half === 1
      ? Rng.fromSeed(`${fixture.fixtureId}|${seed}`)
      : Rng.fromState(resume!.rngState);
    const t0 = fixture.half === 1 ? 0 : HALF_SECONDS;
    const halfFactor = fixture.half === 1 ? CAL.h1Factor : CAL.h2Factor;

    const home = buildTeam('home', squads.home, tactics.home, resume);
    const away = buildTeam('away', squads.away, tactics.away, resume);
    const all = [...home.players, ...away.players]; // active this half
    const everyone = [...all, ...home.inactive, ...away.inactive]; // + carried sent-offs
    const prevScore = resume?.score ?? [0, 0];

    const events: Array<MatchEvent & { seq: number }> = [];
    let seq = 0;
    const emit = (e: MatchEvent): void => {
      events.push({ ...e, t: round(e.t, 1), seq: seq++ });
    };
    emit({ t: t0, type: 'kickoff' });

    const tally = new Map<string, PlayerTally>();
    for (const p of all) {
      tally.set(p.id, {
        goals: 0, sot: 0, saves: 0,
        yellows: resume?.playerState[p.id]?.cards.yellows ?? 0,
        sentOff: false, sentOffAt: Infinity, injured: false,
      });
    }
    const onPitch = (p: ActivePlayer, t: number): boolean => {
      const pt = tally.get(p.id)!;
      return !(pt.sentOff && pt.sentOffAt <= t);
    };

    // ── fouls / cards first: send-offs modulate shot volume for the rest of the half.
    // Chronological so an early send-off excludes that player from later fouls.
    const redTime = new Map<TeamCtx, number>(); // team → earliest send-off timestamp
    for (const [team] of pairs(home, away)) {
      const lambda = CAL.foulsPerHalf * (0.8 + 0.4 * team.aggression) * (0.9 + 0.2 * team.press);
      const n = rng.poisson(lambda);
      const times: number[] = [];
      for (let i = 0; i < n; i++) times.push(t0 + rng.range(30, HALF_SECONDS - 10));
      times.sort((a, b) => a - b);
      for (const t of times) {
        const candidates = team.players.filter((p) => !p.isGk && onPitch(p, t));
        if (candidates.length === 0) continue;
        const fouler = pickByWeight(rng, candidates, (p) =>
          (p.sp.attributes.aggression + p.sp.attributes.tackling * 0.5) *
          (tally.get(p.id)!.yellows === 1 ? CAL.cardedFoulWeight : 1));
        emit({ t, type: 'foul', playerId: fouler.id, outcome: 'fail' });
        const ft = tally.get(fouler.id)!;
        const sendOff = (secondYellow: boolean): void => {
          ft.sentOff = true;
          ft.sentOffAt = t;
          emit({
            t: t + 0.3, type: 'card', playerId: fouler.id,
            meta: secondYellow ? { card: 'red', secondYellow: 1 } : { card: 'red' },
          });
          if (!redTime.has(team) || t < redTime.get(team)!) redTime.set(team, t);
        };
        if (rng.chance(CAL.redPerFoul)) {
          sendOff(false);
        } else if (rng.chance(CAL.yellowPerFoul)) {
          if (ft.yellows === 1) {
            sendOff(true); // second yellow (possibly carried from half 1)
          } else {
            ft.yellows = 1;
            emit({ t: t + 0.3, type: 'card', playerId: fouler.id, meta: { card: 'yellow' } });
          }
        }
      }
    }

    // ── shot plans (a neutral-venue fixture — the playoff final — has no home boost)
    const neutral = fixture.neutralVenue === true;
    const shotLambda = (team: TeamCtx, opp: TeamCtx): number =>
      CAL.baseShotsPerHalf *
      Math.pow(team.attack / opp.defense, CAL.shotStrengthExp) *
      (neutral ? 1 : team.side === 'home' ? CAL.homeShotBoost : CAL.awayShotBoost) *
      halfFactor *
      (0.9 + CAL.tempoShotGain * ((team.tempo + opp.tempo) / 2));

    const shots: ShotPlan[] = [];
    for (const [team, opp] of pairs(home, away)) {
      const lambda = shotLambda(team, opp);
      const n = rng.poisson(lambda);
      for (let i = 0; i < n; i++) {
        const t = t0 + rng.range(15, HALF_SECONDS - 5);
        // a red thins own shots and feeds opponent extras (handled below)
        if (redTime.has(team) && t > redTime.get(team)! && rng.chance(CAL.redShotThin)) continue;
        const u = rng.float();
        const source = u < CAL.srcSetPiece ? 'setPiece' : u < CAL.srcSetPiece + CAL.srcCounter ? 'counter' : 'openPlay';
        shots.push({ t, team, source });
      }
      if (redTime.has(opp)) {
        const frac = (t0 + HALF_SECONDS - redTime.get(opp)!) / HALF_SECONDS;
        const extra = rng.poisson(lambda * CAL.redOppShotGain * frac);
        for (let i = 0; i < extra; i++) {
          shots.push({ t: rng.range(redTime.get(opp)!, t0 + HALF_SECONDS - 5), team, source: 'openPlay' });
        }
      }
      const pens = rng.poisson(CAL.pensPerHalf);
      for (let i = 0; i < pens; i++) {
        shots.push({ t: t0 + rng.range(60, HALF_SECONDS - 30), team, source: 'penalty' });
      }
    }
    shots.sort((a, b) => a.t - b.t);

    // ── resolve shots
    const score: Record<'home' | 'away', number> = { home: 0, away: 0 };
    const xgSum: Record<'home' | 'away', number> = { home: 0, away: 0 };
    const shotCount: Record<'home' | 'away', number> = { home: 0, away: 0 };
    const sotCount: Record<'home' | 'away', number> = { home: 0, away: 0 };

    for (const shot of shots) {
      const team = shot.team;
      const opp = team === home ? away : home;
      const eligible = team.players.filter((p) => !p.isGk && onPitch(p, shot.t));
      if (eligible.length === 0) continue;
      const preferredTaker = team.players.find((p) => p.id === team.tactics.setPieceTakers.penalties);
      const shooter = shot.source === 'penalty'
        ? (preferredTaker && onPitch(preferredTaker, shot.t) ? preferredTaker : pickByWeight(rng, eligible, () => 1))
        : pickByWeight(rng, eligible, (p) =>
            Math.pow(p.pt.anchors.finalThird.x / 105, 2) *
            (0.5 + p.pt.instructions.shootingBias) *
            (p.sp.attributes.finishing / 20 + p.sp.attributes.offTheBall / 40));

      let xg: number;
      let header = 0;
      if (shot.source === 'penalty') {
        xg = clamp(CAL.penXg + rng.gauss(0, 0.02), 0.6, 0.9);
        emit({ t: shot.t - 2, type: 'setPiece', playerId: shooter.id, meta: { kind: 'penalty' } });
      } else {
        const [a, b] = shot.source === 'counter' ? CAL.xgCounter : shot.source === 'setPiece' ? CAL.xgSetPiece : CAL.xgOpen;
        xg = (a + b * Math.pow(rng.float(), CAL.xgPow)) * (1 + CAL.riskXgGain * (team.risk - 0.5));
        header = shot.source === 'setPiece'
          ? (rng.chance(CAL.headerSetPiece) ? 1 : 0)
          : (rng.chance(clamp(CAL.headerOpenBase + CAL.headerCrossGain * (team.cross - 0.5), 0.02, 0.25)) ? 1 : 0);
      }
      xg = clamp(xg, 0.01, 0.95);

      const skill = header ? shooter.sp.attributes.heading : shooter.sp.attributes.finishing;
      let pGoal = shot.source === 'penalty' ? xg : clamp(xg * (1 + CAL.finishAdjPerPt * (skill - 12)), 0.01, 0.92);

      // Dixon-Coles low-score adjustment on the MATCH score (resume-aware):
      // damp the opener at 0-0, boost the 0-1 → 1-1 equalizer.
      const ownTotal = (team === home ? prevScore[0] : prevScore[1]) + score[team.side];
      const oppTotal = (team === home ? prevScore[1] : prevScore[0]) + score[opp.side];
      if (ownTotal === 0 && oppTotal === 0) pGoal = clamp(pGoal * (1 - CAL.dixonColesTau), 0.005, 0.95);
      else if (ownTotal === 0 && oppTotal === 1) pGoal = clamp(pGoal * (1 + CAL.dixonColesTau), 0.005, 0.95);

      const from = team === home ? shooter.pt.anchors.finalThird : flip(shooter.pt.anchors.finalThird);
      const to: Vec2 = team === home ? { x: 105, y: 30.5 + rng.range(0, 7) } : { x: 0, y: 30.5 + rng.range(0, 7) };
      const flight: BallFlight = header ? 'high' : rng.chance(0.6) ? 'ground' : rng.chance(0.75) ? 'driven' : 'lofted';
      const meta = { xg: round(xg, 3), source: shot.source, header };

      shotCount[team.side]++;
      xgSum[team.side] += xg;
      emit({ t: shot.t, type: 'shot', playerId: shooter.id, from, to, flight, meta });

      if (rng.chance(pGoal)) {
        score[team.side]++;
        sotCount[team.side]++;
        tally.get(shooter.id)!.goals++;
        tally.get(shooter.id)!.sot++;
        emit({ t: shot.t + 0.4, type: 'goal', playerId: shooter.id, outcome: 'success', meta });
      } else if (rng.chance(CAL.onTargetBase + 0.01 * (skill - 12))) {
        sotCount[team.side]++;
        tally.get(shooter.id)!.sot++;
        tally.get(opp.gk.id)!.saves++;
        emit({ t: shot.t + 0.4, type: 'save', playerId: opp.gk.id, outcome: 'success' });
        if (rng.chance(CAL.cornerAfterSave)) {
          emit({ t: shot.t + 4, type: 'cornerAwarded', playerId: shooter.id });
        }
      }
    }

    // ── ambient corners, offsides, injuries
    for (const [team, opp] of pairs(home, away)) {
      const corners = rng.poisson(CAL.cornerAmbientPerHalf);
      for (let i = 0; i < corners; i++) emit({ t: t0 + rng.range(20, HALF_SECONDS - 5), type: 'cornerAwarded', playerId: team.tactics.setPieceTakers.corners });

      const offsides = rng.poisson(CAL.offsidesPerHalf * (0.5 + opp.lineHeight));
      for (let i = 0; i < offsides; i++) {
        const runner = pickByWeight(rng, team.players.filter((p) => !p.isGk), (p) => p.pt.anchors.finalThird.x / 105);
        emit({ t: t0 + rng.range(30, HALF_SECONDS - 5), type: 'offside', playerId: runner.id, outcome: 'fail' });
      }

      for (const p of team.players) {
        const pInj = CAL.injuryBasePerHalf * (0.5 + p.sp.physical.injuryProneness / 20) * (1 + 0.5 * p.startFatigue);
        if (rng.chance(pInj)) {
          tally.get(p.id)!.injured = true;
          emit({ t: t0 + rng.range(60, HALF_SECONDS - 5), type: 'injury', playerId: p.id, outcome: 'fail' });
        }
      }
    }

    // ── long balls: attempts and completion read longPassing (never `passing`,
    // which stays the ground game). Emitted as coarse 'pass' events with
    // lofted/high flight so the harness can observe completion separately
    // from stats.passAccuracy.
    for (const [team] of pairs(home, away)) {
      const attempts = rng.poisson(
        CAL.longBallsPerHalf * (0.6 + CAL.longBallPropensityGain * team.longPass),
      );
      const pComplete = clamp(
        CAL.longBallCompletionBase + CAL.longBallCompletionGain * team.longPass, 0.1, 0.85,
      );
      for (let i = 0; i < attempts; i++) {
        const passer = pickByWeight(rng, team.players.filter((p) => !p.isGk), (p) =>
          (p.sp.attributes.longPassing ?? p.sp.attributes.passing));
        const fromRel: Vec2 = { x: rng.range(15, 42), y: rng.range(6, 62) };
        const toRel: Vec2 = { x: clamp(fromRel.x + rng.range(25, 45), 0, 103), y: rng.range(6, 62) };
        emit({
          t: t0 + rng.range(10, HALF_SECONDS - 10),
          type: 'pass',
          playerId: passer.id,
          from: team === home ? fromRel : flip(fromRel),
          to: team === home ? toRel : flip(toRel),
          flight: rng.chance(0.8) ? 'lofted' : 'high',
          outcome: rng.chance(pComplete) ? 'success' : 'fail',
        });
      }
    }

    // ── aerial duels: shared pool split by aerial strength, volume by crossBias
    const crossFactor = 0.7 + 0.3 * (home.cross + away.cross);
    const duels = rng.poisson(CAL.aerialDuelsPerHalf * crossFactor);
    const aerialShareH = home.aerial / (home.aerial + away.aerial);
    let aerialsH = 0;
    for (let i = 0; i < duels; i++) if (rng.chance(aerialShareH)) aerialsH++;

    // ── team stat lines
    const ctrlDiff = home.control - away.control;
    const possH = clamp(50 + CAL.possPerCtrlDiff * ctrlDiff + rng.gauss(0, CAL.possNoiseSd), 28, 72);
    const passAcc = (team: TeamCtx, opp: TeamCtx): number =>
      clamp(
        CAL.passAccBase + CAL.passAccCtrlGain * (team.control - opp.control) -
          CAL.passAccRiskLoss * (team.risk - 0.5) + rng.gauss(0, 1.2),
        66, 94);
    const passAccH = passAcc(home, away);
    const passAccA = passAcc(away, home);
    const ppda = (team: TeamCtx): number => clamp(CAL.ppdaBase - CAL.ppdaPressGain * team.press + rng.gauss(0, 1.2), 5, 24);
    const ppdaH = ppda(home);
    const ppdaA = ppda(away);
    const tiltH = clamp(50 + 1.15 * (possH - 50) + rng.gauss(0, 3.5), 18, 82);

    // ── fatigue
    const endFatigue = new Map<string, number>();
    for (const [team] of pairs(home, away)) {
      const load = CAL.fatigueBasePerHalf + CAL.fatigueTempoGain * team.tempo + CAL.fatiguePressGain * team.press;
      for (const p of team.players) {
        const staminaFactor = 1.25 - (p.sp.attributes.stamina / 20) * 0.5; // stamina 10→1.0, 20→0.75
        const gkFactor = p.isGk ? 0.35 : 1;
        endFatigue.set(p.id, clamp(round(p.startFatigue + load * staminaFactor * gkFactor + rng.gauss(0, 0.015), 3), 0, 1));
      }
    }

    // ── player ratings
    const playerRatings: Record<string, number> = {};
    for (const [team] of pairs(home, away)) {
      const diff = score[team.side] - score[team.side === 'home' ? 'away' : 'home'];
      const resultTerm = diff > 0 ? 0.25 : diff < 0 ? -0.25 : 0;
      for (const p of team.players) {
        const t = tally.get(p.id)!;
        let r = 6.4 + 0.85 * t.goals + 0.12 * (t.sot - t.goals) + resultTerm + rng.gauss(0, 0.32);
        if (p.isGk) r += 0.16 * t.saves - 0.12 * score[team.side === 'home' ? 'away' : 'home'];
        if (t.sentOff) r -= 1.2;
        else if (t.yellows === 1) r -= 0.3;
        playerRatings[p.id] = clamp(round(r, 1), 4, 9.8);
      }
    }

    emit({ t: t0 + HALF_SECONDS, type: 'halfEnd' });
    events.sort((a, b) => a.t - b.t || a.seq - b.seq);

    // ── frames + heatmaps
    // frames draw from a DEDICATED fork: fabrication noise must never consume
    // the outcome stream (endState.rngState below resumes half 2 from it)
    const frames = fabricateFrames(Rng.fromSeed(`${fixture.fixtureId}|${seed}|frames|${fixture.half}`), t0, tiltH, home, away);
    // legacy-stream shim: the OLD fabrication drew from the outcome stream
    // right here (2 gauss + 1 weighted + 2 gauss per player, per frame).
    // Burn the identical call pattern so every historical seed keeps
    // reproducing byte-identically — dropping the draws re-noised all three
    // harness master seeds and pushed harness-v3 out of band (draw_share,
    // home_win_share, headed_goal_share). Remove only alongside an aggregate
    // recalibration (or the agent-engine switch).
    {
      const nBurn = Math.floor(HALF_SECONDS / CAL.frameDt);
      const legacyWeights = [0.75, 0.1, 0.1, 0.05];
      for (let k = 0; k < nBurn; k++) {
        rng.gauss(0, 9);
        rng.gauss(0, 6);
        rng.weighted(legacyWeights);
        for (let i = 0; i < home.players.length + away.players.length; i++) {
          rng.gauss(0, 2.5);
          rng.gauss(0, 2.5);
        }
      }
    }
    const heatmaps: Record<string, number[]> = {};
    for (const [team] of pairs(home, away)) {
      const possFrac = (team.side === 'home' ? possH : 100 - possH) / 100;
      for (const p of team.players) heatmaps[p.id] = heatmapFor(p, possFrac);
    }

    // ── end state (v2). Sent-off carry-overs are frozen: no minutes, no fatigue delta.
    const endState: HalfTimeState = {
      v: 2,
      score: [prevScore[0] + score.home, prevScore[1] + score.away],
      playerState: Object.fromEntries(everyone.map((p) => {
        const t = tally.get(p.id); // absent = inactive (sent off in a previous half)
        const prev = resume?.playerState[p.id];
        if (!t) {
          return [p.id, {
            fatigue: prev!.fatigue,
            cards: prev!.cards,
            injured: prev!.injured,
            minutesPlayed: prev!.minutesPlayed,
          }];
        }
        return [p.id, {
          fatigue: endFatigue.get(p.id)!,
          cards: { yellows: t.yellows, sentOff: t.sentOff },
          injured: (prev?.injured ?? false) || t.injured,
          minutesPlayed: (prev?.minutesPlayed ?? 0) + 45,
        }];
      })),
      subsUsed: resume?.subsUsed ?? [0, 0],
      rngState: rng.serialize(),
    };

    const stats: HalfStats = {
      possession: [round(possH, 1), round(100 - possH, 1)],
      shots: [shotCount.home, shotCount.away],
      shotsOnTarget: [sotCount.home, sotCount.away],
      xg: [round(xgSum.home, 2), round(xgSum.away, 2)],
      passAccuracy: [round(passAccH, 1), round(passAccA, 1)],
      aerialsWon: [aerialsH, duels - aerialsH],
      ppda: [round(ppdaH, 1), round(ppdaA, 1)],
      fieldTilt: [round(tiltH, 1), round(100 - tiltH, 1)],
      playerRatings,
      heatmaps,
    };

    return {
      events: events.map(({ seq: _, ...e }) => e),
      frames,
      stats,
      endState,
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pairs(home: TeamCtx, away: TeamCtx): Array<[TeamCtx, TeamCtx]> {
  return [[home, away], [away, home]];
}

function pickByWeight(rng: Rng, ps: ActivePlayer[], w: (p: ActivePlayer) => number): ActivePlayer {
  return ps[rng.weighted(ps.map(w))];
}

function buildTeam(
  side: 'home' | 'away',
  squad: SquadPlayer[],
  tactics: Tactics,
  resume: HalfTimeState | undefined,
): TeamCtx {
  const byId = new Map(squad.map((sp) => [sp.playerId, sp]));
  const starters: ActivePlayer[] = tactics.players.map((pt: PlayerTactic) => {
    const sp = byId.get(pt.playerId);
    if (!sp) throw new Error(`tactic references ${pt.playerId} not in squad`);
    return {
      id: pt.playerId,
      sp,
      pt,
      isGk: false,
      startFatigue: resume?.playerState[pt.playerId]?.fatigue ?? sp.fatigue,
    };
  });
  if (starters.length !== 11) throw new Error(`expected 11 starters, got ${starters.length}`);

  // players sent off in a previous half never re-enter; the team plays short
  const inactive = starters.filter((p) => resume?.playerState[p.id]?.cards.sentOff === true);
  const players = starters.filter((p) => !inactive.includes(p));
  const shortBy = inactive.length;
  const sentOffMul = Math.max(0.3, 1 - CAL.sentOffPenalty * shortBy);

  // no position field on SquadPlayer — GK is the strongest gk-attribute composite
  const gk = players.reduce((best, p) => {
    const g = (x: ActivePlayer) => x.sp.attributes.gkReflexes + x.sp.attributes.gkPositioning + x.sp.attributes.gkDistribution;
    return g(p) > g(best) ? p : best;
  });
  gk.isGk = true;
  const outfield = players.filter((p) => !p.isGk);

  const meanFatigue = mean(players.map((p) => p.startFatigue));
  const fatigueMul = 1 - CAL.fatigueAttackPenalty * meanFatigue;

  const a = (f: (x: Attributes) => number): number => attrMean(outfield, f);
  return {
    side,
    tactics,
    players,
    inactive,
    gk,
    attack: sentOffMul * fatigueMul *
      a((x) => x.finishing * 0.3 + x.offTheBall * 0.2 + x.dribbling * 0.15 + x.vision * 0.15 + x.pace * 0.2),
    defense: sentOffMul * (
      0.85 * a((x) => x.tackling * 0.25 + x.marking * 0.25 + x.positioning * 0.2 + x.anticipation * 0.2 + x.strength * 0.1) +
      0.15 * ((gk.sp.attributes.gkReflexes + gk.sp.attributes.gkPositioning) / 40)),
    control: fatigueMul * a((x) => x.passing * 0.3 + x.vision * 0.2 + x.decisions * 0.2 + x.firstTouch * 0.15 + x.workRate * 0.1 + x.stamina * 0.05),
    // `?? passing` tolerates pre-split attribute blobs (longPassing lands with the pipeline)
    longPass: a((x) => (x.longPassing ?? x.passing) * 0.85 + x.vision * 0.15),
    aerial: a((x) => x.heading * 0.4 + x.jumping * 0.4 + x.strength * 0.2),
    press: 0.5 * tactics.team.pressTrigger + 0.5 * mean(outfield.map((p) => p.pt.instructions.pressingIntensity)),
    risk: mean(outfield.map((p) => p.pt.instructions.riskAppetite)),
    cross: mean(outfield.map((p) => p.pt.instructions.crossBias)),
    aggression: a((x) => x.aggression),
    tempo: tactics.team.tempo,
    lineHeight: tactics.team.lineHeight,
    meanFatigue,
  };
}

const PHASE_MIX_IN: Array<[Phase, number]> = [
  ['buildUp', 0.3],
  ['progression', 0.35],
  ['finalThird', 0.25],
  ['counterAttack', 0.1],
];
const PHASE_MIX_OUT: Array<[Phase, number]> = [
  ['defensiveBlock', 0.8],
  ['counterPress', 0.2],
];

/** Team-relative 12×8 grid (row-major), gaussian splats on phase-blended anchors. */
function heatmapFor(p: ActivePlayer, possFrac: number): number[] {
  const { heatmapCols: C, heatmapRows: R } = CAL;
  const cells = new Array<number>(C * R).fill(0);
  const sigma = 6 + 8 * (1 - p.pt.instructions.holdPosition);
  const mix: Array<[Phase, number]> = [
    ...PHASE_MIX_IN.map(([ph, w]) => [ph, w * possFrac] as [Phase, number]),
    ...PHASE_MIX_OUT.map(([ph, w]) => [ph, w * (1 - possFrac)] as [Phase, number]),
  ];
  for (const [phase, w] of mix) {
    const c = p.pt.anchors[phase];
    for (let row = 0; row < R; row++) {
      for (let col = 0; col < C; col++) {
        const cx = ((col + 0.5) * 105) / C;
        const cy = ((row + 0.5) * 68) / R;
        const d2 = (cx - c.x) ** 2 + (cy - c.y) ** 2;
        cells[row * C + col] += w * Math.exp(-d2 / (2 * sigma * sigma));
      }
    }
  }
  const total = cells.reduce((s, x) => s + x, 0);
  return cells.map((x) => round(x / total, 4));
}

const PASS_FLIGHT_TABLE: Array<[BallFlight, number]> = [
  ['ground', 0.45],
  ['driven', 0.25],
  ['lofted', 0.2],
  ['high', 0.1],
];

/**
 * Fabricated replay frames (this engine has no spatial sim — frames are
 * cosmetic and read by nothing but the viewer).
 *
 * The 2026-08 rework, after the smooth viewer exposed the old fabrication:
 *  - players used to get IID gauss noise around the anchor EVERY keyframe —
 *    interpolation turned that into perpetual oscillation (the "yoyo").
 *    Now each player carries a persistent offset plus a momentum wander:
 *    calm drift, held shape.
 *  - the ball used to random-walk detached from everyone (sigma 9m/frame — in
 *    open space nearly always). Now possession is fabricated: a carrier
 *    HOLDS the ball at his feet for a few frames, passes to a teammate,
 *    occasionally loses it (a loose frame, then the other side picks up) —
 *    and the frame emits `carrier` so the viewer glues ball to player.
 */
function fabricateFrames(rng: Rng, t0: number, tiltH: number, home: TeamCtx, away: TeamCtx) {
  const frames = [];
  const n = Math.floor(HALF_SECONDS / CAL.frameDt);

  const offsets = new Map<string, Vec2>();
  const wander = new Map<string, Vec2>();
  for (const p of [...home.players, ...away.players]) {
    offsets.set(p.id, { x: rng.gauss(0, 1.2), y: rng.gauss(0, 1.2) });
    wander.set(p.id, { x: 0, y: 0 });
  }

  const pHome = clamp(0.3 + (tiltH / 100) * 0.4, 0.3, 0.7); // tilt biases who has it
  let side: TeamCtx = rng.float() < pHome ? home : away;
  let carrier: ActivePlayer | null = null;
  let holdLeft = 0;
  let bx = 52.5;
  let by = 34;

  const pickCarrier = (t: TeamCtx): ActivePlayer => {
    const outfield = t.players.filter((p) => !p.isGk);
    const pool = outfield.length > 0 ? outfield : t.players;
    return pool[Math.min(pool.length - 1, Math.floor(rng.float() * pool.length))];
  };

  for (let k = 0; k < n; k++) {
    const t = t0 + k * CAL.frameDt;

    // possession bookkeeping: hold, then pass (same side) or turn over
    // (one loose frame, then the other side picks up)
    let changed = false;
    if (holdLeft <= 0) {
      changed = true;
      if (carrier && rng.float() < 0.3) {
        side = side === home ? away : home;
        carrier = null; // loose ball this frame — the transition is a state
        holdLeft = 1;
      } else {
        carrier = pickCarrier(side);
        holdLeft = 1 + Math.floor(rng.float() * 3);
      }
    }
    holdLeft--;

    // coarse phase from the ball (global frame): home attacks +x
    const homePhase: Phase = bx < 35 ? 'buildUp' : bx < 70 ? 'progression' : 'finalThird';
    const awayPhase: Phase = bx > 70 ? 'buildUp' : bx > 35 ? 'progression' : 'finalThird';
    const players: Record<string, Vec2> = {};
    const place = (id: string, a: Vec2): void => {
      const off = offsets.get(id)!;
      const w = wander.get(id)!;
      // momentum wander: mostly keep going, gently redirect — a drift
      w.x = clamp(w.x * 0.8 + rng.gauss(0, 0.6), -2.5, 2.5);
      w.y = clamp(w.y * 0.8 + rng.gauss(0, 0.6), -2.5, 2.5);
      players[id] = {
        x: round(clamp(a.x + off.x + w.x, 0, 105), 1),
        y: round(clamp(a.y + off.y + w.y, 0, 68), 1),
      };
    };
    for (const p of home.players) place(p.id, p.pt.anchors[homePhase]);
    for (const p of away.players) place(p.id, flip(p.pt.anchors[awayPhase]));

    let flight: BallFlight = 'ground';
    if (carrier) {
      // at the carrier's feet — within a stride of the dot
      const cp = players[carrier.id];
      bx = clamp(cp.x + rng.gauss(0, 0.35), 0, 105);
      by = clamp(cp.y + rng.gauss(0, 0.35), 0, 68);
      if (changed) flight = PASS_FLIGHT_TABLE[rng.weighted(PASS_FLIGHT_TABLE.map(([, w]) => w))][0];
    } else {
      // loose: the ball travels toward the side that will pick it up
      bx = clamp(bx + rng.gauss(side === home ? -6 : 6, 5), 2, 103);
      by = clamp(by + rng.gauss(0, 5), 2, 66);
      flight = PASS_FLIGHT_TABLE[rng.weighted(PASS_FLIGHT_TABLE.map(([, w]) => w))][0];
    }

    frames.push({
      t: round(t, 1),
      ball: { x: round(bx, 1), y: round(by, 1), flight },
      carrier: carrier?.id ?? null,
      players,
    });
  }
  return frames;
}
