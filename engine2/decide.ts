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

import { DT, PITCH, type BodyState, type Vec2 } from './engine2-types.ts';
import { loftApex, loftFlightTimeS, rollLaunchForArrival, rollSpeedAfter, rollTimeToDistance, solveCurl, solveLoftSpeed, stepBall, type BallState } from './ball.ts';
import { KIN, regimeCapMps } from './kinematics.ts';
import { calibratePass, carryRetention } from './pass-calibration.ts';

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
  /** the DUTY BOARD's insurance factor: the behind-cover duty prices as
   * the carrier's danger × this — the presser already engages him;
   * behind guards the breakthrough, the second layer. Fitted (Jul 24)
   * at 0.35: every measured allocation holds outcome-identically.
   * MEASURED LIMIT (same day): the desired flip — ignore a HARMLESS
   * 45 m outlet and cover behind a goal-bearing carrier — needs ≥0.45,
   * but the pinned 2v2's LIVE-outlet mark already loses at 0.45: no
   * single scalar separates them, because the mark scale's 0.4
   * completability floor prices live and harmless outlets alike. The
   * next calibration is the mark-danger scale itself (threat vs
   * completability) — it re-prices lane ranking everywhere, a
   * builder-live round. */
  behindInsurance: 0.35,
  /** the LOCAL GAME radius (the m11 verdict): board duties only for
   * defenders this near the carrier — the rest are team shape */
  localGameR: 30,
  /** the press hand-off leash: incumbency lapses when the chase has
   * dragged the presser this far from his formation home — the carrier
   * is PASSED ON between zones instead of towing one man across the
   * pitch (the builder's dragged-CB frame) */
  pressLeashM: 20,
  /** zone weight in duty seating/claims: meters of home displacement
   * priced per meter of duty distance — the left back stops being the
   * "nearest" man to a central cover spot */
  dutyZoneW: 0.6,
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
  /** keeper distribution style — weights the priced menu (short throws
   * vs the loop / drop-kick / punt). Default 'mixed'. */
  distribution?: 'short' | 'mixed' | 'long';
  /** back-line role in possession, 0..1 (builder: 'the wide defenders
   * are not helping in the attack... it should be possible to make
   * them move up'): >= 0.6 releases this back from the rest-defense
   * clamp — he pushes with the possession band (the wingback's whole
   * point); the remaining backs keep the rest chain. Default 0. */
  joinAttack?: number;
  /** hold the touchline in possession (builder: 'instruct wingers to
   * stay wide... to open up the pitch'): exempt from the lateral
   * block-shift and the far-tuck while the team has the ball. */
  holdWidth?: boolean;
  /** SET-PIECE hooks (builder: takers and styles manager-customizable).
   * setPieceTaker biases the ceremony's taker election to this player;
   * the styles steer the taker's execution — 'auto' prices by geometry. */
  setPieceTaker?: boolean;
  freeKickStyle?: 'auto' | 'short' | 'shoot' | 'cross' | 'long';
  cornerStyle?: 'cross' | 'short';
}

export type Intent =
  | { kind: 'carry'; target: Vec2; regime: 'run' | 'sprint'; utility: number; dir: number }
  | { kind: 'pass'; receiverId: string; dest: Vec2; speedMps: number; utility: number; loftDeg?: number; spin?: number; pC?: number }
  | { kind: 'shoot'; dest: Vec2; speedMps: number; utility: number; loftDeg?: number; spin?: number }
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
  /** the CURL (trivela): a ground ball bent around a lane blocker — fully
   * controllable to feet where the loft trades control for altitude. Spin
   * within the validated band (curve scenarios: 52–85); range bounded by
   * roll reach (a 17 m/s ball dies ~31 m). The bend needs room to work:
   * under ~10 m there is no arc, beyond ~30 the ball dies on the line. */
  curlSpin: 90,
  curlMinM: 10,
  curlMaxM: 30,
  /** the lane margin (s) an opponent needs to make the intercept — sampled
   * against ball travel time along the lane */
  laneSampleStep: 0.15, // fraction of the lane per sample
  interceptReachM: 1.1,
  /** turnover penalty weight — scaled DOWN by the risk instruction */
  turnoverBase: 0.9,
  /** the CONSERVATION EV (builder direction, Jul 24: "no backwards or
   * sideways passes... add EV for ball conservation"): a completed pass
   * KEEPS THE BALL, and that is worth something flat — direction-blind.
   * Priced so the safe recycle beats a marginal forward ball but never
   * outbids a genuine thread (whose pv delta dwarfs it). */
  retainValue: 0.07,
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
   * through ball; a chip (steeper) clears a nearer man. The receive tax
   * is SMALL — measured (Jul 24): unmarked aerial receives complete 12/12
   * at every angle × distance even at firstTouch 6; the aerial ball's
   * real risk is the CONTEST (mid-flight cuts, the drop race), which
   * aerialCompletion's time model prices. The old 0.5+0.02·touch charged
   * 22% for a receive that does not fail — and its double-count pushed
   * honest floats/switches under the pass floor (the failed pins). */
  loftDrivenDeg: 24,
  loftChipDeg: 42,
  aerialControlBase: 0.86,
  aerialControlTouchGain: 0.01,
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
      // cuttable and the multi-line ball never existed). But PRESENCE
      // BEATS REACTION: a body already ON the lane blocks by standing
      // there (the ball deflects off him — no read required); the
      // reaction excuse let a 20 m/s screamer be priced 0.76 through a
      // CB's shins he cut at his plane (the wb-0 cross).
      const react = dOpp <= 0 ? 0.12 : 0.35 + 0.01 * Math.max(0, ballHere - 8);
      const tOpp = react + tRun;
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
  /** flight origin + hang time + apex: enable the TIME model. Without them
   * the old distance-at-the-drop margin runs (sim's quick claim gates).
   * Calibrated against the measured contest matrix (Jul 24): the old model
   * priced a blocker 9 m from the landing at 0.986 while he jogged onto
   * the drop during the hang (chosen 8/8, completed 1/8); and a 24° loft
   * over 18 m has apex ~2.0 m — UNDER a defender's 2.26 m reach for the
   * whole flight: not an "over" ball at all, cuttable at any point he can
   * reach in time. */
  from?: Vec2,
  hangS?: number,
  apexM?: number,
  /** keeper ids among the opponents: a keeper's catch is HANDS — clean,
   * no header contest, wider claim radius. A float dropping in his zone
   * is his ball, not a coin flip (the cross scene: 7/10 keeper claims
   * the model priced at 0.93). */
  keeperIds?: ReadonlySet<string>,
): number => {
  const dMate = Math.hypot(mate.pos.x - landing.x, mate.pos.y - landing.y);
  if (from === undefined || hangS === undefined || apexM === undefined) {
    let nearest = Infinity;
    for (const o of opponents) {
      nearest = Math.min(nearest, Math.hypot(o.pos.x - landing.x, o.pos.y - landing.y));
    }
    const margin = nearest - dMate;
    return 1 / (1 + Math.exp(-(margin - 0.5) / 2.0));
  }
  const runT = (b: BodyState, tx: number, ty: number, reactS: number): number => {
    const d = Math.max(0, Math.hypot(b.pos.x - tx, b.pos.y - ty) - DECIDE.interceptReachM);
    const v = Math.max(regimeCapMps(b.attributes.pace, 'sprint'), 1);
    const a = KIN.accelBase + KIN.accelPerPoint * b.attributes.acceleration;
    const ramp = (v * v) / (2 * a);
    return reactS + (d <= ramp ? Math.sqrt((2 * d) / a) : v / (2 * a) + d / v);
  };
  const dChord = Math.max(Math.hypot(landing.x - from.x, landing.y - from.y), 1e-6);
  const ux = (landing.x - from.x) / dChord;
  const uy = (landing.y - from.y) / dChord;
  // the receiver must be under the drop by the hang (callers lead him there)
  const tRx = 0.1 + runT(mate, landing.x, landing.y, 0);
  let worst = Infinity; // seconds of margin over the best-placed opponent
  for (const o of opponents) {
    const reach = 1.9 + 0.03 * o.attributes.strength; // headStandM + jump
    // MID-FLIGHT CUT: where the flight crosses his reach he can head/cut
    // it — the parabola z(f) ≈ 4·apex·f(1−f) says which stretch of the
    // chord is below him; race him to his nearest cuttable point
    const fO = Math.max(0.08, Math.min(0.92,
      ((o.pos.x - from.x) * ux + (o.pos.y - from.y) * uy) / dChord));
    const zAt = 4 * apexM * fO * (1 - fO);
    if (zAt <= reach) {
      const cx = from.x + ux * fO * dChord;
      const cy = from.y + uy * fO * dChord;
      // presence beats reaction: a body already at the crossing blocks
      // the sub-reach flight by standing there
      const dCross = Math.hypot(o.pos.x - cx, o.pos.y - cy);
      const tO = (dCross <= DECIDE.interceptReachM ? 0.12 : 0.35) + runT(o, cx, cy, 0);
      worst = Math.min(worst, tO - fO * hangS);
    }
    // the LANDING RACE: he converges on the drop during the hang. An
    // ATTENDED drop that both bodies reach is a header CONTEST (the
    // aerial-contest layer decides it by reach/strength) — floored near
    // the coin flip, or every cross into a real box prices to zero (the
    // failed cross pin). An UNattended drop he reaches first is his.
    // A KEEPER gets no contest floor and a head start (hands claim wide
    // and clean — the drop in his zone is simply his).
    const isK = keeperIds?.has(o.id) ?? false;
    const tOl = 0.35 + runT(o, landing.x, landing.y, 0) - (isK ? 0.25 : 0);
    let lm = tOl - Math.max(hangS, tRx);
    if (!isK && tRx <= hangS + 0.2) lm = Math.max(lm, -0.18); // contest floor ≈ 0.46
    worst = Math.min(worst, lm);
  }
  // time margin → probability (fitted: −0.35 s ≈ 1/3, +0.05 s ≈ 0.85)
  return Math.max(0.02, Math.min(0.98, 1 / (1 + Math.exp(-(worst + 0.15) / 0.2))));
};

/** completion of a CURLING ground ball: the lane is the BENT path, not the
 * chord — a straight-lane check would see the exact blocker the bend exists
 * to avoid. Simulate the spun roll once (the same stepBall physics the
 * match runs) and apply passCompletion's interception-margin model over the
 * TRUE samples. `aim` is solveCurl's strike point; `dest` the intended
 * arrival (the receiver's ball). */
export const curlCompletion = (
  from: Vec2,
  aim: Vec2,
  spin: number,
  speedMps: number,
  dest: Vec2,
  opponents: readonly BodyState[],
  receiver?: BodyState,
  passerSkill = 12,
): number => {
  const dChord = Math.hypot(dest.x - from.x, dest.y - from.y);
  if (dChord < 0.5) return 0.2;
  const dirA = Math.atan2(aim.y - from.y, aim.x - from.x);
  const b: BallState = {
    pos: { x: from.x, y: from.y }, z: 0,
    vel: { x: Math.cos(dirA) * speedMps, y: Math.sin(dirA) * speedMps }, vz: 0, spin,
    phase: 'rolling', carrierId: null, kickerId: null, kickerLockUntilTick: 0, touchParity: false,
  };
  const runTime = (bd: BodyState, tx: number, ty: number, reactS: number): number => {
    const d = Math.max(0, Math.hypot(bd.pos.x - tx, bd.pos.y - ty) - DECIDE.interceptReachM);
    const v = Math.max(regimeCapMps(bd.attributes.pace, 'sprint'), 1);
    const a = KIN.accelBase + KIN.accelPerPoint * bd.attributes.acceleration;
    const ramp = (v * v) / (2 * a);
    return reactS + (d <= ramp ? Math.sqrt((2 * d) / a) : v / (2 * a) + d / v);
  };
  let worst = Infinity;
  for (let i = 1; i <= 400; i++) {
    stepBall(b);
    const ballHere = Math.hypot(b.vel.x, b.vel.y);
    const distTo = Math.hypot(b.pos.x - dest.x, b.pos.y - dest.y);
    const arrived = distTo <= 1.2;
    if (ballHere < 0.3) break;
    if (i % 2 !== 0 && !arrived) continue; // every 0.2 s + the arrival
    const tBall = i * DT;
    const px = b.pos.x;
    const py = b.pos.y;
    const f = Math.max(0, Math.min(1, 1 - distTo / dChord));
    for (const o of opponents) {
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
      // presence beats reaction (see passCompletion): a body on the bent
      // path blocks by standing there
      const react = dOpp <= 0 ? 0.12 : 0.35 + 0.01 * Math.max(0, ballHere - 8);
      const tOpp = react + tRun;
      const protectedTail = receiver !== undefined && f > 0.7 &&
        runTime(receiver, px, py, 0.1) <= tOpp;
      worst = Math.min(worst, tOpp - tBall + (protectedTail ? 0.35 : 0));
    }
    if (arrived) break;
  }
  const precision = (passerSkill - 14) * 0.02;
  const p = (worst + precision + 0.4) / 1.0;
  const lane = Math.max(0.02, Math.min(0.98, p));
  const range = 1 / (1 + Math.max(0, dChord - 26) / 30);
  return lane * range;
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
  /** targets already CLAIMED by teammates this tick — run lanes, other
   * support spots, box slots. The claims channel was runner-to-runner
   * only, so a supporter, a runner and a box man converged on one spot
   * with each system blind to the others (the tick-688 triple stack). */
  claimed?: readonly Vec2[],
): Vec2 => {
  const opponents = bodies.filter((b) => b.team !== mate.team);
  const mates = bodies.filter((b) => b.team === mate.team && b.id !== mate.id);
  // the home DEFORMS toward the ball (structure follows play). In SCORE
  // mode the base sits ON THE MESH RING around the carrier (the EAFC
  // frames: 3-4 short options within 8-15 m; home-anchored support left
  // the carrier one pass short of a triangle) — approached from the
  // supporter's natural side so the mesh keeps its angles.
  const dx = carrier.pos.x - home.x;
  const dy = carrier.pos.y - home.y;
  const dd = Math.hypot(dx, dy) || 1;
  const base = objective === 'keep'
    ? { x: home.x + (dx / dd) * Math.min(dd * 0.3, 3), y: home.y + (dy / dd) * Math.min(dd * 0.3, 3) }
    : { x: carrier.pos.x - (dx / dd) * Math.min(dd, 12), y: carrier.pos.y - (dy / dd) * Math.min(dd, 12) };
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
    if (objective === 'score' && dist > 17) continue; // the mesh ring: short options only
    const lane = passCompletion(carrier.pos, cand, rollLaunchForArrival(6, dist), opponents, dist, mate);
    const val = objective === 'keep' ? keepValue(cand, opponents, home) : posValue(cand, mate.team);
    let crowd = 0;
    if (claimed) {
      for (const c of claimed) {
        const cd = Math.hypot(c.x - cand.x, c.y - cand.y);
        if (cd < 7) crowd += (7 - cd) * 0.35;
      }
    }
    // TRIANGLE SPREAD (the builder's frame: supporters approached from
    // their home directions — same-side men stacked on one line, no
    // angles): a candidate within ~40° of another mate's bearing from
    // the carrier is crowding the SAME passing lane, wherever he stands
    const candAng = Math.atan2(cand.y - carrier.pos.y, cand.x - carrier.pos.x);
    for (const m of mates) {
      const md = Math.hypot(m.pos.x - cand.x, m.pos.y - cand.y);
      if (md < 6) crowd += (6 - md) / 6;
      const mAng = Math.atan2(m.pos.y - carrier.pos.y, m.pos.x - carrier.pos.x);
      const dAng = Math.abs(((candAng - mAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const mDist = Math.hypot(m.pos.x - carrier.pos.x, m.pos.y - carrier.pos.y);
      if (dAng < 0.7 && mDist < 20) crowd += (0.7 - dAng) / 0.7 * 0.8;
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
  keepers?: ReadonlySet<string>,
  /** y-lanes already claimed by TEAMMATES on active runs — the seam
   * scorer had no notion of them, so forwards with similar positions
   * all solved for the same best seam and STACKED (the tick-589 pile:
   * two wingers occupying one blade of grass) */
  claimedYs?: readonly number[],
): { target: Vec2; lineX: number; dartY: number } | null => {
  const sign = attackSign(mate.team);
  // the KEEPER IS NOT THE LINE (the m11 run-game killer, found via the
  // support census: zero darts in any 11v11, ever): with him counted,
  // the "last defender" sits on his own goal line, room-in-behind reads
  // ~5 m, and the run game gates itself off at exactly the scale it was
  // built for. Offside runs ride the last OUTFIELD man.
  const opponents = bodies.filter((b) => b.team !== mate.team && !keepers?.has(b.id));
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
  // FINAL-THIRD mode (the tick-625 frame: both strikers LEVEL with an
  // advanced carrier failed the ahead-gate, fell to the support game
  // and jogged BACK at him mid-attack — and a midfielder behind the
  // ball could never run at all): with the carrier advanced, the run
  // game opens to the LATE ARRIVAL — the man level or behind who
  // attacks the line from deep, football's most common goal-run.
  const carrierProg = sign > 0 ? carrier.pos.x : PITCH.length - carrier.pos.x;
  const finalThird = carrierProg > 55;
  const distToLine = sign > 0 ? lineX - mate.pos.x : mate.pos.x - lineX;
  if (distToLine > (finalThird ? 30 : 22) || distToLine < -2) return null;
  // ahead of the carrier — OR close enough to the line to beat it (the
  // one-two: the giver starts BEHIND his wall man and runs beyond)
  const aheadOfCarrier = sign > 0 ? mate.pos.x > carrier.pos.x + 2 : mate.pos.x < carrier.pos.x - 2;
  if (!finalThird && !aheadOfCarrier && distToLine > 12) return null;
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
    let score = clear - 0.15 * Math.abs(y - GOAL.centerY) - 0.22 * Math.abs(y - mate.pos.y);
    // a seam a running teammate already owns is effectively VETOED — the
    // soft penalty (0.45/m) still lost to the own-position anchor and
    // 46% of multi-runner ticks ran the same lane; a claimed seam now
    // outranks only an empty candidate list
    if (claimedYs) {
      for (const cy of claimedYs) {
        const cd = Math.abs(cy - y);
        if (cd < 4) score -= 8;
        else if (cd < 9) score -= (9 - cd) * 0.7;
      }
    }
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
  | { kind: 'mark'; target: Vec2; urgent: boolean; mkId?: string }
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
  /** goalkeepers — the danger-driven line and offside geometry are
   * keeper-blind (he is not "the line") */
  keepers?: ReadonlySet<string>;
}

/** the BLOCK STATION (the four-frame verdict): a player's off-ball spot
 * is his formation home slid toward the BALL relative to the team's
 * formation centroid — anchoring on the pitch center made midfield
 * possession compute ~zero shift, and a striker attacked six defenders
 * while his team idled at home. Possession pushes hard (the block
 * supports its carrier); defense slides shorter and compresses. */
export const blockStation = (
  home: Vec2,
  centroid: Vec2,
  ball: Vec2,
  possession: boolean,
  /** the team's attack sign — the compactness clamp needs to know which
   * way "ahead of the ball" points */
  sign = 0,
  /** the tactics hook (L6): a higher line squeezes the possession rest
   * band up the pitch; the band itself is fundamental */
  lineHeight = 0.5,
  /** EAFC-scale compression is an ELEVEN-man behavior: a 4-man line that
   * tucks 16 m abandons its channel outright (the fullbacks drill went
   * 8/8 through) — small casts keep the old gentle slide */
  teamSize = 11,
  /** REST-DEFENSE (possession only): the deepest opposing outfielder's
   * u-coordinate — a back-line station never pushes past it (minus a
   * 4 m cushion). The rest band tracked the BALL alone, and the CBs
   * rode it level with (worst: 19 m past) the opponent's front line. */
  oppDeepU?: number,
  /** possession SECURITY (the tick-228 frame: the back four jogging to
   * halfway while their carrier fought a four-man swarm — flips happen
   * under 1-2 m of pressure, and the block advanced the instant the
   * ball changed hands): unsettled possession holds a deeper band and
   * a fatter cushion; the line steps up when the ball is actually won. */
  settled = true,
  /** how threatening the deepest opponent is (0..1, 1 = camped near our
   * goal): scales the rest cushion — a striker loitering at halfway
   * does not need a 9 m buffer, and the full-price cushion was opening
   * a 20 m band of nobody between the rest line and the attack (the
   * builder's 'massive gap'). */
  oppThreat = 1,
  /** possession width hold: skip the lateral slide + far-tuck */
  holdWidth = false,
): Vec2 => {
  const kx = possession ? 0.7 : 0.45;
  let capX = possession ? 30 : 18;
  // HIGH BLOCK vs the deep build-up (the tick-534 frame: the ball at the
  // opponent goal line and the defending block still sitting 50 m off in
  // its own half — the 18 m slide cap strands it): the farther the ball
  // is from OUR goal, the farther the block may step up. The deep-half
  // line clamp still holds the back line goal-side of the last opponent.
  if (!possession && sign !== 0) {
    const dOwnGoal = sign > 0 ? ball.x : PITCH.length - ball.x;
    capX = 18 + 12 * Math.max(0, Math.min(1, (dOwnGoal - 60) / 30));
  }
  // BALL-SIDE COMPRESSION (the EAFC frames: density is central and
  // ball-side; a far winger tucks toward the box edge rather than
  // holding the touchline) — roughly double the old lateral slide
  const big = teamSize >= 8;
  const ky = big ? 0.45 : 0.3;
  const capY = big ? 16 : possession ? 10 : 8;
  let x = Math.max(2, Math.min(PITCH.length - 2, home.x + Math.max(-capX, Math.min(capX, (ball.x - centroid.x) * kx))));
  if (sign !== 0) {
    const u = x * sign;
    const ballU = ball.x * sign;
    if (!possession) {
      // TEAM COMPACTNESS (principles II.1): out of possession no station
      // sits more than 28 m ahead of the ball — hard to play through
      if (u > ballU + 28) x = (ballU + 28) * sign;
      // THE DANGER-DRIVEN LINE (builder: 'the last defensive line
      // should be a lot higher... not a set limit but forced through
      // detrimental dangerEV'): with NO opponent between the line and
      // the space behind, hanging deep concedes the midfield for
      // nothing — the line pushes to the deepest opponent (minus a
      // 2 m step) or 10 m behind the ball, whichever is deeper. The
      // slide caps stop being the binding force; the OPPONENTS are.
      // Offside (the law, this same round) is what makes the pushed
      // line defensible — the lurker in behind is now a dead ball.
      if (oppDeepU !== undefined) {
        const lineTarget = Math.min(oppDeepU - 3, ballU - 14);
        if (x * sign < lineTarget) x = lineTarget * sign;
        x = Math.max(2, Math.min(PITCH.length - 2, x));
      }
    } else {
      // POSSESSION COMPACTNESS + REST-DEFENSE (the EAFC frames: the
      // attacking block spans ~35 m with the back line stepped up to a
      // visible rest chain behind the ball). lineHeight is the tactics
      // hook: a higher line squeezes the rest band up; the fundamentals
      // (a band exists) are not optional.
      // tightened to the EAFC density (three probes showed the short-
      // option mesh is a GEOMETRY product: at their ~40 m envelope, 3-4
      // teammates sit within 16 m of the carrier by construction)
      const restDeep = 16 + (1 - lineHeight) * 8 + (settled ? 0 : 6); // deepest station behind the ball
      if (u < ballU - restDeep) x = (ballU - restDeep) * sign;
      // stations don't lead the ball in the FINAL third (runs/box do) —
      // but in BUILD-UP the formation itself leads it: a flat +10 cap
      // dragged all ten outfielders inside 25 m of their own corner
      // (the tick-534 frame) with nobody upfield to receive an out ball
      const prog = sign > 0 ? ball.x : PITCH.length - ball.x;
      const aheadCap = 10 + 26 * Math.max(0, Math.min(1, (50 - prog) / 40));
      if (u > ballU + aheadCap) x = (ballU + aheadCap) * sign;
      const cushion = (settled ? 4 : 9) * Math.max(0.3, oppThreat);
      if (oppDeepU !== undefined && x * sign > oppDeepU - cushion) x = (oppDeepU - cushion) * sign;
    }
    x = Math.max(2, Math.min(PITCH.length - 2, x));
  }
  let y = possession && holdWidth
    ? home.y // the chalk-line winger: width IS his job in possession
    : Math.max(2, Math.min(PITCH.width - 2, home.y + Math.max(-capY, Math.min(capY, (ball.y - centroid.y) * ky))));
  // the far-side TUCK: nobody stations more than 26 m across from the
  // ball line (the EAFC far winger sits at the box edge, not the chalk)
  if (big && !(possession && holdWidth)) {
    if (y - ball.y > 26) y = ball.y + 26;
    if (ball.y - y > 26) y = ball.y - 26;
    y = Math.max(2, Math.min(PITCH.width - 2, y));
  }
  return { x, y };
};

export const decideDefense = (input: DefenseInput): DefenseIntent => {
  const { defender, carrier, bodies, ball, instructions, unit, pressingIds, inCounterpress, justReceived, homes } = input;
  const pressing = instructions.pressing ?? 0;
  // FIRST-DEFENDER election (principles IV: ONE man pressures the ball):
  // nearest eligible — STICKY for the incumbent unless clearly beaten
  // (flapping first/second made both look like ball-chasers)
  // ZONE-ENTRY election (the EAFC frames: the back line holds ~15 m
  // behind the engagement and MIDFIELD presses; the earlier flat
  // line-tax measured backward because a fullback pressing in his OWN
  // channel is right): a deep-half defender only wins the election when
  // the carrier has actually entered his line's DEPTH BAND — otherwise
  // a midfielder steps out even if slightly farther. Team behavior
  // (unit >= 5); drills keep raw-nearest.
  const zHomes = unit.map((b) => homes.get(b.id)).filter((h): h is Vec2 => !!h);
  const zCx = zHomes.length ? zHomes.reduce((a, h) => a + h.x, 0) / zHomes.length : carrier.pos.x;
  const zSign = attackSign(defender.team);
  let nearest = unit.reduce((best, b) => {
    const d = Math.hypot(carrier.pos.x - b.pos.x, carrier.pos.y - b.pos.y);
    if (unit.length >= 5) {
      const h = homes.get(b.id);
      const deep = h ? (zSign > 0 ? h.x <= zCx + 0.5 : h.x >= zCx - 0.5) : false;
      if (deep) {
        // his line's depth band: from his own goal out to his line's
        // height + a stride — the carrier must be INSIDE it. The height
        // is where the line ACTUALLY STANDS (his position), not his
        // formation home: under the danger-driven line the back line
        // lives 30 m above its homes, and the home-based band left a
        // fullback standing ON the carrier ineligible to press while a
        // midfielder sprinted in from ten (the tick-614 frame)
        const lineU = Math.max(h ? h.x * zSign : 0, b.pos.x * zSign);
        const carU = carrier.pos.x * zSign;
        const entered = carU <= lineU + 10;
        if (!entered) return best; // hold the line; midfield steps
      }
    }
    return d < best.d ? { id: b.id, d } : best;
  }, { id: '', d: Infinity });
  const incumbent = unit.find((b) => pressingIds.has(b.id));
  if (incumbent && incumbent.id !== nearest.id) {
    const di = Math.hypot(carrier.pos.x - incumbent.pos.x, carrier.pos.y - incumbent.pos.y);
    // the HAND-OFF LEASH (the builder's frame: a CB dragged across the
    // pitch by a moving carrier — incumbency held as long as he stayed
    // within 14 m of the carrier, which chasing guarantees): stickiness
    // also requires the incumbent still near HIS OWN STATION; a press
    // dragged beyond the leash lapses, the nearest fresh defender takes
    // the carrier, and the dragged man returns to his zone.
    const ih = input.homes.get(incumbent.id);
    const drag = ih ? Math.hypot(incumbent.pos.x - ih.x, incumbent.pos.y - ih.y) : 0;
    // ...a TEAM behavior: with fewer than five defenders there are no
    // zones to protect and the long escorted press (the 2v1 herd) is
    // the right football
    const leashed = unit.length >= 5 && drag >= DUEL.pressLeashM;
    if (di < nearest.d + 4 && di < 14 && !leashed) nearest = { id: incumbent.id, d: di };
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
    // THE LOCAL GAME (the m11 pilot verdict: every duty fired globally —
    // ten defenders marking across the whole pitch, nobody holding a
    // line): the duty board is for the LOCAL unit only; everyone beyond
    // localGameR falls through to holdShape. Drill casts sit inside the
    // radius, so the small scenes are untouched.
    // ... and the board seats PRESSER + THREE (the builder's screenshot:
    // with the ball in the corner, EIGHT men inside the local radius all
    // drew 'cover' duties and the leftover-centroid rule stacked them
    // into one blob — a real defense compacts as a STRUCTURED block, so
    // everyone beyond the three nearest holds shape instead)
    // seating and claiming are ZONE-WEIGHTED (the builder's frame: the
    // LEFT BACK seated by raw proximity and handed a central cover spot
    // — the board must prefer the man whose zone the duty sits in)
    const zoneCost = (b: BodyState, at: Vec2): number => {
      const h = homes.get(b.id);
      if (!h) return Math.hypot(b.pos.x - at.x, b.pos.y - at.y);
      // VACANCY DANGER (builder direction): the gap a defender leaves by
      // taking this duty is itself a danger — priced by how far the duty
      // drags him from his zone AND whether opponents lurk near the zone
      // he'd vacate. Shape retention becomes an EV force, not a leash.
      let lurkers = 0;
      for (const o of bodies) {
        if (o.team === defender.team) continue;
        if (Math.hypot(o.pos.x - h.x, o.pos.y - h.y) < 16) lurkers++;
      }
      return Math.hypot(b.pos.x - at.x, b.pos.y - at.y) +
        DUEL.dutyZoneW * Math.hypot(at.x - h.x, at.y - h.y) * (1 + 0.7 * Math.min(2, lurkers));
    };
    const covers = unit.filter((b) => b.id !== nearest.id &&
      Math.hypot(b.pos.x - carrier.pos.x, b.pos.y - carrier.pos.y) < DUEL.localGameR)
      .sort((a, b) => zoneCost(a, carrier.pos) - zoneCost(b, carrier.pos))
      .slice(0, 3);
    if (!covers.some((b) => b.id === defender.id) && nearest.id !== defender.id) {
      return { kind: 'holdShape', target: defShapeTarget(defender, unit, homes, ball, bodies, input.keepers) };
    }
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
    // the DANGER-EV (the builder's symmetry, completed): duties price in
    // the ATTACK'S OWN CURRENCY — a mark is worth the receivable value
    // it removes (his reachability × his position's value, the same
    // models the attacker prices with). The old 0.4 completability
    // floor made a harmless 45 m outlet as "dangerous" as a live one —
    // the recorded mark-scale limit, retired here.
    // priced at the PROJECTED receive point (0.8 s ahead): a darting
    // runner's danger lives where he will take the ball, not where he
    // is — current-spot pricing let the behind duty's xG outgrow the
    // mark late in attacks and the lone cover abandoned the runner
    const oppValue = (o: BodyState): number => {
      const px2 = { x: o.pos.x + o.vel.x * 0.8, y: o.pos.y + o.vel.y * 0.8 };
      return posValue(px2, carrier.team) +
        0.8 * xG(px2, carrier.team, bodies.filter((b) => b.team === defender.team));
    };
    const marks = bodies
      .filter((o) => o.team === carrier.team && o.id !== carrier.id &&
        Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y) < 28)
      .map((o) => {
        const dist0 = Math.hypot(o.pos.x - carrier.pos.x, o.pos.y - carrier.pos.y);
        // priced AS IF UNATTENDED: openness excludes the covers being
        // allocated (the shadowSpot lesson again — a defender standing
        // near the lane saw "closed, no danger" and LEFT it; the same
        // exclusion set for every defender keeps the board consistent)
        const unattended = others.filter((d) => !covers.some((cv) => cv.id === d.id));
        const open = dist0 < 3 ? 0 : passCompletion(carrier.pos, o.pos, 11, unattended, dist0, o);
        return { o, open, danger: open * oppValue(o) };
      })
      .filter((m) => m.danger > 0.012)
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
    const markSpot = (o: BodyState, open = 0): Vec2 => {
      const md = Math.hypot(og.x - o.pos.x, og.y - o.pos.y) || 1;
      const bd = Math.hypot(carrier.pos.x - o.pos.x, carrier.pos.y - o.pos.y) || 1;
      // the run threat: his speed TOWARD my goal — the station drops with
      // it and the ball-shade fades (the anticipatory mark: never caught
      // leaning forward when the dart comes)
      const gws = anticipate ? Math.max(0, (o.vel.x * (og.x - o.pos.x) + o.vel.y * (og.y - o.pos.y)) / md) : 0;
      // LANE DENIAL (opponent-intent anticipation, tier 1): a STANDING
      // man whose lane is open NOW is about to be passed to — the mark
      // steps ONTO the lane a body-length off him and kills the ball
      // before it is kicked, instead of escorting goal-side and letting
      // the receive happen. Darting men keep the goal-side ride (the
      // lane-stander is beaten by the run, the whole anticipatory-mark
      // lesson), and short lanes skip it (goal-side already shades them).
      const goalward = attackSign(carrier.team) * (o.pos.x - carrier.pos.x) > 3;
      if (open > 0.55 && gws < 1.5 && bd > 8 && !goalward) {
        // ...BIASED GOAL-SIDE (a pure lane-stander is beaten the instant
        // the dart goes — the anticipatory-mark lesson's third
        // appearance) and LATERAL/BACK OUTLETS ONLY (the fullbacks
        // re-fit: denying a GOALWARD man's lane trades the ride for the
        // cut and the dart beats it — forward threats keep the escort;
        // the recycle outlet is the lane worth killing pre-kick)
        return {
          x: o.pos.x + ((carrier.pos.x - o.pos.x) / bd) * 2.4 + ((og.x - o.pos.x) / md) * 1.5,
          y: o.pos.y + ((carrier.pos.y - o.pos.y) / bd) * 2.4 + ((og.y - o.pos.y) / md) * 1.5,
        };
      }
      const depth2 = DUEL.markGoalSideM + gws * DUEL.markDropGainS;
      const shade = DUEL.markBallShadeM * Math.max(0, 1 - gws / DUEL.markShadeFadeMps);
      return {
        x: o.pos.x + ((og.x - o.pos.x) / md) * depth2 + ((carrier.pos.x - o.pos.x) / bd) * shade,
        y: o.pos.y + ((og.y - o.pos.y) / md) * depth2 + ((carrier.pos.y - o.pos.y) / bd) * shade,
      };
    };
    // THE DUTY BOARD (the defensive twin of the attacker's priced menu —
    // the builder's calibration round): every duty carries the DANGER it
    // neutralizes on ONE scale (the mark scale: openness × (0.4 + pos
    // value)), ranked, greedy-claimed nearest-first. The old fixed order
    // (marks always first, behind for the spare) becomes the usual
    // RESULT, not a rule: the BEHIND duty prices as the carrier's
    // breakthrough threat × the insurance factor — the presser already
    // engages him, behind is the second layer. Fitted so the measured
    // scenes hold (2v2 marks the outlet; a dangerous carrier bearing on
    // goal with a weak outlet flips behind up the board). With no spare,
    // man-for-man stands (the blended neither-duty spot measured worse).
    const duties: Array<{ danger: number; spot: Vec2; mk?: BodyState }> =
      marks.map((m) => ({ danger: m.danger, spot: markSpot(m.o, m.open), mk: m.o }));
    // the behind duty: the carrier's BREAKTHROUGH EV — the value of the
    // space behind the press, discounted by the presser already engaging
    duties.push({
      danger: (posValue(behind, carrier.team) +
        0.8 * xG(behind, carrier.team, bodies.filter((b) => b.team === defender.team))) * DUEL.behindInsurance * 1.2,
      spot: behind,
    });
    duties.sort((a, b) => b.danger - a.danger);
    const free = new Set(covers.map((b) => b.id));
    const claim = (spot: Vec2): string => {
      let best = '';
      let bd = Infinity;
      for (const id of free) {
        const b = covers.find((x) => x.id === id)!;
        // the DUTY LEASH (the h-cb1 frame: a dropping striker towed the
        // CB into midfield — the press got a leash, the duties never
        // did): at team scale nobody claims a duty beyond 18 m of his
        // home; an unclaimable duty goes unassigned and the dropper is
        // the next line's problem. Deterministic and identical in every
        // defender's simulation of the shared assignment.
        if (unit.length >= 5) {
          const h = homes.get(id);
          if (h && Math.hypot(spot.x - h.x, spot.y - h.y) > 26) continue; // 26 = shift cap 18 + local 8 (raw homes, shifted block)
        }
        const d = zoneCost(b, spot);
        if (d < bd) { bd = d; best = id; }
      }
      if (best) free.delete(best);
      return best;
    };
    for (const duty of duties) {
      if (!free.size) break;
      if (claim(duty.spot) === defender.id) {
        if (duty.mk) {
          const md2 = Math.hypot(og.x - duty.mk.pos.x, og.y - duty.mk.pos.y) || 1;
          const gws2 = (duty.mk.vel.x * (og.x - duty.mk.pos.x) + duty.mk.vel.y * (og.y - duty.mk.pos.y)) / md2;
          return { kind: 'mark', target: duty.spot, urgent: gws2 > 3, mkId: duty.mk.id };
        }
        return { kind: 'cover', target: duty.spot };
      }
    }
    const spot = pressCoverSpots(carrier, bodies, [...free]).get(defender.id);
    if (spot) return { kind: 'cover', target: spot };
  } else if (!iAmFirst && firstIsEngaged && nearest.d < 6) {
    const lane = shadowSpot(defender, carrier, bodies);
    if (lane) return { kind: 'interceptLane', target: lane };
  }
  return { kind: 'holdShape', target: defShapeTarget(defender, unit, homes, ball, bodies, input.keepers) };
};

/** defensive off-board shape: the block station (formation lines sliding
 * with the ball) — shapeSpot was an L5c small-line tool and read as "no
 * structure" at eleven */
const defShapeTarget = (defender: BodyState, unit: readonly BodyState[], homes: ReadonlyMap<string, Vec2>, ball: BallState, bodies: readonly BodyState[], keepers?: ReadonlySet<string>): Vec2 => {
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const b of unit) {
    const h = homes.get(b.id);
    if (!h) continue;
    cx += h.x; cy += h.y; n++;
  }
  const centroid = n ? { x: cx / n, y: cy / n } : defender.pos;
  // back-line member? (deepest outfield home +6 m, the sim's rule) —
  // only the LINE rides the danger-driven push; mids keep the block
  const sgnD = attackSign(defender.team);
  const myHome = homes.get(defender.id);
  let deepestHome = Infinity;
  for (const b of unit) {
    const h = homes.get(b.id);
    if (h && !keepers?.has(b.id)) deepestHome = Math.min(deepestHome, h.x * sgnD);
  }
  const isBackLine = myHome !== undefined && !keepers?.has(defender.id) &&
    myHome.x * sgnD <= deepestHome + 6;
  let oppDeep: number | undefined;
  // MATCH SCALE ONLY (unit >= 8): the pushed line is defensible only
  // UNDER the offside law, which is itself match-gated — in a drill the
  // lurker in behind is legal and the high line is the old suicide
  // (line-vs-runs measured 52% the moment the push reached it)
  if (isBackLine && unit.length >= 8) {
    oppDeep = Infinity;
    for (const b of bodies) {
      if (b.team === defender.team || keepers?.has(b.id)) continue;
      oppDeep = Math.min(oppDeep, b.pos.x * sgnD);
    }
    if (!Number.isFinite(oppDeep)) oppDeep = undefined;
  }
  const st = blockStation(homes.get(defender.id) ?? defender.pos, centroid, ball.pos, false, sgnD, 0.5, unit.length + 1, oppDeep);
  // VACANCY ROTATION (the builder's dragged-CB principle, second half:
  // "the position he leaves open gets covered immediately by a teammate
  // who then leaves their position to be covered, etc"): a shape-holder
  // whose NEIGHBOR is off on duty far from home slides toward the
  // vacated zone; the chain emerges from the same rule applying to the
  // next man at the next reconsider. Team behavior (unit >= 5).
  if (unit.length >= 5) {
    for (const b of unit) {
      if (b.id === defender.id) continue;
      const bh = homes.get(b.id);
      if (!bh) continue;
      const away = Math.hypot(b.pos.x - bh.x, b.pos.y - bh.y);
      if (away < 12) continue; // he is home enough
      const myDistToHisZone = Math.hypot(st.x - bh.x, st.y - bh.y);
      // rotate DOWN the pitch only (cover the deeper vacancy; sideways
      // slides opened the middle — measured 2/5 concessions), and only
      // for ball-relevant zones
      const mh = homes.get(defender.id) ?? defender.pos;
      const sgn = attackSign(defender.team);
      const deeperVacancy = bh.x * sgn <= mh.x * sgn + 1;
      if (deeperVacancy && myDistToHisZone < 15 && Math.abs(bh.y - ball.pos.y) < 25) {
        st.x = (st.x + bh.x) / 2;
        st.y = (st.y + bh.y) / 2;
        break;
      }
    }
  }
  // the LINE clamp: a deep-half defender (his formation home behind the
  // team centroid) never stations AHEAD of the deepest opponent — the
  // raw slide let runners live behind the "line" (the l5c integrity pin
  // fell to 43%)
  const home = homes.get(defender.id) ?? defender.pos;
  const sign = attackSign(defender.team); // own goal is opposite the attack
  // epsilon: a FLAT back line ties its own centroid (the two-CB scene:
  // 70 vs 70) and dodged the clamp entirely
  const deepHalf = sign > 0 ? home.x <= centroid.x + 0.5 : home.x >= centroid.x - 0.5;
  if (deepHalf) {
    let deepestOpp = sign > 0 ? Infinity : -Infinity;
    for (const o of bodies) {
      if (o.team === defender.team) continue;
      deepestOpp = sign > 0 ? Math.min(deepestOpp, o.pos.x) : Math.max(deepestOpp, o.pos.x);
    }
    if (Number.isFinite(deepestOpp)) {
      st.x = sign > 0 ? Math.min(st.x, deepestOpp - 1.2) : Math.max(st.x, deepestOpp + 1.2);
      st.x = Math.max(2, Math.min(PITCH.length - 2, st.x));
    }
  }
  return st;
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
  /** each running mate's PLANNED breach lane (the run cycle's dartY) —
   * the thread aims at where the run is GOING, not a velocity
   * extrapolation of where the runner happens to be drifting (intent
   * tier 2: the choreographed thread) */
  runTargets?: ReadonlyMap<string, Vec2>;
  /** runners NOT yet darting (approaching or reloading at the line) — the
   * ball to them WAITS for the movement */
  waitingRunners?: ReadonlySet<string>;
}

/** the full scored option table — exported for tests and probes (decide()
 * returns its head after inertia) */
/** the shared PASS-UTILITY shape (the refinement round: five hand-copies
 * across ground/loft/curl/cross/switch had begun to drift) — completion-
 * weighted value minus turnover, plus the risk-scaled progress term,
 * floored by the meets penalty. Algebraically identical to the copies. */
const passUtility = (pC: number, pv: number, pvHere: number, risk: number, turnoverW: number, passFloor: number, lossV = pv, retainW = 0): number => {
  const meets = pC >= passFloor ? 1 : 0.25 + 0.45 * risk;
  const uProg = DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pv - pvHere);
  // the BOTH-CURRENCY ledger (the danger-EV's mirror): the upside is ours
  // (destination value + the flat conservation premium for keeping the
  // ball at all), the downside is THEIRS — lossV prices the turnover in
  // the OPPONENT's posValue at the loss point. The old pv-scaled risk
  // made losing the ball DEEP read cheap (our pv is low there) when it is
  // exactly where a loss is fatal — so the safe backward ball had neither
  // upside nor downside and never got chosen. keep-objective sites pass
  // the defaults (lossV = pv, retainW = 0): identity with the old algebra.
  // the premium rides pC TWICE (pC · pC·retainW): priced completion is
  // systematically optimistic in the forward direction (priced .87,
  // realized .59 — the held calibration gap), so a LINEAR premium
  // follows the same optimism and the mix never shifts; squaring makes
  // the genuinely-safe ball discriminably richer than the hopeful one
  // the loss currency only ever RAISES the price (deep losses are fatal);
  // it never discounts below the old pv-scaled algebra — a cheap-loss
  // license up the pitch re-fitted every duel trajectory (two pins)
  return (DECIDE.possessionDiscount * DECIDE.passFriction * (pC * (pv + pC * retainW) - (1 - pC) * turnoverW * Math.max(lossV, pv)) + uProg) * meets;
};

export const evaluateOptions = (input: DecideInput): Intent[] => {
  const { carrier, bodies, instructions, homes, runners, waitingRunners, bounds, keepers } = input;
  // hazard density for the calibration lives where the ball is GOING —
  // a switch out of a crowded flank into an empty one is not a traffic
  // ball (carrier-anchored density gave it the full shrink and killed
  // the switch outright)
  // the CALIBRATION is a MATCH-SCALE truth (the laws precedent): the
  // fitted shrinks encode full-match hazards — counterpress, step-ins,
  // twenty-two bodies of chaos — that a five-body drill does not have,
  // and applying them to drills broke eight semantic pins twice. Zero
  // density = identity, so the gate rides the density argument.
  const matchScale = bodies.length >= 18;
  const destDensity = (at: Vec2): number => !matchScale ? 0 : Math.min(1, bodies.filter((b) => b.team !== carrier.team &&
    Math.hypot(b.pos.x - at.x, b.pos.y - at.y) < 14).length / 3);
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
  // THE OFFSIDE LAW, attack side (match scale — the big-cast precedent):
  // a mate beyond the second-last opponent, in their half, ahead of the
  // ball is a FLAGGED run — passing to him is a dead ball, so he is not
  // a candidate. (The law itself is enforced in the sim; this is the
  // brain respecting it.)
  let offsideLineU = Infinity;
  if (!keep && bodies.length >= 18) {
    const sgnOf = attackSign(team);
    const oppUs = opponents.map((o) => o.pos.x * sgnOf).sort((a, b) => b - a);
    offsideLineU = oppUs[1] ?? Infinity;
  }
  // graded, not binary (the tick-499 reluctance: with the line pushed
  // higher, a striker A STEP beyond it vanished from the whole menu —
  // even for the feet-ball he would drop back onto): clearly offside
  // (> 1.5 m) is no target; marginal is a heavy tax, not a veto
  const offsideBy = (m: BodyState): number => {
    if (offsideLineU === Infinity) return 0;
    const sgnOf = attackSign(team);
    const mu = m.pos.x * sgnOf;
    const inOppHalf = sgnOf > 0 ? m.pos.x > PITCH.length / 2 : m.pos.x < PITCH.length / 2;
    if (!inOppHalf || mu <= here.x * sgnOf) return 0;
    return Math.max(0, mu - offsideLineU);
  };
  // turnover currency: what THEY gain where we would lose it
  const lossVal = (p: Vec2): number => posValue(p, team === 'home' ? 'away' : 'home');
  // conservation grows under pressure — the back/square ball is football's
  // ESCAPE VALVE: a hunted carrier values keeping the ball far more than a
  // free one (who keeps his license to drive and thread)
  let pressHere = 0;
  for (const o of opponents) {
    const dO = Math.hypot(o.pos.x - here.x, o.pos.y - here.y);
    pressHere = Math.max(pressHere, Math.max(0, 1 - dO / DECIDE.carryPressureRangeM));
  }
  // ...and DIES NEAR GOAL: conservation is a BUILD-UP value. In the
  // final third the point of possession is spending it — the 1v1 pins
  // (stranded keeper, channel beat) caught the elite attacker recycling
  // out of exactly the moments he exists to take.
  const gHere = goalCenter(team);
  const buildup = Math.max(0, Math.min(1, (Math.hypot(gHere.x - here.x, gHere.y - here.y) - 22) / 20));
  // ...and PRESUMES AN OUTLET: with no teammate on the pitch there is
  // nobody to conserve THROUGH — the premium just distorted the take-on
  // (the channel's 1-v-pair reverts to the pure duel economy)
  const retainW = keep || mates.length === 0 ? 0 : DECIDE.retainValue * (1 + 1.2 * pressHere) * buildup;
  // RECEIVER FREEDOM (the danger-EV's mirror): a one-step EV undervalues
  // the open deep man — his position is worth little but his FREEDOM is
  // the whole next action (the free CB can pick any forward ball; the
  // covered striker can pick nothing). Space at the destination is value.
  const freedom = (at: Vec2): number => {
    if (keep) return 0;
    let nearest = Infinity;
    for (const o of opponents) {
      nearest = Math.min(nearest, Math.hypot(o.pos.x - at.x, o.pos.y - at.y));
    }
    return 0.035 * buildup * Math.min(1, nearest / 12);
  };
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
    // the FINISHER (builder: 'not shooting in favourable angles'): a
    // real chance with a CLEAN lane is taken — measured ~6 passed-up
    // xG>0.12 moments per match with carry-to-better outbidding the
    // strike the better spot was FOR
    const finisher = xGHere >= 0.12 && laneFactor >= 0.7 ? 1.35 : 1;
    // the CURLED FINISH (builder: 'increase curving physics'): from a
    // real angle the across-goal shot BENDS into the far corner — the
    // arc bows away from the keeper's reach and comes back inside the
    // post. Aim = the Magnus-solved point; the executor spins it.
    let shotSpin = 0;
    let shotAim = dest;
    if (Math.abs(offCentre) > 5 && Math.sign(dest.y - GOAL.centerY) !== Math.sign(offCentre)) {
      const crossG = (dest.x - here.x) * (g.y - here.y) - (dest.y - here.y) * (g.x - here.x);
      shotSpin = crossG > 0 ? 45 : -45;
      shotAim = solveCurl(here, dest, shotSpin, DECIDE.shotSpeedMps);
    }
    options.push({ kind: 'shoot', dest: shotAim, speedMps: DECIDE.shotSpeedMps, utility: xGHere * laneFactor * finisher, spin: shotSpin || undefined });
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
    const offBy = offsideBy(mate);
    if (offBy > 1.5) continue; // clearly flagged — not a target
    const offsideTax = offBy > 0 ? 0.25 : 1;
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
        // the PLANNED lane beats the current column when the run has one
        const planY = input.runTargets?.get(mate.id)?.y;
        riderBehind = { x: rLineX + rsign * depth, y: planY ?? mate.pos.y };
        const rollRoom = Math.max(1.5, room - depth - 4);
        riderArriveCap = rollLaunchForArrival(0, rollRoom);
      }
    }
    const allCandidates: Array<{ arrive: number; leadExtraS: number; destOverride?: Vec2 }> = [...candidates];
    if (riderBehind) {
      // the SEAM FAN (the builder's LB–CB scene): the thread is not owed
      // to the runner's own column — a breach point a few meters to
      // either side may run through a WIDE-OPEN seam in the line while
      // his column is a defender's chest. Each seam dest is priced by
      // the same lane completion; the runner ANGLES his dart onto the
      // winner (the receive reflex chases the ball, not the column).
      for (const dy of [0, -4, 4, -7, 7]) {
        const rd = { x: riderBehind.x, y: riderBehind.y + dy };
        if (dy !== 0 && !inBounds(rd, 2)) continue;
        // both weights die IN the space (riderArriveCap): an overhit
        // thread is a dead ball, not a pass; the DRIVEN variant
        // (passing.md #9/#13) trades a hot arrival for less flight time
        allCandidates.push({ arrive: Math.min(softArrive + 1, riderArriveCap), leadExtraS: 0, destOverride: rd });
        allCandidates.push({ arrive: Math.min(softArrive + 4, riderArriveCap), leadExtraS: 0, destOverride: rd });
      }
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
      let pvThere = value(dest, mate.id) + freedom(dest);
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
      // constant fixes this; the release waits for the run. (A speed-eased
      // discount was tried Jul 24 and REVERTED same day: the builder's eye
      // caught the overhit tail returning — slow-releases fed the cut
      // rates. The original measurement stands.)
      const notUpToSpeed = runners?.has(mate.id) === true && mate.speed < 4.0;
      const ridingWait = waitingRunners?.has(mate.id) || notUpToSpeed ? 0.25 : 1;
      // a DARTING runner receives in stride — he has already beaten the
      // crowd the density counts, and the arrival-race model prices the
      // cut honestly on its own; full shrink double-counted the box and
      // buried the final through ball (builder)
      const dartRx = runners?.has(mate.id) && mate.speed >= 4 ? 0.5 : 1;
      pC = calibratePass(0, 0, Math.hypot(dest.x - here.x, dest.y - here.y), pC, destDensity(dest) * dartRx);
      const u = passUtility(pC, pvThere, pvHere, risk, turnoverW, passFloor, keep ? pvThere : lossVal(dest), retainW) * ridingWait * offsideTax;
      if (!bestPass || u > bestPass.utility) {
        bestPass = { kind: 'pass', receiverId: mate.id, dest, speedMps: speed, utility: u, pC };
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
            // NOW or CONVERGING (momentum doesn't delete the man, and it
            // doesn't excuse him either — the shadow half a second from
            // the lane is the blocker the bend/loft exists to beat; the
            // current-position gate watched him cut the "clear" ball 7/8)
            const dNow = Math.hypot(o.pos.x - px, o.pos.y - py);
            const dProj = Math.hypot(o.pos.x + o.vel.x * 0.5 - px, o.pos.y + o.vel.y * 0.5 - py);
            return Math.min(dNow, dProj) < 2.2;
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
        const pCa = calibratePass(loftDeg, 0, dLoft,
          aerialCompletion(landing, mate, opponents, here, loftFlightTimeS(speedL, loftDeg), loftApex(dLoft, loftDeg), keepers) * ctrl, destDensity(landing));
        let pvL = value(landing, mate.id) + freedom(landing);
        if (!keep) pvL += 0.6 * xG(landing, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
        const uL = passUtility(pCa, pvL, pvHere, risk, turnoverW, passFloor, keep ? pvL : lossVal(landing), retainW);
        if (!bestPass || uL > bestPass.utility) {
          bestPass = { kind: 'pass', receiverId: mate.id, dest: landing, speedMps: speedL, utility: uL, loftDeg, pC: pCa };
        }
        // ── the CURL AROUND (trivela; the builder's outside bender): the
        // ground ball bent around this blocker — to FEET, controllable,
        // where the loft trades control for altitude. solveCurl fixes
        // direction only (its contract): speed is picked by roll reach
        // first, completion is judged on the BENT path (curlCompletion),
        // and the intent's dest is the AIM point — kickBall strikes at it
        // and the Magnus brings the ball to the mate. ────────────────────
        if (dLoft >= DECIDE.curlMinM && dLoft <= DECIDE.curlMaxM) {
          // bend around the blocker's far side: +spin bows the arc to the
          // RIGHT of the chord (the ball deviates left of its travel, so
          // the aim sits right and the arc stays right) — blocker left of
          // the chord → +spin, and mirrored
          const crossB = (landing.x - here.x) * (laneBlocker.pos.y - here.y) -
            (landing.y - here.y) * (laneBlocker.pos.x - here.x);
          const spinK = crossB > 0 ? DECIDE.curlSpin : -DECIDE.curlSpin;
          const speedK = Math.max(DECIDE.passSpeedMin, Math.min(DECIDE.passSpeedMax,
            rollLaunchForArrival(Math.min(softArrive + 1, riderBehind ? riderArriveCap : Infinity), dLoft)));
          const aimK = solveCurl(here, landing, spinK, speedK);
          const pCk = calibratePass(0, spinK, dLoft,
            curlCompletion(here, aimK, spinK, speedK, landing, opponents, mate, carrier.attributes.passing), destDensity(landing));
          let pvK = value(landing, mate.id) + freedom(landing);
          pvK += 0.6 * xG(landing, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
          const uK = passUtility(pCk, pvK, pvHere, risk, turnoverW, passFloor, keep ? pvK : lossVal(landing), retainW);
          if (!bestPass || uK > bestPass.utility) {
            bestPass = { kind: 'pass', receiverId: mate.id, dest: aimK, speedMps: speedK, utility: uK, spin: spinK, pC: pCk };
          }
        }
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
          const pCc = calibratePass(loftDeg, 0, dCross,
            aerialCompletion(cross, mate, opponents, here, loftFlightTimeS(speedC, loftDeg), loftApex(dCross, loftDeg), keepers) * ctrl, destDensity(cross));
          let pvC = value(cross, mate.id) + freedom(cross);
          // 0.6 -> 1.0 under the calibrated regime: crosses are LOW-
          // COMPLETION HIGH-VALUE by nature — the old weight was fitted
          // when pC pretended the box was safe
          pvC += 1.0 * xG(cross, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
          const uC = passUtility(pCc, pvC, pvHere, risk, turnoverW, passFloor, keep ? pvC : lossVal(cross), retainW);
          if (!bestPass || uC > bestPass.utility) {
            bestPass = { kind: 'pass', receiverId: mate.id, dest: cross, speedMps: speedC, utility: uC, loftDeg, pC: pCc };
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
        const pCs = calibratePass(loftDeg, 0, dSwitch,
          aerialCompletion(land, mate, opponents, here, loftFlightTimeS(speedS, loftDeg), loftApex(dSwitch, loftDeg), keepers) * ctrl, destDensity(land));
        let pvS = value(land, mate.id) + freedom(land);
        pvS += 0.6 * xG(land, mate.team, bodies.filter((b) => b.id !== mate.id && b.id !== carrier.id));
        const uS = passUtility(pCs, pvS, pvHere, risk, turnoverW, passFloor, keep ? pvS : lossVal(land), retainW);
        if (!bestPass || uS > bestPass.utility) {
          bestPass = { kind: 'pass', receiverId: mate.id, dest: land, speedMps: speedS, utility: uS, loftDeg, pC: pCs };
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
    // the FITTED retention replaces the hand-constants when the memory
    // space's carry table is applied (the both-sided rule) — legacy
    // algebra otherwise; R(0) of the legacy form is the same 0.92
    const fittedR = matchScale ? carryRetention(pressure) : null;
    // the loss side of the both-currency ledger applies to carries too —
    // but NOT the conservation premium: premium × retention rewards the
    // lowest-pressure direction, which is retreat, and the channel pin
    // caught the elite attacker dancing backward off his own take-on
    // until he was trapped and stripped. A backward CARRY drags the duel
    // with you; the backward PASS is the escape valve, so the premium
    // lives on releases (and their manufactured cousins, knock/beat).
    const lossC = keep ? pv : Math.max(lossVal(p), pv);
    // ...but with NO premium at all, every pass outbids every carry by
    // retainValue and five duel scenes released early — so the carry
    // premium is priced at the carrier's OWN pressure (uniform across
    // directions): parity with passing holds, retreat earns nothing extra
    const premC = retainW * (1 - 0.55 * pressHere) * 0.92;
    let u = fittedR !== null
      ? DECIDE.possessionDiscount * ((pv * fittedR + premC) - turnoverW * lossC * (1 - fittedR) * DECIDE.carryTurnoverGain)
      : DECIDE.possessionDiscount * (
        (pv * (1 - 0.55 * pressure) + premC) * 0.92 -
        turnoverW * lossC * pressure * DECIDE.carryTurnoverGain
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
  // ...and shielding with NOBODY NEAR is not football at any price (the
  // builder's frame: carriers standing over the ball in open grass) —
  // beyond 6 m of the nearest opponent the shield is a dead option
  let nearOppD = Infinity;
  for (const o of opponents) {
    nearOppD = Math.min(nearOppD, Math.hypot(o.pos.x - here.x, o.pos.y - here.y));
  }
  options.push({
    kind: 'shield',
    // the conservation premium reaches here too — shield IS retention
    // (with the premium on carries but not the shield, the channel's
    // elite carried INTO the pincer instead of riding it out)
    utility: (DECIDE.shieldUtility + DECIDE.possessionDiscount * (pvHere * 0.2 + 0.9 * retainW)) *
      (livePress ? 0.45 : 1) * (nearOppD > 6 ? 0.2 : 1),
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
          // the conservation premium is paid to EVERY retention-bearing
          // option (the channel pin caught plain carries outbidding the
          // take-on the moment carries alone earned it)
          const uK = DECIDE.possessionDiscount *
            (pKnock * (Math.max(0, pvReclaim - pvHere) * DUEL.knockGain + 0.9 * retainW) -
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
              (pFeint * (Math.max(0, pvReclaim - pvHere) * DUEL.knockGain + 0.9 * retainW) -
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
