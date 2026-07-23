/**
 * decide.ts — L4 on-ball decisions (spec §5-L4): the carrier continuously
 * evaluates carry / pass / shoot / shield / clear by expected value against
 * the ACTUAL world state (real defender positions, real lane geometry).
 *
 * Design contract (spec §3): the situation and instructions bias the CHOICE;
 * attributes govern the EXECUTION (noisyKick, touches — L3's machinery).
 * Decisions are pure and deterministic — same state, same choice. Execution
 * noise is where randomness lives.
 *
 * Value scale: 1.0 ≡ a goal. Possession value (PV) lives in [0, ~0.35] and
 * every non-shot action is further discounted by POSSESSION_DISCOUNT —
 * holding the ball is worth a FRACTION of a shot's xG. This is what makes
 * striker-shoots-by-construction hold natively: no role flag, just EV.
 */

import { PITCH, type BodyState, type Vec2 } from './engine2-types.ts';
import { loftFlightTimeS, rollLaunchForArrival, rollSpeedAfter, rollTimeToDistance, solveLoftSpeed, type BallState } from './ball.ts';
import { KIN, regimeCapMps } from './kinematics.ts';

/** goal mouths: home attacks +x (goal at x=105), away attacks −x (x=0) */
/** L5E — the duel state machine's numbers (design: L5E-DESIGN.md). The
 * distance bands are solved JOINTLY: hold < arcLow < engage <= arcHigh — the
 * July build died because these were tuned separately and nothing ever
 * engaged (the no-man's band). They move together or not at all. */
export const DUEL = {
  activeRangeM: 8, // a chaser this near an opponent carrier is IN the duel
  /** activation LEADS the closing: a carrier driving at you at 6 m/s puts you
   * in the duel from ~15 m — you start dropping and build goalward momentum
   * BEFORE he arrives (a defender met flat-footed or stepping toward a
   * full-pace attacker is the easiest man in football to pass) */
  activeCloseGainS: 1.2,
  holdM: 2.0, // the jockey's hold distance, on the carrier→goal line
  arcLowM: 2.2, // the attacker's working arc (knock-and-go reads these)
  arcHighM: 2.7,
  engageM: 2.6, // commit range — inside the attacker's arc, one step from hold
  trackEnterMps: 4.5, // carrier at pace → full-speed goal-side TRACK...
  trackExitMps: 3.5, // ...back to JOCKEY only when he slows (hysteresis)
  jockeyCapMps: 4.5, // the backpedal/shuffle cap while jockeying
  recoverAheadM: 3, // the cut-off point ahead of a carrier you're trailing
  goalSideEnterM: 0.2, // side hysteresis: gain the side clearly...
  goalSideExitM: 0.8, // ...lose it only clearly
  /** the patience meter: pressure fills over ~3.5 s of pure jockey (waiting
   * is hoping for support; support may never come), faster on a STOPPED
   * carrier (the lunge invitation) and with cover behind */
  pressureFillS: 3.5,
  pressureStoppedFactor: 3,
  pressureSupportFactor: 1.8,
  dCoverM: 12,
  /** II.7 — the second man's spot BEHIND the press, on the carrier→goal
   * line (deep enough to meet the carry-around, inside dCoverM so the
   * presser's patience feels the support), shaded to the arc side */
  coverBehindM: 6,
  coverShadeM: 1.5,
  /** the mark's L (I.1): goal-side of his man, a stride off — close
   * enough to press the touch, goal-side enough to never be run past —
   * and shaded BALL-side to sit against the lane (I.13) */
  markGoalSideM: 1.8,
  markBallShadeM: 0.9,
  /** the ANTICIPATORY mark (builder physics, Jul 23 — the duel's
   * momentum rule applied to marking): a marker who steps toward his
   * man is too late on the dart by momentum alone. The station DROPS
   * goal-side with the man's goalward speed (the buffer IS the
   * anticipation, and retreating with the rising threat gives the
   * marker goalward momentum BEFORE the race), and the ball-shade
   * FADES with it — contest the feet ball on a static outlet, concede
   * feet and deny in-behind on a runner. */
  markDropGainS: 0.8,
  markShadeFadeMps: 3,
  engageEscapeM: 3.5, // the carrier breaks this far → the engage is over
  pressureResetOnEscape: 0.3,
  /** the failed lunge is the BEATEN moment: planted ~0.8 s. Without it,
   * repeated 27% tackles compound to inevitability over any crawl (16/16
   * defender wins vs elite close control — the July measurement). */
  staggerTicks: 8,
  /** after the plant, the BEATEN window: he shadows (recover/jockey) but
   * cannot re-ENGAGE — one beat buys real freedom (with cover a mate takes
   * over; a lone man cannot both recover and immediately lunge again). This
   * breaks the cycle-compounding that re-fronted every stagger into
   * inevitability (close control through 1/16 without it). */
  beatenTicks: 25,
  /** the KNOCK-AND-GO: the utility gain on the reclaim point's value — the
   * burst past a jockey is the attacker's half of the duel */
  knockGain: 1.2, // tempered — the chance-creation term carries the value
  /** the BEAT sequence (approach→feint→burst) — the manufactured knock:
   * when the lane past a SET rider is closed, the feint on his smoothed-read
   * lag opens it. Priced like the knock it becomes, times the feint's
   * success (attacker agility+dribbling vs the defender's agility). */
  beatFeintBase: 0.5,
  beatFeintSkill: 0.5,
  /** past the last man, unmarked: a free run at goal is worth far more than
   * the ground it stands on */
  freeRunBonus: 0.1,
} as const;

export const GOAL = {
  mouthHalfWidthM: 3.66,
  centerY: PITCH.width / 2,
  barZ: 2.44, // crossbar — a ball over it is not a goal (and not saveable)
  /** the penalty area — where the keeper's HANDS are legal */
  boxDepthM: 16.5,
  boxHalfWidthM: 20.16,
} as const;

export interface PlayInstructions {
  /** 0 = safety-first, 1 = speculative — biases the turnover penalty and the
   * completion floor a pass must clear (spec: risk visibly shifts choices) */
  risk?: number;
  /** 'score' (default) values progress toward goal; 'keep' is the rondo's
   * truth — value SPACE and retention, never shoot or clear */
  objective?: 'keep' | 'score';
  /** L5c line height, 0..1 (defensive.md): 0 = low block (sit at home),
   * 1 = high line (squeeze up with the ball). Default 0.5 — a mid block.
   * The first tactics knob: L6 will set these per role/team. */
  lineHeight?: number;
  /** L5d organized pressing appetite, 0..1. DEFAULT 0 — shape-holders
   * never step out unless instructed (counterpress is separate and
   * innate: transition instinct, not organization). */
  pressing?: number;
}

export type Intent =
  | { kind: 'carry'; target: Vec2; regime: 'run' | 'sprint'; utility: number; dir: number }
  | { kind: 'pass'; receiverId: string; dest: Vec2; speedMps: number; utility: number; loftDeg?: number; spin?: number }
  | { kind: 'shoot'; dest: Vec2; speedMps: number; utility: number; loftDeg?: number }
  | { kind: 'knock'; dest: Vec2; speedMps: number; utility: number }
  | { kind: 'beat'; dest: Vec2; side: number; utility: number }
  | { kind: 'shield'; utility: number }
  | { kind: 'clear'; dest: Vec2; speedMps: number; utility: number };

export const DECIDE = {
  /** re-evaluation cadence (ticks) — continuous but not per-tick (spec §3) */
  reconsiderTicks: 3,
  /** commitment inertia, RELATIVE: a new intent must beat the current one
   * by this fraction (absolute costs were mis-sized at every utility scale
   * — three separate judged behaviors were each blocked by a hair) */
  switchCostRel: 0.08,
  switchCostAbsFloor: 0.004,
  /** possession is not a goal: every non-shot EV is scaled by this */
  possessionDiscount: 0.55,
  /** PV: the most valuable non-shot spot on the pitch is worth this */
  pvMax: 0.35,
  /** carry sampling: directions × this lookahead (valuation distance) */
  carryLookaheadM: 6.0,
  /** the carry COMMAND runs through the valued point to here — arriving is
   * the reconsideration's job, not the leg's */
  carryCommandM: 16.0,
  carryDirections: 8,
  /** pressure at the carry destination discounts its PV — sized to a
   * SPRINTING defender's one-second reach, not his tackle radius (at 4 m
   * the carry stayed attractive until the lane and the release were dead) */
  carryPressureRangeM: 7.0,
  /** pass speeds clamp (firm floor — lofted/driven variety is later) */
  passSpeedMin: 8,
  // realistic drag eats pace off a long ball fast, so the ceiling rises: a
  // 40 m pass to arrive collectable now needs ~22 m/s at the boot (was ~13
  // under the old weak friction). Driven long passes live here.
  passSpeedMax: 19,
  /** pass WEIGHT: launch speed chosen so the ball ARRIVES at the receiver
   * around this pace and dies just beyond him — the old linear formula hit
   * every ball to arrive at full pace and roll 60 m when a receive missed */
  passArriveMps: 5.5,
  /** the lane margin (s) an opponent needs to make the intercept — sampled
   * against ball travel time along the lane */
  laneSampleStep: 0.15, // fraction of the lane per sample
  interceptReachM: 1.1,
  /** turnover penalty weight — scaled DOWN by the risk instruction */
  turnoverBase: 0.9,
  turnoverRiskGain: 0.55,
  /** completion floor a pass must clear, risk-scaled */
  passFloorBase: 0.8, // a safety-first player wants near-certainty (re-seated as the lane model got honest)
  passFloorRiskGain: 0.45, // speculative feet barely have a floor
  /** the speculative player's thumb on the scale: risk WEIGHTS the payoff
   * of progressive balls (a safe square ball's EV honestly beats a 55%
   * through ball — direct players choose it anyway, and that preference IS
   * the instruction) */
  riskProgressGain: 2.0,
  /** a pass is not a lossless value teleport — receiver settle + tempo cost.
   * Without it a square ball to an equal spot edged out carrying forward */
  passFriction: 0.85,
  /** the EV's view of the backheel: completion odds fall for strikes beyond
   * 90° off facing (execution noise/power degrade in noisyKick to match) */
  backheelEvLossMax: 0.5,
  /** turn-before-strike only for balls genuinely BEHIND the body — a
   * 45–90° side-foot is standard play, struck without turning (judged) */
  strikeTurnThresholdRad: 1.75,
  /** carrying near defenders risks the TACKLE — without this term dodging
   * always beat releasing, and the safe pass never happened (the judged
   * corner-dodge). Risk-scaled like the pass turnover penalty. */
  carryTurnoverGain: 0.5,
  /** shooting */
  shootRangeM: 30, // considered from range — the EV decides if it's worth it
  shotSpeedMps: 22,
  xgDistHalfM: 13, // xG halves around this distance
  xgDistScaleM: 5,
  xgBlockerFactor: 0.6,
  /** clear: only under pressure deep in own territory */
  clearMaxX: 0.35, // fraction of pitch length (own end)
  clearPressureM: 3.0,
  clearUtility: 0.06,
  shieldUtility: 0.03,
  /** LOFTED ball: a driven loft (low angle) is the accurate, fast aerial
   * through ball; a chip (steeper) clears a nearer man. Aerial control is
   * harder than a ground receive — the drop is taxed by first touch. */
  loftDrivenDeg: 24,
  loftChipDeg: 42,
  aerialControlBase: 0.5,
  aerialControlTouchGain: 0.02,
  /** the CROSS: a wide, advanced carrier whips an aerial ball into the box for
   * an attacker's run — a DRIVEN (fast, flat) or FLOATED (high, hang-time)
   * delivery, both solved to land on his run. Fires from wide + advanced into a
   * box target; unlike the loft it needs no blocked lane — the cross IS the
   * ball into the danger zone. The EV picks driven vs floated by who completes. */
  crossWideM: 13, // carrier at least this far off centre (a flank position)
  crossAdvanceM: 32, // and within this of the byline (the attacking flank)
  crossBoxM: 20, // the landing this near the opp goal, and central (the box)
  crossDrivenLoftDeg: 16,
  crossFloatLoftDeg: 34,
  /** the SWITCH of play (passing.md #7): a long FLOATED aerial from one flank
   * to a wide mate on the FAR side — over the congested middle, into the space
   * an overload left. Fires wide → far-wide at range; a hang-time ball he runs
   * onto. Escapes a compact/overloaded side the ground ball can't cross. */
  switchWideM: 13,
  switchMinM: 30,
  switchFloatLoftDeg: 38,
  /** ACROSS-GOAL finishing (L7): from an angle, the far corner's clear-lane
   * score earns this bonus — the keeper shades his near post, so across him is
   * the open side (and the longer dive). Central shooters have no "across". */
  shotAcrossBonus: 0.8,
  /** the CHIP over a rushed-out keeper — the 1v1's counter. The utility bonus
   * scales with how far OFF HIS LINE the guard is (4 m → 0, 12 m → full). */
  chipLoftDeg: 38,
  chipBaseValue: 0.45, // an uncoverable chip ≈ a half-chance at worst
  chipKeeperOutGain: 0.25,
  /** the DRIVE credit for an UNPRESSURED carrier (progression valued like a
   * pass's) and the pressure ceiling under which it applies */
  driveGain: 1.2,
  drivePressureCeil: 0.2,
  /** within this of goal, a toward-goal carry drives even under pressure —
   * a striker takes on the last line for a shot rather than drifting wide */
  driveAtGoalM: 28,
  /** ...and only when the carrier is off-centre by more than this: a WIDE
   * striker drives in toward the goal line; a central one already has his
   * angle and shoots (the breakaway property). He stops driving once central. */
  driveWideM: 6,
} as const;

export const attackSign = (team: 'home' | 'away'): 1 | -1 => (team === 'home' ? 1 : -1);

export const goalCenter = (team: 'home' | 'away'): Vec2 =>
  ({ x: attackSign(team) > 0 ? PITCH.length : 0, y: GOAL.centerY });

/** positional value of holding the ball at p, attacking toward sign — an
 * authored field: monotone toward the opponent's goal, boosted centrally in
 * the final third, in [0, pvMax]. Goal PROXIMITY outweighs raw x-progress —
 * progress-heavy weights judged as wingers driving to the corner flag */
export const posValue = (p: Vec2, team: 'home' | 'away'): number => {
  const g = goalCenter(team);
  const progress = attackSign(team) > 0 ? p.x / PITCH.length : 1 - p.x / PITCH.length;
  const dGoal = Math.hypot(g.x - p.x, g.y - p.y);
  const nearGoal = Math.exp(-dGoal / 24);
  return DECIDE.pvMax * (0.4 * progress + 0.6 * nearGoal);
};

/** retention value for the 'keep' objective: space from the nearest
 * opponent, TETHERED to the drill station — without the anchor the optimal
 * rondo is to flee the square forever (the judged corner sprint) */
export const keepValue = (p: Vec2, opponents: readonly BodyState[], home?: Vec2): number => {
  let nearest = Infinity;
  for (const o of opponents) {
    nearest = Math.min(nearest, Math.hypot(o.pos.x - p.x, o.pos.y - p.y));
  }
  const space = Math.min(1, nearest / 8);
  const tether = home ? Math.min(1, Math.hypot(home.x - p.x, home.y - p.y) / 12) : 0;
  return DECIDE.pvMax * Math.max(0, space - 0.8 * tether);
};

/** authored xG from real geometry: distance, mouth opening angle, and bodies
 * (either team) blocking the line — no dice, no roles */
export const xG = (from: Vec2, team: 'home' | 'away', others: readonly BodyState[]): number => {
  const g = goalCenter(team);
  const d = Math.hypot(g.x - from.x, g.y - from.y);
  if (d < 0.5) return 0.95;
  const distFactor = 1 / (1 + Math.exp((d - DECIDE.xgDistHalfM) / DECIDE.xgDistScaleM));
  // opening angle of the mouth from here vs the max (head-on at the spot)
  const a1 = Math.atan2(g.y - GOAL.mouthHalfWidthM - from.y, g.x - from.x);
  const a2 = Math.atan2(g.y + GOAL.mouthHalfWidthM - from.y, g.x - from.x);
  let open = Math.abs(a2 - a1);
  if (open > Math.PI) open = 2 * Math.PI - open;
  const angleFactor = Math.min(1, open / 0.62); // ~the penalty-spot opening
  let blockers = 0;
  let pointBlank = false;
  for (const o of others) {
    const t = ((o.pos.x - from.x) * (g.x - from.x) + (o.pos.y - from.y) * (g.y - from.y)) / (d * d);
    if (t <= 0 || t >= 0.95) continue;
    const px = from.x + t * (g.x - from.x);
    const py = from.y + t * (g.y - from.y);
    const along = t * d;
    // the block corridor TAPERS: a nearby defender must be square on the
    // line to block; a distant one shadows more of the mouth (the flat
    // 0.9 m corridor made any loitering body a shot veto — the judged
    // never-shoots-near-anyone)
    const corridor = 0.45 + 0.055 * along;
    if (Math.hypot(o.pos.x - px, o.pos.y - py) < corridor) {
      blockers++;
      if (along < 2.0) pointBlank = true;
    }
  }
  const raw = distFactor * angleFactor * DECIDE.xgBlockerFactor ** blockers;
  // point-blank is a heavy discount, not a veto — shots go through legs
  return Math.min(0.95, pointBlank ? raw * 0.35 : raw);
};

/** completion probability of a pass along carrier→dest at speedMps, judged
 * against ACTUAL opponent positions: sample the lane; an opponent beats the
 * ball to a sample point if his running time (plus reaction) undercuts the
 * ball's arrival there. The tightest margin sets the risk. */
export const passCompletion = (
  from: Vec2,
  dest: Vec2,
  speedMps: number,
  opponents: readonly BodyState[],
  receiverDist: number,
  receiver?: BodyState,
  passerSkill = 12,
): number => {
  const d = Math.hypot(dest.x - from.x, dest.y - from.y);
  if (d < 0.5) return 0.2; // a pass to your own feet is not a pass
  let worst = Infinity; // seconds of margin the ball holds over the best interceptor
  // sample to EXACTLY f=1.0 — a step grid stopping at 0.9 left the final
  // two meters of every pass unsampled, making tight marks on the receiver
  // invisible to the model (the audit class: unreachable code regions)
  const nSamples = Math.round(1 / DECIDE.laneSampleStep);
  for (let k = 1; k <= nSamples; k++) {
    const f = k / nSamples;
    const px = from.x + (dest.x - from.x) * f;
    const py = from.y + (dest.y - from.y) * f;
    const seg = d * f;
    // ball speed & travel time at this sample, from the SAME a=A+B·v² physics
    // stepBall runs (closed-form — no constant-decel fiction)
    const ballHere = rollSpeedAfter(speedMps, seg);
    if (ballHere <= 0) break; // the ball dies before this sample
    const tBall = rollTimeToDistance(speedMps, seg);
    const runTime = (b: BodyState, tx: number, ty: number, reactS: number): number => {
      const d = Math.max(0, Math.hypot(b.pos.x - tx, b.pos.y - ty) - DECIDE.interceptReachM);
      const v = Math.max(regimeCapMps(b.attributes.pace, 'sprint'), 1);
      // acceleration-honest running time (the flat d/vmax model doubled the
      // interception threat and killed every rondo lane): accelerate at the
      // body's real peak, cruise at vmax beyond the ramp distance
      const a = KIN.accelBase + KIN.accelPerPoint * b.attributes.acceleration;
      const ramp = (v * v) / (2 * a);
      return reactS + (d <= ramp ? Math.sqrt((2 * d) / a) : v / (2 * a) + d / v);
    };
    for (const o of opponents) {
      // judge the lane against where the defender WILL be when the ball
      // passes AND where he stands — projection alone let a chaser mid-turn
      // be rated off the lane he then turned and cut (the rondo's death);
      // momentum doesn't delete the man
      const proj = Math.min(tBall, 0.8);
      const ox = o.pos.x + o.vel.x * proj;
      const oy = o.pos.y + o.vel.y * proj;
      const dProj = Math.max(0, Math.hypot(ox - px, oy - py) - DECIDE.interceptReachM);
      const dNow = Math.max(0, Math.hypot(o.pos.x - px, o.pos.y - py) - DECIDE.interceptReachM);
      const dOpp = Math.min(dProj, dNow);
      const vOpp = Math.max(regimeCapMps(o.attributes.pace, 'sprint'), 1);
      const a = KIN.accelBase + KIN.accelPerPoint * o.attributes.acceleration;
      const ramp = (vOpp * vOpp) / (2 * a);
      const tRun = dOpp <= ramp ? Math.sqrt((2 * dOpp) / a) : vOpp / (2 * a) + dOpp / vOpp;
      // reacting to CUT a fast ball is harder than stepping on a roller —
      // the second half of "driven passes are harder to intercept"
      // (passing.md #13; the flat 0.35 s made every zipped diagonal
      // cuttable and the multi-line ball never existed)
      const tOpp = 0.35 + 0.01 * Math.max(0, ballHere - 8) + tRun;
      // the lane's TAIL belongs to the receiver: a defender the receiver
      // beats to a late sample isn't cleanly intercepting — he's arriving
      // into a contested receive. Soften his threat rather than void it (a
      // marker standing ON the receiver still taxes the ball).
      const protectedTail = receiver !== undefined && f > 0.7 &&
        runTime(receiver, px, py, 0.1) <= tOpp;
      worst = Math.min(worst, tOpp - tBall + (protectedTail ? 0.35 : 0));
    }
  }
  // margin → probability: a lane the defenders miss by ≥0.6 s is safe; a
  // lane they beat by ≥0.4 s is dead. The PASSER'S precision buys margin —
  // an elite weight/line arrives where and when planned (the De Bruyne
  // term: he attempts the ball because HIS version of it completes)
  const precision = (passerSkill - 14) * 0.02; // baseline pro = 14; only the true elite buy real margin
  const p = (worst + precision + 0.4) / 1.0;
  const lane = Math.max(0.02, Math.min(0.98, p));
  // long balls complete less even into space (execution noise grows with
  // distance) — but an OPEN 35m lane is still a good ball; the old 18m soft
  // cap taxed every through ball to death regardless of the lane
  const range = 1 / (1 + Math.max(0, receiverDist - 26) / 30);
  return lane * range;
};

/** completion of a LOFTED ball to `landing`: it flies OVER ground defenders
 * in the middle of the flight, so the contest is the DROP — an arrival race
 * at the landing between the receiver and the nearest defender to it. The
 * mid-lane blocker that kills the ground ball is irrelevant to the air one. */
export const aerialCompletion = (
  landing: Vec2,
  mate: BodyState,
  opponents: readonly BodyState[],
): number => {
  const dMate = Math.hypot(mate.pos.x - landing.x, mate.pos.y - landing.y);
  let nearest = Infinity;
  for (const o of opponents) {
    nearest = Math.min(nearest, Math.hypot(o.pos.x - landing.x, o.pos.y - landing.y));
  }
  // metre margin at the drop (receiver closer than any defender = safe); the
  // receiver reads the flight and gets under it, a defender must recover to it
  const margin = nearest - dMate;
  return 1 / (1 + Math.exp(-(margin - 0.5) / 2.0));
};

/** L5a — the support spot: where an off-ball teammate should stand so the
 * carrier HAS a ball to play. The same lane model the carrier uses,
 * pointed the other way: value × lane-openness, tethered to a home that
 * deforms toward the ball, spaced off teammates. */
export const supportSpot = (
  mate: BodyState,
  carrier: BodyState,
  bodies: readonly BodyState[],
  home: Vec2,
  objective: 'keep' | 'score',
): Vec2 => {
  const opponents = bodies.filter((b) => b.team !== mate.team);
  const mates = bodies.filter((b) => b.team === mate.team && b.id !== mate.id);
  // the home DEFORMS toward the ball (structure follows play)
  const dx = carrier.pos.x - home.x;
  const dy = carrier.pos.y - home.y;
  const dd = Math.hypot(dx, dy) || 1;
  const shift = Math.min(dd * 0.3, objective === 'keep' ? 3 : 8);
  const base = { x: home.x + (dx / dd) * shift, y: home.y + (dy / dd) * shift };
  let best: Vec2 = base;
  let bestU = -Infinity;
  for (let i = -1; i < 8; i++) {
    const cand = i < 0 ? base : {
      x: base.x + Math.cos((i / 8) * Math.PI * 2) * 3.5,
      y: base.y + Math.sin((i / 8) * Math.PI * 2) * 3.5,
    };
    if (cand.x < 1 || cand.x > PITCH.length - 1 || cand.y < 1 || cand.y > PITCH.width - 1) continue;
    const dist = Math.hypot(cand.x - carrier.pos.x, cand.y - carrier.pos.y);
    if (dist < 4) continue; // an outlet is not a crowd around the carrier
    const lane = passCompletion(carrier.pos, cand, rollLaunchForArrival(6, dist), opponents, dist, mate);
    const val = objective === 'keep' ? keepValue(cand, opponents, home) : posValue(cand, mate.team);
    let crowd = 0;
    for (const m of mates) {
      const md = Math.hypot(m.pos.x - cand.x, m.pos.y - cand.y);
      if (md < 6) crowd += (6 - md) / 6;
    }
    const u = lane * 0.6 + val * 1.2 - crowd * 0.12;
    if (u > bestU) {
      bestU = u;
      best = cand;
    }
  }
  return best;
};

/** L5b — the RUN: an off-ball attacker's timed burst in behind, riding the
 * last defender's line until the ball is played (the v1 line-riding
 * insight, now geometric). Returns the run plan or null when no run is on. */
export const runPlan = (
  mate: BodyState,
  carrier: BodyState,
  bodies: readonly BodyState[],
): { target: Vec2; lineX: number; dartY: number } | null => {
  const sign = attackSign(mate.team);
  const opponents = bodies.filter((b) => b.team !== mate.team);
  if (opponents.length === 0) return null;
  // the last defender's line (deepest opponent toward the attacked goal)
  const lineX = sign > 0
    ? Math.max(...opponents.map((o) => o.pos.x))
    : Math.min(...opponents.map((o) => o.pos.x));
  const goalX = sign > 0 ? PITCH.length : 0;
  // a run is ON when: room in behind, the runner is near enough to the
  // line to threaten it, and he is AHEAD of the carrier (channel runners,
  // not deep midfielders)
  const room = sign > 0 ? goalX - lineX : lineX - goalX;
  if (room < 12) return null;
  const distToLine = sign > 0 ? lineX - mate.pos.x : mate.pos.x - lineX;
  if (distToLine > 22 || distToLine < -2) return null;
  // ahead of the carrier — OR close enough to the line to beat it (the
  // one-two: the giver starts BEHIND his wall man and runs beyond)
  const aheadOfCarrier = sign > 0 ? mate.pos.x > carrier.pos.x + 2 : mate.pos.x < carrier.pos.x - 2;
  if (!aheadOfCarrier && distToLine > 12) return null;
  // the channel is a SEAM: ride between defenders (or off the outside
  // shoulder), never a defender's own lane — the ball in behind must have
  // somewhere to go (the judged drill: the runner rode the marker's
  // channel and every through ball died on the marker)
  const lineDefs = opponents.filter((o) => Math.abs(o.pos.x - lineX) < 6)
    .map((o) => o.pos.y).sort((a, b) => a - b);
  const seams: number[] = [];
  if (lineDefs.length) {
    // shoulder seams hug the defender (±4 — a channel run goes just off
    // the shoulder; ±8 dragged runners to the touchline, the judged
    // way-too-wide)
    seams.push(Math.max(8, lineDefs[0] - 4));
    for (let i = 0; i + 1 < lineDefs.length; i++) seams.push((lineDefs[i] + lineDefs[i + 1]) / 2);
    seams.push(Math.min(PITCH.width - 8, lineDefs[lineDefs.length - 1] + 4));
  } else seams.push(mate.pos.y);
  let chanY = mate.pos.y;
  let bestScore = -Infinity;
  for (const y of seams) {
    const clear = lineDefs.length ? Math.min(...lineDefs.map((d) => Math.abs(d - y))) : 10;
    const score = clear - 0.15 * Math.abs(y - GOAL.centerY) - 0.22 * Math.abs(y - mate.pos.y);
    if (score > bestScore) {
      bestScore = score;
      chanY = y;
    }
  }
  const target = { x: goalX - sign * 8, y: chanY };
  // the DART lane: the adjacent seam — a diagonal burst ACROSS a
  // defender's blind side into the next gap (the judged run shape:
  // behind d1, receiving between d1 and d2)
  let dartY = chanY;
  const chanClear = lineDefs.length ? Math.min(...lineDefs.map((d) => Math.abs(d - chanY))) : 10;
  if (chanClear < 3.5) {
    // the current seam is tight — dart ACROSS into the adjacent gap
    let bestDart = -Infinity;
    for (const y of seams) {
      if (Math.abs(y - chanY) < 2) continue;
      const clear = lineDefs.length ? Math.min(...lineDefs.map((d) => Math.abs(d - y))) : 10;
      const score = clear - 0.12 * Math.abs(y - GOAL.centerY) - 0.05 * Math.abs(y - chanY);
      if (score > bestDart) {
        bestDart = score;
        dartY = y;
      }
    }
  }
  // else: the seam IS the gap — dart STRAIGHT through it (the fastest
  // line, and the return between the defenders is the classic one-two)
  return { target, lineX, dartY };
};

/** L5c — the defensive SHAPE spot: where a defending brain stands so his
 * LINE defends as a unit. Three forces, in priority: hold the line's
 * shared depth (step/drop with the ball), shift laterally with the ball
 * (ball-side shift, spacing-capped), and bend toward the cover shadow
 * (sit in the lane between the carrier and the most dangerous runner in
 * your channel). Pressing is L5d's — the line slides, it does not chase. */
export const shapeSpot = (
  defender: BodyState,
  bodies: readonly BodyState[],
  ball: { pos: Vec2 },
  homes: ReadonlyMap<string, Vec2> | undefined,
  unit: readonly string[],
  lineHeight = 0.5,
): Vec2 => {
  const home = homes?.get(defender.id) ?? defender.pos;
  const dSign = attackSign(defender.team); // own goal = the END we attack FROM
  const ownGoalX = dSign > 0 ? 0 : PITCH.length;
  const opponents = bodies.filter((b) => b.team !== defender.team);
  // the LINE'S depth — shared by the unit (computed identically by each
  // member): hold the home line, but DROP goal-side of the ball when the
  // play advances (buffer 12 m), never shallower than 10 m from goal
  const unitHomes = unit.map((id) => homes?.get(id) ?? defender.pos);
  const homeLineX = dSign > 0
    ? Math.min(...unitHomes.map((h) => h.x))
    : Math.max(...unitHomes.map((h) => h.x));
  const ballBuffer = ball.pos.x - dSign * 12;
  let lineX = dSign > 0 ? Math.min(homeLineX, ballBuffer) : Math.max(homeLineX, ballBuffer);
  // STEP UP (defensive.md — the missing half of step/drop/hold): when the
  // ball is far, a high line squeezes toward it; a low block sits at home
  const stepped = dSign > 0
    ? Math.max(homeLineX, Math.min(ballBuffer, PITCH.length / 2))
    : Math.min(homeLineX, Math.max(ballBuffer, PITCH.length / 2));
  if ((dSign > 0 && ballBuffer > homeLineX) || (dSign < 0 && ballBuffer < homeLineX)) {
    lineX = homeLineX + (stepped - homeLineX) * lineHeight;
  }
  // NEVER step beyond the deepest attacker (no offside law until L9 — a
  // line past the striker doesn't trap him, it abandons him; the high
  // line's real teeth arrive with offside adjudication)
  const oppXs = opponents.map((o) => o.pos.x);
  if (oppXs.length) {
    const deepest = dSign > 0 ? Math.min(...oppXs) : Math.max(...oppXs);
    lineX = dSign > 0 ? Math.min(lineX, deepest - 1.2) : Math.max(lineX, deepest + 1.2);
  }
  // floor: do not retreat into the goal
  lineX = dSign > 0 ? Math.max(lineX, ownGoalX + 10) : Math.min(lineX, ownGoalX - 10);
  // ball-side shift, capped — the unit slides toward the ball together
  let y = home.y + Math.max(-7, Math.min(7, (ball.pos.y - home.y) * 0.4));
  // cover shadow: the most dangerous opponent in MY channel (deep, near my
  // lane) — bend toward the carrier→threat line at my depth
  let threat: BodyState | null = null;
  let threatScore = -Infinity;
  for (const o of opponents) {
    if (Math.abs(o.pos.y - home.y) > 9) continue;
    const depth = dSign > 0 ? -o.pos.x : o.pos.x; // deeper toward MY goal = bigger
    const score = depth - Math.abs(o.pos.y - home.y) * 0.5;
    if (score > threatScore) {
      threatScore = score;
      threat = o;
    }
  }
  if (threat) {
    const dx = threat.pos.x - ball.pos.x;
    if (Math.abs(dx) > 1e-6) {
      const t = (lineX - ball.pos.x) / dx;
      if (t > 0 && t < 1.2) {
        const laneY = ball.pos.y + (threat.pos.y - ball.pos.y) * t;
        y = y + (laneY - y) * 0.35;
      }
    }
  }
  // spacing: keep the unit ORDERED and apart (min 5.5 m) — identical
  // computation in every member keeps it consistent without messages
  const ordered = [...unit].sort((a, b) => (homes?.get(a)?.y ?? 0) - (homes?.get(b)?.y ?? 0));
  const idx = ordered.indexOf(defender.id);
  if (idx > 0) {
    const below = homes?.get(ordered[idx - 1]);
    if (below) {
      const belowY = below.y + Math.max(-7, Math.min(7, (ball.pos.y - below.y) * 0.4));
      y = Math.max(y, belowY + 5.5);
    }
  }
  return { x: lineX, y: Math.max(2, Math.min(PITCH.width - 2, y)) };
};

/** L5d — should THIS defender press the carrier now? Trigger-scored
 * (defensive.md): receive moments, sideline traps, isolation, plus raw
 * proximity — gated by the pressing instruction and first-defender
 * election (exactly one presser; the sim elects the nearest). Contact
 * itself is L3's contain/tackle machinery — pressing is the decision to
 * LEAVE SHAPE and close. */
export const pressScore = (
  defender: BodyState,
  carrier: BodyState,
  bodies: readonly BodyState[],
  justReceived: boolean,
  pressing: number,
): number => {
  const d = Math.hypot(carrier.pos.x - defender.pos.x, carrier.pos.y - defender.pos.y);
  const range = 12 + pressing * 10;
  if (d > range) return 0;
  let score = 0.3 + pressing * 0.4 + (1 - d / range) * 0.3;
  if (justReceived) score += 0.35; // press the touch (defensive.md: high)
  if (carrier.pos.y < 11 || carrier.pos.y > PITCH.width - 11) score += 0.25; // sideline trap
  const mates = bodies.filter((b) => b.team === carrier.team && b.id !== carrier.id);
  if (!mates.some((m) => Math.hypot(m.pos.x - carrier.pos.x, m.pos.y - carrier.pos.y) < 12)) score += 0.2; // isolated
  return score;
};

/** L5d — the SECOND defender's shadow spot: stand on the pressed
 * carrier's best escape lane (defender_runs' shadow press / passing lane
 * block): pick his most dangerous open mate and sit on that lane. */
export const shadowSpot = (
  defender: BodyState,
  carrier: BodyState,
  bodies: readonly BodyState[],
): Vec2 | null => {
  const mates = bodies.filter((b) => b.team === carrier.team && b.id !== carrier.id);
  if (!mates.length) return null;
  // the lane worth shadowing is the most OPEN dangerous one — judged by
  // completion odds WITHOUT me (the lanes my teammates already close
  // don't need me; the judged defect: posValue always picked the most
  // advanced man even when that lane was already dead)
  const others = bodies.filter((b) => b.team === defender.team && b.id !== defender.id);
  let best: BodyState | null = null;
  let bestVal = -Infinity;
  for (const m of mates) {
    const dist0 = Math.hypot(m.pos.x - carrier.pos.x, m.pos.y - carrier.pos.y);
    if (dist0 < 3) continue;
    const open = passCompletion(carrier.pos, m.pos, 11, others, dist0, m);
    const v = open * (0.4 + posValue(m.pos, carrier.team));
    if (v > bestVal) {
      bestVal = v;
      best = m;
    }
  }
  if (!best) return null;
  const t = 0.4; // on the lane, nearer the carrier (cuts early)
  return {
    x: carrier.pos.x + (best.pos.x - carrier.pos.x) * t,
    y: carrier.pos.y + (best.pos.y - carrier.pos.y) * t,
  };
};

/** L5d — press-unit COVERAGE: while the first defender presses, every
 * other member takes a DISTINCT assignment over the carrier's ranked
 * passing options (lane k → nearest free defender), leftovers compact
 * onto the unit's centroid-ball axis. Replaces the line-shape fallback
 * for pressing units — a goal-protecting LINE in a boundary grid put
 * all four pressers at one shared depth (the judged overlap and
 * useless coverage). */
export const pressCoverSpots = (
  carrier: BodyState,
  bodies: readonly BodyState[],
  coverIds: readonly string[],
): Map<string, Vec2> => {
  const out = new Map<string, Vec2>();
  if (!coverIds.length) return out;
  const defTeam = bodies.find((b) => b.id === coverIds[0])!.team;
  const mates = bodies.filter((b) => b.team === carrier.team && b.id !== carrier.id);
  const others = bodies.filter((b) => b.team === defTeam);
  // rank the carrier's options: openness × danger
  const lanes = mates.map((m) => {
    const dist0 = Math.hypot(m.pos.x - carrier.pos.x, m.pos.y - carrier.pos.y);
    const open = dist0 < 3 ? 0 : passCompletion(carrier.pos, m.pos, 11, others, dist0, m);
    return { m, score: open * (0.4 + posValue(m.pos, carrier.team)) };
  }).sort((a, b) => b.score - a.score);
  const free = new Set(coverIds);
  for (const lane of lanes) {
    if (!free.size) break;
    const spot = {
      x: carrier.pos.x + (lane.m.pos.x - carrier.pos.x) * 0.45,
      y: carrier.pos.y + (lane.m.pos.y - carrier.pos.y) * 0.45,
    };
    let best = '';
    let bestD = Infinity;
    for (const id of free) {
      const b = bodies.find((x) => x.id === id)!;
      const d = Math.hypot(b.pos.x - spot.x, b.pos.y - spot.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    out.set(best, spot);
    free.delete(best);
  }
  // leftovers: compact between the ball and the unit's centroid
  if (free.size) {
    let cx = 0;
    let cy = 0;
    for (const id of coverIds) {
      const b = bodies.find((x) => x.id === id)!;
      cx += b.pos.x;
      cy += b.pos.y;
    }
    cx /= coverIds.length;
    cy /= coverIds.length;
    for (const id of free) {
      out.set(id, { x: (carrier.pos.x + cx) / 2, y: (carrier.pos.y + cy) / 2 });
    }
  }
  return out;
};

/** L5d — the CURVED press approach (pressing.md's "wrong angle" failure
 * case: running straight at the ball leaves the lane open): close down
 * FROM the side of the lane being denied, so the presser's body shadows
 * the escape as he arrives — forcing play the other way. */
export const pressApproach = (
  defender: BodyState,
  carrier: BodyState,
  bodies: readonly BodyState[],
): Vec2 => {
  const lane = shadowSpot(defender, carrier, bodies);
  if (!lane) return { x: carrier.pos.x, y: carrier.pos.y };
  const lx = lane.x - carrier.pos.x;
  const ly = lane.y - carrier.pos.y;
  const ln = Math.hypot(lx, ly) || 1;
  return { x: carrier.pos.x + (lx / ln) * 1.4, y: carrier.pos.y + (ly / ln) * 1.4 };
};

/** L5E — the DEFENSIVE BRAIN (reference/defensive_principles.md): Part
 * III's decision hierarchy, run per defender per reconsider tick — is my
 * teammate already pressing? should I press? delay? cover? sit on the
 * lane? recover shape? — returning an INTENT the sim executes (and the
 * duel machine rides, for the presser). This skeleton extracts the
 * inline chain the sim grew, verbatim; the principles' refinements
 * (cover-behind-the-press, force direction, attribute dials, role
 * weights) land on it one measured change at a time. */
export type DefenseIntent =
  | { kind: 'press'; approach: Vec2 | null; label: 'press' | 'counterpress' }
  | { kind: 'delay'; hold: Vec2 }
  | { kind: 'cover'; target: Vec2 }
  | { kind: 'mark'; target: Vec2; urgent: boolean }
  | { kind: 'interceptLane'; target: Vec2 }
  | { kind: 'holdShape'; target: Vec2 };

export interface DefenseInput {
  defender: BodyState;
  carrier: BodyState;
  bodies: readonly BodyState[];
  ball: BallState;
  instructions: PlayInstructions;
  /** the defending UNIT: eligible brains on this team, defender included */
  unit: readonly BodyState[];
  /** the first-defender election's memory — who pressed last tick */
  pressingIds: ReadonlySet<string>;
  /** inside the transition window and near the ball (innate aggression) */
  inCounterpress: boolean;
  /** the carrier's first touches — press the touch (defensive.md) */
  justReceived: boolean;
  homes: ReadonlyMap<string, Vec2>;
}

export const decideDefense = (input: DefenseInput): DefenseIntent => {
  const { defender, carrier, bodies, ball, instructions, unit, pressingIds, inCounterpress, justReceived, homes } = input;
  const pressing = instructions.pressing ?? 0;
  // FIRST-DEFENDER election (principles IV: ONE man pressures the ball):
  // nearest eligible — STICKY for the incumbent unless clearly beaten
  // (flapping first/second made both look like ball-chasers)
  let nearest = unit.reduce((best, b) => {
    const d = Math.hypot(carrier.pos.x - b.pos.x, carrier.pos.y - b.pos.y);
    return d < best.d ? { id: b.id, d } : best;
  }, { id: '', d: Infinity });
  const incumbent = unit.find((b) => pressingIds.has(b.id));
  if (incumbent && incumbent.id !== nearest.id) {
    const di = Math.hypot(carrier.pos.x - incumbent.pos.x, carrier.pos.y - incumbent.pos.y);
    if (di < nearest.d + 4 && di < 14) nearest = { id: incumbent.id, d: di };
  }
  const iAmFirst = nearest.id === defender.id;
  const score = pressScore(defender, carrier, bodies, justReceived, pressing);
  const pressNow = inCounterpress || (iAmFirst && pressing > 0 && score >= 0.75 - 0.3 * pressing);
  const firstIsEngaged = pressingIds.has(nearest.id) || (iAmFirst && pressNow);
  const dCar = Math.hypot(carrier.pos.x - defender.pos.x, carrier.pos.y - defender.pos.y);
  if (pressNow) {
    // the CURVED approach: close from the denied lane's side (pressing.md:
    // a straight chase leaves the lane open); the last 3 m are the
    // machine's hunt (contain + tackles need the chase)
    const approach = dCar > 3 && !inCounterpress ? pressApproach(defender, carrier, bodies) : null;
    return { kind: 'press', approach, label: inCounterpress ? 'counterpress' : 'press' };
  }
  if (iAmFirst && pressing > 0 && dCar < 11) {
    // the DELAY stance (principles I.2: winning time beats winning the
    // ball): hold off goal-side ~4.5 m — slow the attack, await the trigger
    const gx = attackSign(defender.team) > 0 ? 0 : PITCH.length;
    const dx = gx - carrier.pos.x;
    const dy = GOAL.centerY - carrier.pos.y;
    const dn = Math.hypot(dx, dy) || 1;
    return { kind: 'delay', hold: { x: carrier.pos.x + (dx / dn) * 4.5, y: carrier.pos.y + (dy / dn) * 4.5 } };
  }
  // a PRESSING UNIT's non-engaged members take distinct assignments
  // (principles IV: second man covers) — and the FIRST cover duty is
  // II.7: protect BEHIND the press. A single pass or carry-around breaks
  // a press nobody stands behind (the covered-duel arc: the old leftover
  // rule compacted the second man toward the BALL — ball-watching, Part
  // VI — and the attacker rounded the pair). The second man sits on the
  // carrier→goal line behind the presser, shaded to the carrier's arc
  // side; lane spots only claim the men beyond him.
  // LINE units (pressing ≤ 0.3) keep L5c shape.
  if (pressing > 0.3 && firstIsEngaged) {
    const covers = unit.filter((b) => b.id !== nearest.id);
    const og = { x: attackSign(defender.team) > 0 ? 0 : PITCH.length, y: GOAL.centerY };
    const cf = { x: carrier.pos.x + carrier.vel.x * 0.4, y: carrier.pos.y + carrier.vel.y * 0.4 };
    const gd = Math.hypot(og.x - cf.x, og.y - cf.y) || 1;
    const tg = { x: (og.x - cf.x) / gd, y: (og.y - cf.y) / gd };
    // shade toward the side the carrier is arcing to
    const perp = { x: -tg.y, y: tg.x };
    const side = Math.sign(carrier.vel.x * perp.x + carrier.vel.y * perp.y) || 1;
    const depth = Math.min(DUEL.coverBehindM, gd - 0.5);
    const behind = {
      x: cf.x + tg.x * depth + perp.x * side * DUEL.coverShadeM,
      y: cf.y + tg.y * depth + perp.y * side * DUEL.coverShadeM,
    };
    // the MARK duties (principles IV third defender: watch runners — the
    // match-shaped-scenes finding: one unmarked outlet undoes the whole
    // press, 5-7/8 through in the 2v2 probe): free opponents ranked by
    // the same danger the lane logic prices
    const others = bodies.filter((b) => b.team === defender.team);
    const marks = bodies
      .filter((o) => o.team === carrier.team && o.id !== carrier.id)
      .map((o) => {
        const dist0 = Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y);
        const open = dist0 < 3 ? 0 : passCompletion(carrier.pos, o.pos, 11, others, dist0, o);
        return { o, danger: open * (0.4 + posValue(o.pos, carrier.team)) };
      })
      .filter((m) => m.danger > 0.05)
      .sort((a, b) => b.danger - a.danger);
    // the mark's L (I.1 + I.13): goal-side of the man AND shaded toward
    // the ball — behind-only marking watched 7-8/8 passes arrive freely
    // (the marker stood behind the receiver, contesting neither the lane
    // nor the touch)
    // the anticipation is AFFORDED by cover (builder physics, gated by
    // the measured trade): with a line behind you, drop off and ride the
    // run; as the LONE cover you stay touch-tight and gamble — the
    // ungated drop vacated the middle and the shorthanded 2v2 collapsed
    // 0/8 → 8/8 through
    const anticipate = covers.length > 1;
    const markSpot = (o: BodyState): Vec2 => {
      const md = Math.hypot(og.x - o.pos.x, og.y - o.pos.y) || 1;
      const bd = Math.hypot(carrier.pos.x - o.pos.x, carrier.pos.y - o.pos.y) || 1;
      // the run threat: his speed TOWARD my goal — the station drops with
      // it and the ball-shade fades (the anticipatory mark: never caught
      // leaning forward when the dart comes)
      const gws = anticipate ? Math.max(0, (o.vel.x * (og.x - o.pos.x) + o.vel.y * (og.y - o.pos.y)) / md) : 0;
      const depth2 = DUEL.markGoalSideM + gws * DUEL.markDropGainS;
      const shade = DUEL.markBallShadeM * Math.max(0, 1 - gws / DUEL.markShadeFadeMps);
      return {
        x: o.pos.x + ((og.x - o.pos.x) / md) * depth2 + ((carrier.pos.x - o.pos.x) / bd) * shade,
        y: o.pos.y + ((og.y - o.pos.y) / md) * depth2 + ((carrier.pos.y - o.pos.y) / bd) * shade,
      };
    };
    // duty assignment: MARKS first (danger order), behind-cover is the
    // SPARE man's job. With no spare, defense is man-for-man — the 1v1s
    // are accepted (a blended neither-duty spot defended nothing: the
    // measured 2v2 midpoint made the leak WORSE, 5-7/8 → 7-8/8). II.5's
    // press→cover→balance chain needs a third man to exist; zonal
    // balance-over-marking arrives with the L6 marking scheme.
    const free = new Set(covers.map((b) => b.id));
    const claim = (spot: Vec2): string => {
      let best = '';
      let bd = Infinity;
      for (const id of free) {
        const b = covers.find((x) => x.id === id)!;
        const d = Math.hypot(b.pos.x - spot.x, b.pos.y - spot.y);
        if (d < bd) { bd = d; best = id; }
      }
      free.delete(best);
      return best;
    };
    for (const m of marks) {
      if (!free.size) break;
      if (claim(markSpot(m.o)) === defender.id) {
        const md2 = Math.hypot(og.x - m.o.pos.x, og.y - m.o.pos.y) || 1;
        const gws2 = (m.o.vel.x * (og.x - m.o.pos.x) + m.o.vel.y * (og.y - m.o.pos.y)) / md2;
        return { kind: 'mark', target: markSpot(m.o), urgent: gws2 > 3 };
      }
    }
    if (free.size && claim(behind) === defender.id) return { kind: 'cover', target: behind };
    const spot = pressCoverSpots(carrier, bodies, [...free]).get(defender.id);
    if (spot) return { kind: 'cover', target: spot };
  } else if (!iAmFirst && firstIsEngaged && nearest.d < 6) {
    const lane = shadowSpot(defender, carrier, bodies);
    if (lane) return { kind: 'interceptLane', target: lane };
  }
  return {
    kind: 'holdShape',
    target: shapeSpot(defender, bodies, ball, homes, unit.map((b) => b.id), instructions.lineHeight ?? 0.5),
  };
};

export interface DecideInput {
  carrier: BodyState;
  bodies: readonly BodyState[];
  ball: BallState;
  instructions: PlayInstructions;
  current: Intent | null;
  /** drill stations (initial positions) — the 'keep' objective's anchors */
  homes?: ReadonlyMap<string, Vec2>;
  /** drill boundaries (positional grids): the EV never aims outside them
   * and weights balls to die inside */
  bounds?: { x0: number; y0: number; x1: number; y1: number };
  /** the goalkeepers on the pitch — a knock past a KEEPER must clear hands,
   * dive and sweep, not just feet (every striker knows who the keeper is) */
  keepers?: ReadonlySet<string>;
  /** defenders currently STAGGERED (planted by a failed lunge) — the knock's
   * true window. A merely STANDING set man is NOT beaten (that conflation
   * had carriers knocking past their own wall's static blocker). */
  staggered?: ReadonlySet<string>;
  /** mates currently RIDING the line on an L5b run — their meaningful ball
   * is into the space behind, regardless of current (jogging) speed */
  runners?: ReadonlySet<string>;
  /** runners NOT yet darting (approaching or reloading at the line) — the
   * ball to them WAITS for the movement */
  waitingRunners?: ReadonlySet<string>;
}

/** the full scored option table — exported for tests and probes (decide()
 * returns its head after inertia) */
export const evaluateOptions = (input: DecideInput): Intent[] => {
  const { carrier, bodies, instructions, homes, runners, waitingRunners, bounds } = input;
  const inBounds = (p: Vec2, m = 0.5): boolean => !bounds ||
    (p.x >= bounds.x0 + m && p.x <= bounds.x1 - m && p.y >= bounds.y0 + m && p.y <= bounds.y1 - m);
  const roomToBound = (from2: Vec2, dir: { x: number; y: number }): number => {
    if (!bounds) return 99;
    const n = Math.hypot(dir.x, dir.y) || 1;
    const ux = dir.x / n;
    const uy = dir.y / n;
    let r = 99;
    if (ux > 1e-6) r = Math.min(r, (bounds.x1 - from2.x) / ux);
    if (ux < -1e-6) r = Math.min(r, (bounds.x0 - from2.x) / ux);
    if (uy > 1e-6) r = Math.min(r, (bounds.y1 - from2.y) / uy);
    if (uy < -1e-6) r = Math.min(r, (bounds.y0 - from2.y) / uy);
    return Math.max(0, r);
  };
  const risk = instructions.risk ?? 0.5;
  const keep = instructions.objective === 'keep';
  const team = carrier.team;
  const opponents = bodies.filter((b) => b.team !== team);
  const mates = bodies.filter((b) => b.team === team && b.id !== carrier.id);
  const here = carrier.pos;
  const value = (p: Vec2, anchorId: string): number =>
    (keep ? keepValue(p, opponents, homes?.get(anchorId)) : posValue(p, team));
  const pvHere = value(here, carrier.id);
  const turnoverW = DECIDE.turnoverBase - DECIDE.turnoverRiskGain * risk;
  // under a LIVE press, standards drop — you take the 60% ball rather
  // than dying with it (measured: good-enough passes existed at 12/49
  // pressed moments but the calm-conditions floor buried them)
  const pressedNow = opponents.some((o) =>
    Math.hypot(o.pos.x - here.x, o.pos.y - here.y) < 3.5);
  const passFloor = (DECIDE.passFloorBase - DECIDE.passFloorRiskGain * risk) * (pressedNow ? 0.8 : 1);
  const options: Intent[] = [];

  // SHOOT — xG on the value scale directly (1.0 ≡ goal)
  const g = goalCenter(team);
  const dGoal = Math.hypot(g.x - here.x, g.y - here.y);
  // the shot's quality from HERE — also gates the drive-at-goal below: a
  // clear chance is shot, not driven past (the breakaway property)
  const xGHere = !keep && dGoal <= DECIDE.shootRangeM ? xG(here, team, bodies.filter((b) => b.id !== carrier.id)) : 0;
  if (!keep && dGoal <= DECIDE.shootRangeM) {
    // KEEPER-BEATING placement (L7): a shot at the CENTER is a shot at the
    // keeper — aim just inside a corner. From an angle a striker goes ACROSS
    // the goal (the far post): the keeper shades his near post, so across is
    // the longer dive and the open side — the finish coaches teach.
    let dest = g;
    let bestClear = -1;
    let destClearRaw = Infinity; // the picked lane's HONEST clearance (no bonus)
    const offCentre = here.y - GOAL.centerY;
    for (const side of [-1, 1] as const) {
      const c = { x: g.x, y: GOAL.centerY + side * (GOAL.mouthHalfWidthM - 0.6) };
      let clear = Infinity;
      for (const o of opponents) {
        const ldx = c.x - here.x, ldy = c.y - here.y;
        const len2 = ldx * ldx + ldy * ldy;
        const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((o.pos.x - here.x) * ldx + (o.pos.y - here.y) * ldy) / len2));
        clear = Math.min(clear, Math.hypot(o.pos.x - (here.x + ldx * t), o.pos.y - (here.y + ldy * t)));
      }
      const raw = clear;
      // the far post from an angled position earns the across-goal bonus
      if (Math.abs(offCentre) > 1.5 && side !== Math.sign(offCentre)) clear += DECIDE.shotAcrossBonus;
      if (clear > bestClear) { bestClear = clear; dest = c; destClearRaw = raw; }
    }
    // a lane THROUGH a body is mostly saved — the spread keeper a metre off
    // the line eats the shot the EV was pricing at face xG (the 16/16-saved
    // shot kept outbidding round-the-keeper)
    const laneFactor = Math.max(0.3, Math.min(1, 0.3 + 0.7 * (destClearRaw - 0.6) / 1.4));
    options.push({ kind: 'shoot', dest, speedMps: DECIDE.shotSpeedMps, utility: xGHere * laneFactor });
    // the CHIP (L7's counter): a keeper RUSHED OFF HIS LINE leaves the goal
    // open in z, not y — loft it over him, dropping under the bar. The guard
    // figure is the last opponent near the goal mouth; the chip exists only
    // when he is genuinely out (≥4 m) and the parabola clears his leap.
    const guard = opponents
      .filter((o) => Math.hypot(o.pos.x - g.x, o.pos.y - g.y) < 16)
      .sort((a, b) => Math.hypot(a.pos.x - g.x, a.pos.y - g.y) - Math.hypot(b.pos.x - g.x, b.pos.y - g.y))[0];
    if (guard) {
      const kOut = Math.hypot(guard.pos.x - g.x, guard.pos.y - g.y);
      // his distance ALONG the shot line (the chip must clear him mid-flight)
      const sdx = g.x - here.x, sdy = g.y - here.y;
      const sLen = Math.max(Math.hypot(sdx, sdy), 1e-6);
      const tG = ((guard.pos.x - here.x) * sdx + (guard.pos.y - here.y) * sdy) / (sLen * sLen);
      const dK = tG * sLen;
      const R = dGoal + 0.8; // land it just over the line
      if (kOut >= 4 && tG > 0.05 && tG < 0.95) {
        // the chip's loft ADAPTS — as FLAT as still clears the guard's leap
        // (parabolic height at him: x·tanθ·(1−x/R)). A steep chip from range
        // hangs so long even a stranded keeper walks home under it; the long
        // chip is a flatter, faster lob.
        for (const L of [24, 30, DECIDE.chipLoftDeg]) {
          const zAtGuard = dK > 0.5 && dK < R
            ? dK * Math.tan((L * Math.PI) / 180) * (1 - dK / R)
            : 0;
          // clear his CLAIM (hands, 2.8 m) not just his head — and the
          // parabola runs ~0.6 m above the real dragged flight, so the gate
          // carries both: a 2.6 gate got the chip CAUGHT mid-flight at 2.7
          if (zAtGuard <= 3.4) continue; // this loft does not clear his reach
          // ...and only when the guard CANNOT get home before the drop: the
          // chip is a race between his backpedal and the ball's hang. A
          // keeper holding 6 m recovers a chip every time (measured 16/16);
          // one caught out cannot.
          const spdChip = solveLoftSpeed(R, L);
          const tFlight = loftFlightTimeS(spdChip, L);
          const tGuardHome = kOut / Math.max(regimeCapMps(guard.attributes.pace, 'sprint'), 1) + 0.4;
          if (tGuardHome > tFlight + 0.25) { // he must be CLEARLY late — a tying keeper catches the drop
            // an UNCOVERABLE chip is priced as the real chance it is —
            // anchoring it to xGHere undervalued it into never firing (xG
            // counts the very keeper the chip bypasses). Scaled by the
            // mouth's ANGULAR openness from here: a flat price had the
            // byline winger chipping a sliver instead of crossing.
            const a1 = Math.atan2(GOAL.centerY - GOAL.mouthHalfWidthM - here.y, g.x - here.x);
            const a2 = Math.atan2(GOAL.centerY + GOAL.mouthHalfWidthM - here.y, g.x - here.x);
            const openness = Math.min(1, Math.abs(a2 - a1) / 0.35);
            const uChip = (DECIDE.chipBaseValue + DECIDE.chipKeeperOutGain * Math.min(1, (kOut - 4) / 8)) * openness;
            options.push({ kind: 'shoot', dest: g, speedMps: spdChip, loftDeg: L, utility: uChip });
          }
          break; // flattest clearing loft judged; steeper only hangs longer
        }
      }
    }
  }

  // PASS — each teammate, at a lead point if he is moving
  for (const mate of mates) {
    const dist0 = Math.hypot(mate.pos.x - here.x, mate.pos.y - here.y);
    // the WEIGHT tradeoff: a soft ball dies at the receiver's stride (easy
    // take, but slow through tight lanes); a firm ball beats interceptors
    // and arrives HOT (taxed — hot balls pop and sail on a miss). Evaluate
    // both, keep the better.
    const softArrive = DECIDE.passArriveMps + 0.5 * mate.speed;
    let bestPass: Intent | null = null;
    // weights: soft to feet, firm to feet, and — for a RUNNER — the firm
    // ball INTO SPACE beyond the meet point (the line-breaker he runs onto;
    // a ball at the meet itself arrives at his feet and checks his run)
    const candidates: Array<{ arrive: number; leadExtraS: number }> = [
      { arrive: softArrive, leadExtraS: 0 },
      { arrive: softArrive + 4.5, leadExtraS: 0 },
    ];
    if (mate.speed > 2.5) candidates.push({ arrive: softArrive + 4.5, leadExtraS: 0.7 });
    // the RIDER'S ball THREADS just behind the LINE in his lane — the
    // judged too-deep balls came from projecting 7 m past the runner
    // himself; the breach point is line-relative, not runner-relative
    let riderBehind: Vec2 | null = null;
    let riderArriveCap = Infinity;
    // a THROUGH ball threads to a runner AHEAD of the carrier (goal-side) —
    // never to a wide man BEHIND the ball. Without this the break carrier
    // fired a deep thread into the touchline space for a support runner
    // trailing him, squandering a run at goal (the judged bad long ball;
    // the runners in behind we DO thread are all goal-side of the carrier).
    if (runners?.has(mate.id) && attackSign(mate.team) * (mate.pos.x - here.x) > -2) {
      const rsign = attackSign(mate.team);
      const oppXs = opponents.map((o) => o.pos.x);
      const rLineX = oppXs.length ? (rsign > 0 ? Math.max(...oppXs) : Math.min(...oppXs)) : mate.pos.x;
      const rGoalX = rsign > 0 ? PITCH.length : 0;
      const room = rsign > 0 ? rGoalX - rLineX : rLineX - rGoalX;
      // no behind, no ball in behind — and the weight must DIE IN THE
      // SPACE (the judged overhits: threads at a deep line rolled dead)
      if (room >= 14) {
        const depth = Math.min(4.5, room * 0.3);
        riderBehind = { x: rLineX + rsign * depth, y: mate.pos.y };
        const rollRoom = Math.max(1.5, room - depth - 4);
        riderArriveCap = rollLaunchForArrival(0, rollRoom);
      }
    }
    const allCandidates: Array<{ arrive: number; leadExtraS: number; destOverride?: Vec2 }> = [...candidates];
    if (riderBehind) {
      // both weights die IN the space (riderArriveCap): an overhit thread
      // is a dead ball, not a pass
      allCandidates.push({ arrive: Math.min(softArrive + 1, riderArriveCap), leadExtraS: 0, destOverride: riderBehind });
      // the DRIVEN thread (passing.md #9/#13): a faster ball through the
      // same gap — less flight time beats closing defenders; the receiver
      // pays the hot-arrival tax instead
      allCandidates.push({ arrive: Math.min(softArrive + 4, riderArriveCap), leadExtraS: 0, destOverride: riderBehind });
    }
    for (const { arrive: arrive0, leadExtraS, destOverride } of allCandidates) {
      // in a bounded grid, weight the ball to DIE INSIDE (the grid's first
      // sessions ended in seconds — every miss rolled out dead)
      let arrive = arrive0;
      if (bounds) {
        const dirB = { x: (destOverride ?? mate.pos).x - here.x, y: (destOverride ?? mate.pos).y - here.y };
        const room = roomToBound(destOverride ?? mate.pos, dirB);
        // the receiver's trap ABSORBS pace — only the missed ball rolls
        // out, so the cap credits the catch (a hard floor of 4 made every
        // boundary-line switch a 3.4 s float and the judged freeze:
        // nobody passes long when long is uncompletable)
        arrive = Math.min(arrive, 4 + rollLaunchForArrival(0, Math.max(0.5, room - 0.5)));
      }
      const speed = Math.max(DECIDE.passSpeedMin, Math.min(DECIDE.passSpeedMax,
        rollLaunchForArrival(arrive, dist0)));
      // two-iteration lead on the mate's current velocity
      let dest = destOverride ?? { x: mate.pos.x, y: mate.pos.y };
      if (!destOverride) {
        for (let i = 0; i < 2; i++) {
          const dd = Math.hypot(dest.x - here.x, dest.y - here.y);
          const tFly = dd / Math.max(speed - 0.85 * dd * 0.1, speed * 0.55) + leadExtraS;
          // a feet ball leads A STEP, not the whole flight — full-flight
          // extrapolation aimed balls 8-10 m down the receiver's motion and
          // dragged him off his spot to chase his own pass deep (the
          // judged down-the-line interceptions). Runs keep the real lead.
          const leadT = (leadExtraS > 0 || mate.speed > 3.5) ? tFly : Math.min(tFly, 0.7);
          dest = { x: mate.pos.x + mate.vel.x * leadT, y: mate.pos.y + mate.vel.y * leadT };
        }
      }
      if (!inBounds(dest, 0.8)) continue; // you do not pass to out
      let pC = passCompletion(here, dest, speed, opponents, dist0, mate, carrier.attributes.passing);
      // the backheel discount — but ONLY under pressure: an unpressured
      // carrier TURNS before striking (turn-then-strike executes it), so
      // discounting his EV for a blind ball he will never hit double-counts
      // (it killed the wall's thread: open lane, wrong hips, no time
      // pressure). Unpressured misalignment costs only the small turn tax.
      const passDir = Math.atan2(dest.y - here.y, dest.x - here.x);
      const misalign = Math.abs(((passDir - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const bhLoss = DECIDE.backheelEvLossMax * Math.max(0, misalign - Math.PI / 2) / (Math.PI / 2);
      const pressed = opponents.some((o) =>
        Math.hypot(o.pos.x - here.x, o.pos.y - here.y) < 2.5);
      pC *= 1 - (pressed ? bhLoss : Math.min(bhLoss, 0.1));
      // the hot-arrival tax is RECEIVER-AWARE: good feet justify firm
      // balls (a rondo between silk receivers zips; the flat tax floated
      // every pass at 9 m/s — the judged sluggishness)
      const dd0 = Math.hypot(dest.x - here.x, dest.y - here.y);
      const arrTrue = rollSpeedAfter(speed, dd0);
      const comfy = 5.5 + 0.35 * mate.attributes.firstTouch;
      pC *= 1 - 0.04 * Math.max(0, arrTrue - comfy);
      if (pC < passFloor * 0.55) continue; // hopeless lanes don't reach scoring
      let pvThere = value(dest, mate.id);
      // CHANCE CREATION (passing.md's pass score): a ball to a teammate in
      // a shooting position carries his shot's value — the square/cutback
      // into the centre was invisible to the EV without it
      if (!keep) pvThere += 0.6 * xG(dest, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
      // LINES BROKEN (the multi-line ball): every defender the pass puts
      // behind the ball is value beyond the destination itself — scaled by
      // the passer's skill and appetite (the elite diagonal that eliminates
      // six men exists because this term exists)
      if (!keep) {
        const sign2 = attackSign(carrier.team);
        let bypassed = 0;
        for (const o of opponents) {
          if (sign2 > 0 ? (o.pos.x > here.x + 1 && o.pos.x < dest.x - 1) : (o.pos.x < here.x - 1 && o.pos.x > dest.x + 1)) bypassed++;
        }
        pvThere += bypassed * 0.016 * risk * (carrier.attributes.passing / 20);
      }
      // sub-floor lanes are taxed, but the tax RIDES RISK — "the best pass
      // is not always the safest" (passing.md): a speculative player keeps
      // the threaded splitting ball live; a safe one buries it
      const meets = pC >= passFloor ? 1 : 0.25 + 0.45 * risk;
      const uProg = DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pvThere - pvHere);
      // the ball to a RIDING runner waits for his movement — you play the
      // through ball when the dart goes, not while he stands on the line.
      // EXCEPT the ball into his run's PATH (destOverride): the first-time
      // one-two return is played early precisely BECAUSE the run is coming
      // the ball to a RIDING runner WAITS for his movement — you thread it
      // when the dart goes, not while he hovers. This holds the RIDER ball
      // (into the space behind) too: playing it during the ride, while he is
      // still dropping to his hover point, made him meet it SHORT and turn
      // back for it instead of running onto it (the judged drop-back). Once
      // he darts he leaves waitingRunners and the thread releases — the
      // one-two return still fires early because the returning man is darting.
      // ...and the RELEASE GATE (L5E): even a darting runner is not yet a
      // through-ball target until he is UP TO SPEED — the overhit tail came
      // from balls played while the runner was still accelerating (measured:
      // launch 13.6 past a striker at 3.5 m/s → overrun → dead). No weight
      // constant fixes this; the release waits for the run.
      const notUpToSpeed = runners?.has(mate.id) === true && mate.speed < 4.0;
      const ridingWait = waitingRunners?.has(mate.id) || notUpToSpeed ? 0.25 : 1;
      const u = (DECIDE.possessionDiscount * DECIDE.passFriction * (pC * pvThere - (1 - pC) * turnoverW * pvThere) + uProg) * meets * ridingWait;
      if (!bestPass || u > bestPass.utility) {
        bestPass = { kind: 'pass', receiverId: mate.id, dest, speedMps: speed, utility: u };
      }
    }
    // ── the LOFTED ball: a chip / driven loft OVER a ground defender in the
    // lane, dropping for the mate. Only worth it when the ground lane IS
    // blocked (else the ground ball is simpler and easier to control). ──────
    if (!keep) {
      const landing = riderBehind ?? { x: mate.pos.x + mate.vel.x * 0.3, y: mate.pos.y + mate.vel.y * 0.3 };
      const dLoft = Math.hypot(landing.x - here.x, landing.y - here.y);
      // a defender parked in the DIRECT ground lane (mid-flight) — the loft's
      // whole reason to exist; over him the air ball is clean
      const laneBlocker = (dLoft >= 10 && dLoft <= 44 && inBounds(landing, 0.8))
        ? opponents.find((o) => {
            const t = ((o.pos.x - here.x) * (landing.x - here.x) + (o.pos.y - here.y) * (landing.y - here.y)) / (dLoft * dLoft);
            if (t <= 0.12 || t >= 0.92) return false;
            const px = here.x + t * (landing.x - here.x);
            const py = here.y + t * (landing.y - here.y);
            return Math.hypot(o.pos.x - px, o.pos.y - py) < 2.2;
          }) ?? null
        : null;
      if (laneBlocker) {
        const blockerT = ((laneBlocker.pos.x - here.x) * (landing.x - here.x) + (laneBlocker.pos.y - here.y) * (landing.y - here.y)) / (dLoft * dLoft);
        // clear the blocker's HEAD: a near defender (early in the flight)
        // needs a steeper CHIP so the ball is already up; a far one (a deep
        // line) is cleared by the flatter, faster DRIVEN loft
        const loftDeg = blockerT < 0.5 ? DECIDE.loftChipDeg : DECIDE.loftDrivenDeg;
        const speedL = solveLoftSpeed(dLoft, loftDeg);
        // aerial control is HARDER than a ground receive — a dropping ball
        // is taxed by the taker's first touch (silk feet cushion it)
        const ctrl = DECIDE.aerialControlBase + DECIDE.aerialControlTouchGain * mate.attributes.firstTouch;
        const pCa = aerialCompletion(landing, mate, opponents) * ctrl;
        let pvL = value(landing, mate.id);
        if (!keep) pvL += 0.6 * xG(landing, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
        const uProgL = DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pvL - pvHere);
        const meetsL = pCa >= passFloor ? 1 : 0.25 + 0.45 * risk;
        const uL = (DECIDE.possessionDiscount * DECIDE.passFriction * (pCa * pvL - (1 - pCa) * turnoverW * pvL) + uProgL) * meetsL;
        if (!bestPass || uL > bestPass.utility) {
          bestPass = { kind: 'pass', receiverId: mate.id, dest: landing, speedMps: speedL, utility: uL, loftDeg };
        }
        // NOTE: the CURL AROUND (a trivela ground ball bent around this blocker,
        // via solveCurl) belongs here too — validated in isolation (bends clear
        // and reaches the man 12/12) — but as a fully-controllable ground ball it
        // OUT-COMPETES the loft here and the cross into the box, and whether a
        // curl-to-feet should beat a cross-to-head or a loft-over is a real EV
        // calibration + scenario-isolation question. Deferred, not forced.
        // AND: solveCurl fixes DIRECTION only — the integration must pick speed
        // by roll reach (rollLaunchForArrival), not a flat constant: a 17 m/s
        // ball dies at ~31 m (dry-grass friction + drag), silently short beyond.
      }
    }
    // ── the CROSS: a wide, advanced carrier whips an aerial ball into the box
    // for a mate attacking it — DRIVEN (fast, flat) or FLOATED (hang-time),
    // both solved to land on his run. No blocked lane required — the cross IS
    // the ball into the danger zone; the EV picks the delivery that completes. ─
    // lead a receiver by the DELIVERY'S hang time — a long float hangs while he
    // runs on, so aim where he'll BE on the drop, not where he stood when struck
    const leadByHang = (loftDeg: number): Vec2 => {
      let t: Vec2 = { x: mate.pos.x + mate.vel.x * 0.3, y: mate.pos.y + mate.vel.y * 0.3 };
      for (let it = 0; it < 2; it++) {
        const d = Math.hypot(t.x - here.x, t.y - here.y);
        const tF = loftFlightTimeS(solveLoftSpeed(d, loftDeg), loftDeg);
        t = { x: mate.pos.x + mate.vel.x * tF, y: mate.pos.y + mate.vel.y * tF };
      }
      return t;
    };
    if (!keep) {
      const sign = attackSign(carrier.team);
      const wide = Math.abs(here.y - PITCH.width / 2) >= DECIDE.crossWideM;
      const advanced = (sign > 0 ? PITCH.length - here.x : here.x) <= DECIDE.crossAdvanceM;
      if (wide && advanced) {
        for (const loftDeg of [DECIDE.crossDrivenLoftDeg, DECIDE.crossFloatLoftDeg]) {
          const cross = leadByHang(loftDeg);
          const intoBox = (sign > 0 ? PITCH.length - cross.x : cross.x) <= DECIDE.crossBoxM &&
            Math.abs(cross.y - PITCH.width / 2) < 20;
          const dCross = Math.hypot(cross.x - here.x, cross.y - here.y);
          if (!intoBox || dCross < 8 || !inBounds(cross, 0.8)) continue;
          const speedC = solveLoftSpeed(dCross, loftDeg);
          const ctrl = DECIDE.aerialControlBase + DECIDE.aerialControlTouchGain * mate.attributes.firstTouch;
          const pCc = aerialCompletion(cross, mate, opponents) * ctrl;
          let pvC = value(cross, mate.id);
          pvC += 0.6 * xG(cross, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
          const uProgC = DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pvC - pvHere);
          const meetsC = pCc >= passFloor ? 1 : 0.25 + 0.45 * risk;
          const uC = (DECIDE.possessionDiscount * DECIDE.passFriction * (pCc * pvC - (1 - pCc) * turnoverW * pvC) + uProgC) * meetsC;
          if (!bestPass || uC > bestPass.utility) {
            bestPass = { kind: 'pass', receiverId: mate.id, dest: cross, speedMps: speedC, utility: uC, loftDeg };
          }
        }
      }
    }
    // ── the SWITCH of play: a long FLOATED aerial to a wide mate on the FAR
    // flank, over the congested middle — wide → far-wide, at range. ──────────
    if (!keep) {
      const cy = PITCH.width / 2;
      const carrierSide = Math.sign(here.y - cy);
      // gate on the MAN before paying for the flight solve — leadByHang runs
      // two loft solves, wasted on every mate who isn't far-wide
      const farWide = carrierSide !== 0 && Math.sign(mate.pos.y - cy) === -carrierSide &&
        Math.abs(mate.pos.y - cy) >= DECIDE.switchWideM && Math.abs(here.y - cy) >= DECIDE.switchWideM;
      const loftDeg = DECIDE.switchFloatLoftDeg;
      const land = farWide ? leadByHang(loftDeg) : here;
      const dSwitch = Math.hypot(land.x - here.x, land.y - here.y);
      if (farWide && dSwitch >= DECIDE.switchMinM && inBounds(land, 0.8)) {
        const speedS = solveLoftSpeed(dSwitch, loftDeg);
        const ctrl = DECIDE.aerialControlBase + DECIDE.aerialControlTouchGain * mate.attributes.firstTouch;
        const pCs = aerialCompletion(land, mate, opponents) * ctrl;
        let pvS = value(land, mate.id);
        pvS += 0.6 * xG(land, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
        const uProgS = DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pvS - pvHere);
        const meetsS = pCs >= passFloor ? 1 : 0.25 + 0.45 * risk;
        const uS = (DECIDE.possessionDiscount * DECIDE.passFriction * (pCs * pvS - (1 - pCs) * turnoverW * pvS) + uProgS) * meetsS;
        if (!bestPass || uS > bestPass.utility) {
          bestPass = { kind: 'pass', receiverId: mate.id, dest: land, speedMps: speedS, utility: uS, loftDeg };
        }
      }
    }
    if (bestPass) options.push(bestPass);
  }

  // CARRY — sampled directions, lookahead point valued and pressure-taxed.
  // Urgency: with an opponent at your heels you carry at SPRINT — a jogged
  // breakaway is a tackled breakaway
  const heelPressure = opponents.some(
    (o) => Math.hypot(o.pos.x - here.x, o.pos.y - here.y) < 4.0,
  );
  const carryRegime: 'run' | 'sprint' = heelPressure ? 'sprint' : 'run';
  // a cautious player's danger radius is WIDER: he releases before ever
  // engaging the 1v1 (the judged low-risk knock-on at a defender)
  const pressRange = DECIDE.carryPressureRangeM + 6 * (1 - risk);
  for (let i = 0; i < DECIDE.carryDirections; i++) {
    const ang = (i / DECIDE.carryDirections) * Math.PI * 2;
    // VALUE the near point; COMMAND well past it — a target at the
    // evaluation distance keeps the carrier in permanent arrive-braking
    // (the knock-past lesson: never point a command where momentum matters)
    const p = {
      x: here.x + Math.cos(ang) * DECIDE.carryLookaheadM,
      y: here.y + Math.sin(ang) * DECIDE.carryLookaheadM,
    };
    if (p.x < 0.5 || p.x > PITCH.length - 0.5 || p.y < 0.5 || p.y > PITCH.width - 0.5) continue;
    if (!inBounds(p, 0.8)) continue; // carrying out of the grid is not a plan
    let pressure = 0;
    for (const o of opponents) {
      const dNow = Math.hypot(o.pos.x - p.x, o.pos.y - p.y);
      // an ISOLATED defender (no cover within 12 m) is half the threat —
      // attack the lone man, respect the covered one (the judged
      // wide-then-center arc around defenders a direct line beats)
      const covered = opponents.some((o2) => o2.id !== o.id &&
        Math.hypot(o2.pos.x - o.pos.x, o2.pos.y - o.pos.y) < 12);
      pressure = Math.max(pressure, Math.max(0, 1 - dNow / pressRange) * (covered ? 1 : 0.5));
    }
    let pv = value(p, carrier.id);
    // near goal the carry follows the xG GRADIENT — pure positional value
    // let a chased striker drift to the corner flag, where the angle dies
    if (!keep) {
      const gd = Math.hypot(g.x - p.x, g.y - p.y);
      // 0.5, not 0.8: the carry's future-xG is NOT certain (you can lose
      // the ball en route) — at 0.8 carrying closer always beat shooting
      // NOW and the range shot never fired (the judged shyness)
      if (gd < DECIDE.shootRangeM * 1.3) pv += 0.38 * xG(p, team, opponents);
    }
    const runThrough = {
      x: Math.min(bounds ? bounds.x1 - 1 : PITCH.length - 0.5, Math.max(bounds ? bounds.x0 + 1 : 0.5, here.x + Math.cos(ang) * DECIDE.carryCommandM)),
      y: Math.min(bounds ? bounds.y1 - 1 : PITCH.width - 0.5, Math.max(bounds ? bounds.y0 + 1 : 0.5, here.y + Math.sin(ang) * DECIDE.carryCommandM)),
    };
    let u = DECIDE.possessionDiscount * (
      // pressure taxes the spot, but momentum and control mean a defender
      // meters away is a problem, not half your value (the judged
      // dribble-away-from-everyone)
      pv * (1 - 0.55 * pressure) * 0.92 -
      // carrying into reach risks the tackle — risk-scaled turnover, same
      // family as the pass penalty (dodging is not free)
      turnoverW * pv * pressure * DECIDE.carryTurnoverGain
    );
    // the DRIVE credit: when GENUINELY UNPRESSURED a carrier is free to run
    // the ball forward, and that progression should read like a pass's does
    // — otherwise a marginal square/forward ball to an open mate beats simply
    // driving into space (the judged over-passing). Valued at the command
    // point he is driving at, gated on no pressure so it never competes with
    // a release under a real defender (and never overpowers a true thread,
    // whose destination outvalues the drive). No risk term: an open drive is
    // not a gamble.
    const gdT = Math.hypot(g.x - runThrough.x, g.y - runThrough.y);
    // NEAR GOAL, a carry that heads AT the goal earns the drive credit even
    // UNDER pressure: a striker in and around the box drives at the CBs for a
    // shooting position (the credit's pvDrive carries the xG of where he is
    // driving, so it favours the CENTRAL line at goal over drifting wide to
    // the box edge — the judged drift-left-of-box). Elsewhere the drive is a
    // no-pressure privilege as before.
    const driveAtGoal = dGoal < DECIDE.driveAtGoalM && gdT < dGoal - 2 &&
      Math.abs(here.y - GOAL.centerY) > DECIDE.driveWideM;
    if (!keep && (pressure < DECIDE.drivePressureCeil || driveAtGoal)) {
      let pvDrive = value(runThrough, carrier.id);
      if (gdT < DECIDE.shootRangeM * 1.3) pvDrive += 0.38 * xG(runThrough, team, opponents);
      u += DECIDE.possessionDiscount * DECIDE.driveGain * Math.max(0, pvDrive - pvHere);
    }
    options.push({ kind: 'carry', target: runThrough, regime: carryRegime, utility: u, dir: ang });
  }

  // SHIELD — the floor: keep what you have. Under a LIVE closing press,
  // standing still is the worst real option (the judged freeze) — the
  // shield's appeal collapses and the best move wins instead
  const livePress = opponents.some((o) =>
    Math.hypot(o.pos.x - here.x, o.pos.y - here.y) < 3);
  options.push({
    kind: 'shield',
    utility: (DECIDE.shieldUtility + DECIDE.possessionDiscount * pvHere * 0.2) * (livePress ? 0.45 : 1),
  });

  // the KNOCK-AND-GO (L5E): jockeyed by a FRONTMAN with space behind him —
  // push the ball past his shoulder and RACE. The kick frees the ball from
  // carry speed; the burst is how close control beats a re-fronting jockey
  // (the machine + stagger let a defender perpetually re-front a carry-capped
  // attacker — measured 2/16 through without this).
  if (!keep) {
    const gdir = Math.atan2(g.y - here.y, g.x - here.x);
    let frontman: BodyState | null = null;
    let fd = 8.0;
    for (const o of opponents) {
      const d = Math.hypot(o.pos.x - here.x, o.pos.y - here.y);
      if (d > 8.0 || d < 0.8) continue; // to 8: the touch-past-the-KEEPER is a long knock
      const ang = Math.abs((((Math.atan2(o.pos.y - here.y, o.pos.x - here.x) - gdir) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (ang > Math.PI / 3) continue;
      if (d < fd) { fd = d; frontman = o; }
    }
    if (frontman !== null) {
      const fm: BodyState = frontman;
      // space behind him: no second defender within 8 m goal-side of him
      const behindClear = !opponents.some((o2) => o2.id !== fm.id &&
        Math.hypot(o2.pos.x - fm.pos.x, o2.pos.y - fm.pos.y) < 8 &&
        (o2.pos.x - fm.pos.x) * Math.cos(gdir) + (o2.pos.y - fm.pos.y) * Math.sin(gdir) > 0);
      if (behindClear) {
        // past the shoulder — the side AWAY from his offset off the line
        const perp = gdir + Math.PI / 2;
        const off = -(fm.pos.x - here.x) * Math.sin(gdir) + (fm.pos.y - here.y) * Math.cos(gdir);
        const side = off > 0 ? -1 : 1;
        const past = {
          x: fm.pos.x + Math.cos(gdir) * 2.5 + Math.cos(perp) * side * 1.8,
          y: fm.pos.y + Math.sin(gdir) * 2.5 + Math.sin(perp) * side * 1.8,
        };
        if (inBounds(past, 0.8)) {
          const dK = Math.hypot(past.x - here.x, past.y - here.y);
          const speed = rollLaunchForArrival(1.2, dK + 3); // dies ~3 m past — the reclaim
          // clearance of the knock LINE past the frontman (defender-relative,
          // the knock-past drill's too-tight lesson)
          const t = ((fm.pos.x - here.x) * (past.x - here.x) + (fm.pos.y - here.y) * (past.y - here.y)) / (dK * dK);
          const clear = Math.hypot(fm.pos.x - (here.x + (past.x - here.x) * t), fm.pos.y - (here.y + (past.y - here.y) * t));
          const beaten = input.staggered?.has(fm.id) ?? false; // truly planted — the moment
          // a KEEPER frontman collects with hands, dive and sweep — the berth
          // must be far wider than a tackler's feet (the knock at a stranded
          // keeper rolled straight into his gloves, measured 16/16)
          const isKeeper = input.keepers?.has(fm.id) ?? false;
          let pKnock = isKeeper
            ? Math.max(0, Math.min(1, (clear - 1.6) / 1.4))
            : Math.max(0, Math.min(1, (clear - 0.5) / 1.2));
          if (beaten) pKnock = Math.min(1, pKnock + 0.3);
          // vs a LIVE rider the geometric clearance lies — he moves WITH you
          // and covers the push (knock fired 8/8 and converted ~0: the knock
          // is the PLANTED man's punishment; the live rider is the BEAT's)
          else pKnock *= 0.3;
          const reclaim = { x: past.x + Math.cos(gdir) * 1.5, y: past.y + Math.sin(gdir) * 1.5 };
          // CHANCE CREATION, as passes price it: the reclaim past the beaten
          // frontman is a shooting position — against a beaten KEEPER, an
          // open net. Without this the knock lost to the very shot the set
          // keeper saves 16/16 (round-the-keeper never fired).
          let pvReclaim = value(reclaim, carrier.id) +
            0.6 * xG(reclaim, carrier.team, bodies.filter((b) => b.id !== fm.id && b.id !== carrier.id));
          // past the LAST man with nobody covering, the reclaim is a FREE RUN
          // — the brief's isolation principle priced: without it, beating the
          // man was worth six meters of grass (uB ~0.008) and the EV never
          // tried (the beat fired 0/8 in the drill built to show it)
          const freeRun = !opponents.some((o2) => o2.id !== fm.id &&
        Math.hypot(o2.pos.x - reclaim.x, o2.pos.y - reclaim.y) < 15 &&
        Math.hypot(o2.pos.x - g.x, o2.pos.y - g.y) < Math.hypot(reclaim.x - g.x, reclaim.y - g.y) + 2);
          if (freeRun) pvReclaim += DUEL.freeRunBonus;
          // risk-SYMMETRIC, like every pass: the failed knock is a turnover
          // at your own feet — pricing only the success sent carriers
          // knocking past their own wall and made kick-and-rush free
          const uK = DECIDE.possessionDiscount *
            (pKnock * Math.max(0, pvReclaim - pvHere) * DUEL.knockGain -
             (1 - pKnock) * turnoverW * pvHere * 0.8);
          if (uK > 0) options.push({ kind: 'knock', dest: past, speedMps: speed, utility: uK });
          // the BEAT — the manufactured knock: the lane past a SET rider is
          // closed (pKnock low) but the FEINT on his ~0.4 s smoothed read
          // opens it. A sequenced move (approach→feint→burst) the executor
          // runs; here it is priced as the knock it becomes, times the
          // feint's skill-scaled success. Not vs a keeper (his counter is the
          // same move but the burst berth stays hands-wide).
          // the split: the KNOCK beats a PLANTED man (the stagger's window);
          // the BEAT beats a LIVE rider — his smoothed read lags the feint.
          // (fm.speed<3 never matched a TRACK-state rider giving ground at
          // 4-6 m/s, and geometric pKnock overestimates vs a man moving WITH
          // you — both gates were written for a jockey that never appears.)
          if (!isKeeper && !beaten && fd > 1.6 && fd < 6.5) {
            const pFeint = Math.min(1, DUEL.beatFeintBase + DUEL.beatFeintSkill *
              Math.max(0, ((carrier.attributes.agility + carrier.attributes.dribbling) / 2 - fm.attributes.agility) / 20));
            const uB = DECIDE.possessionDiscount *
              (pFeint * Math.max(0, pvReclaim - pvHere) * DUEL.knockGain -
               (1 - pFeint) * turnoverW * pvHere * 0.8);
            if (uB > 0) options.push({ kind: 'beat', dest: past, side, utility: uB });
          }
        }
      }
    }
  }

  // CLEAR — deep and pressured only: escape beats a forced turnover
  const ownProgress = attackSign(team) > 0 ? here.x / PITCH.length : 1 - here.x / PITCH.length;
  const pressed = opponents.some((o) => Math.hypot(o.pos.x - here.x, o.pos.y - here.y) < DECIDE.clearPressureM);
  if (!keep && ownProgress < DECIDE.clearMaxX && pressed) {
    const dest = { x: attackSign(team) > 0 ? here.x + 30 : here.x - 30, y: here.y < GOAL.centerY ? 8 : PITCH.width - 8 };
    options.push({ kind: 'clear', dest, speedMps: 18, utility: DECIDE.clearUtility + (1 - risk) * 0.05 });
  }

  options.sort((a, b) => b.utility - a.utility);
  // L5b — the DELAYED RELEASE (the forward note, now earnable): if the best
  // option is a pass to a RUNNER whose value is still RISING (project him
  // half a second on), hold the ball a beat — the run makes the pass better.
  const best0 = options[0];
  if (best0 && best0.kind === 'pass') {
    const mate = bodies.find((b) => b.id === best0.receiverId);
    if (mate && mate.speed > 3) {
      const ahead: BodyState = { ...mate, pos: { x: mate.pos.x + mate.vel.x * 0.5, y: mate.pos.y + mate.vel.y * 0.5 } };
      const dist0 = Math.hypot(ahead.pos.x - here.x, ahead.pos.y - here.y);
      const arr = DECIDE.passArriveMps + 0.5 * ahead.speed + 4.5;
      const spd = Math.max(DECIDE.passSpeedMin, Math.min(DECIDE.passSpeedMax, rollLaunchForArrival(arr, dist0)));
      const dest2 = { x: ahead.pos.x + ahead.vel.x * 0.8, y: ahead.pos.y + ahead.vel.y * 0.8 };
      const pC2 = passCompletion(here, dest2, spd, opponents, dist0, ahead);
      const pv2 = value(dest2, mate.id);
      const u2 = DECIDE.possessionDiscount * DECIDE.passFriction * (pC2 * pv2 - (1 - pC2) * turnoverW * pv2) +
        DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pv2 - pvHere);
      if (u2 > best0.utility * 1.15) {
        // wait: surface the carry (or shield) instead this beat
        const holdOpt = options.find((o) => o.kind === 'carry' || o.kind === 'shield');
        if (holdOpt) {
          const rest = options.filter((o) => o !== holdOpt);
          return [holdOpt, ...rest];
        }
      }
    }
  }
  return options;
};

/** the L4 evaluation — pure, deterministic, exhaustive over the action set */
export const decide = (input: DecideInput): Intent => {
  const options = evaluateOptions(input);
  const { current } = input;
  let best = options[0];
  // commitment inertia: stay the course unless the new best CLEARLY beats it
  if (current) {
    let same: Intent | undefined;
    if (current.kind === 'carry' && best.kind === 'carry') {
      // a carry CHANGING DIRECTION: commit to the heading we're already
      // running. `same` is the bin nearest the current dir, not just "a
      // carry" — matching by kind bound it to whatever carry sat first in
      // the list, so every reconsider was a fresh argmax and the winning
      // bin hopped between adjacent/wide directions (the judged kink, the
      // sharp turn a beat before a pass). Scope: carry→carry only, so the
      // carry↔pass release keeps its original inertia untouched.
      const wrap = (a: number): number => Math.abs(((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      let bestD = Infinity;
      for (const o of options) {
        if (o.kind !== 'carry') continue;
        const d = wrap(o.dir - current.dir);
        if (d < bestD) { bestD = d; same = o; }
      }
    } else {
      same = options.find((o) => o.kind === current.kind &&
        (o.kind !== 'pass' || (current.kind === 'pass' && o.receiverId === current.receiverId)));
    }
    if (same && best.utility - same.utility <
      Math.max(DECIDE.switchCostAbsFloor, DECIDE.switchCostRel * same.utility)) best = same;
  }
  return best;
};
