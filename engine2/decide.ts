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
import type { BallState } from './ball.ts';
import { KIN, regimeCapMps } from './kinematics.ts';

/** goal mouths: home attacks +x (goal at x=105), away attacks −x (x=0) */
export const GOAL = {
  mouthHalfWidthM: 3.66,
  centerY: PITCH.width / 2,
} as const;

export interface PlayInstructions {
  /** 0 = safety-first, 1 = speculative — biases the turnover penalty and the
   * completion floor a pass must clear (spec: risk visibly shifts choices) */
  risk?: number;
  /** 'score' (default) values progress toward goal; 'keep' is the rondo's
   * truth — value SPACE and retention, never shoot or clear */
  objective?: 'keep' | 'score';
}

export type Intent =
  | { kind: 'carry'; target: Vec2; regime: 'run' | 'sprint'; utility: number }
  | { kind: 'pass'; receiverId: string; dest: Vec2; speedMps: number; utility: number }
  | { kind: 'shoot'; dest: Vec2; speedMps: number; utility: number }
  | { kind: 'shield'; utility: number }
  | { kind: 'clear'; dest: Vec2; speedMps: number; utility: number };

export const DECIDE = {
  /** re-evaluation cadence (ticks) — continuous but not per-tick (spec §3) */
  reconsiderTicks: 3,
  /** commitment inertia: a new intent must beat the current one by this —
   * sized to the utility scale (non-shot options live in ~[0, 0.19]; at
   * 0.05 the first carry was unswitchable and rode into every tackle) */
  switchCost: 0.008,
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
  passSpeedMax: 16,
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
  passFloorBase: 0.72,
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
  /** carrying near defenders risks the TACKLE — without this term dodging
   * always beat releasing, and the safe pass never happened (the judged
   * corner-dodge). Risk-scaled like the pass turnover penalty. */
  carryTurnoverGain: 0.5,
  /** shooting */
  shootRangeM: 26,
  shotSpeedMps: 22,
  xgDistHalfM: 13, // xG halves around this distance
  xgDistScaleM: 5,
  xgBlockerFactor: 0.6,
  /** clear: only under pressure deep in own territory */
  clearMaxX: 0.35, // fraction of pitch length (own end)
  clearPressureM: 3.0,
  clearUtility: 0.06,
  shieldUtility: 0.03,
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
    if (Math.hypot(o.pos.x - px, o.pos.y - py) < 0.9) {
      blockers++;
      // a boot ON the shot line within a stride blocks it outright — the
      // judged pinball: shooting into the man on your toes, forever
      if (t * d < 2.0) pointBlank = true;
    }
  }
  const raw = distFactor * angleFactor * DECIDE.xgBlockerFactor ** blockers;
  return Math.min(0.95, pointBlank ? raw * 0.15 : raw);
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
): number => {
  const d = Math.hypot(dest.x - from.x, dest.y - from.y);
  if (d < 0.5) return 0.2; // a pass to your own feet is not a pass
  let worst = Infinity; // seconds of margin the ball holds over the best interceptor
  for (let f = DECIDE.laneSampleStep; f <= 1.0001; f += DECIDE.laneSampleStep) {
    const px = from.x + (dest.x - from.x) * f;
    const py = from.y + (dest.y - from.y) * f;
    const seg = d * f;
    // rolling decel matched to ball.ts physics (1.7 m/s²)
    const disc = speedMps * speedMps - 2 * 1.7 * seg;
    if (disc <= 0) break; // the ball dies before this sample
    const tBall = (speedMps - Math.sqrt(disc)) / 1.7;
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
      const tOpp = 0.35 + tRun;
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
  // lane they beat by ≥0.4 s is dead
  const p = (worst + 0.4) / 1.0;
  const lane = Math.max(0.02, Math.min(0.98, p));
  // long balls complete less even into space (execution noise grows with
  // distance) — but an OPEN 35m lane is still a good ball; the old 18m soft
  // cap taxed every through ball to death regardless of the lane
  const range = 1 / (1 + Math.max(0, receiverDist - 26) / 30);
  return lane * range;
};

export interface DecideInput {
  carrier: BodyState;
  bodies: readonly BodyState[];
  ball: BallState;
  instructions: PlayInstructions;
  current: Intent | null;
  /** drill stations (initial positions) — the 'keep' objective's anchors */
  homes?: ReadonlyMap<string, Vec2>;
}

/** the full scored option table — exported for tests and probes (decide()
 * returns its head after inertia) */
export const evaluateOptions = (input: DecideInput): Intent[] => {
  const { carrier, bodies, instructions, homes } = input;
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
  const passFloor = DECIDE.passFloorBase - DECIDE.passFloorRiskGain * risk;
  const options: Intent[] = [];

  // SHOOT — xG on the value scale directly (1.0 ≡ goal)
  const g = goalCenter(team);
  const dGoal = Math.hypot(g.x - here.x, g.y - here.y);
  if (!keep && dGoal <= DECIDE.shootRangeM) {
    const quality = xG(here, team, bodies.filter((b) => b.id !== carrier.id));
    options.push({ kind: 'shoot', dest: g, speedMps: DECIDE.shotSpeedMps, utility: quality });
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
    for (const arrive of [softArrive, softArrive + 4.5]) {
      const speed = Math.max(DECIDE.passSpeedMin, Math.min(DECIDE.passSpeedMax,
        Math.sqrt(arrive ** 2 + 2 * 1.7 * dist0)));
      // two-iteration lead on the mate's current velocity
      let dest = { x: mate.pos.x, y: mate.pos.y };
      for (let i = 0; i < 2; i++) {
        const dd = Math.hypot(dest.x - here.x, dest.y - here.y);
        const tFly = dd / Math.max(speed - 0.85 * dd * 0.1, speed * 0.55);
        dest = { x: mate.pos.x + mate.vel.x * tFly, y: mate.pos.y + mate.vel.y * tFly };
      }
      let pC = passCompletion(here, dest, speed, opponents, dist0, mate);
      // the backheel discount: strikes far off facing complete less
      const passDir = Math.atan2(dest.y - here.y, dest.x - here.x);
      const misalign = Math.abs(((passDir - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      pC *= 1 - DECIDE.backheelEvLossMax * Math.max(0, misalign - Math.PI / 2) / (Math.PI / 2);
      // the hot-arrival tax: what reaches the receiver above comfortable
      // pace costs completion (pops, sails past)
      const dd0 = Math.hypot(dest.x - here.x, dest.y - here.y);
      const arrTrue = Math.sqrt(Math.max(1, speed * speed - 2 * 1.7 * dd0));
      pC *= 1 - 0.04 * Math.max(0, arrTrue - 6.5);
      if (pC < passFloor * 0.55) continue; // hopeless lanes don't reach scoring
      const pvThere = value(dest, mate.id);
      const meets = pC >= passFloor ? 1 : 0.35; // sub-floor lanes are heavily taxed
      const uProg = DECIDE.possessionDiscount * risk * DECIDE.riskProgressGain * Math.max(0, pvThere - pvHere);
      const u = (DECIDE.possessionDiscount * DECIDE.passFriction * (pC * pvThere - (1 - pC) * turnoverW * pvThere) + uProg) * meets;
      if (!bestPass || u > bestPass.utility) {
        bestPass = { kind: 'pass', receiverId: mate.id, dest, speedMps: speed, utility: u };
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
    let pressure = 0;
    for (const o of opponents) {
      const dNow = Math.hypot(o.pos.x - p.x, o.pos.y - p.y);
      pressure = Math.max(pressure, Math.max(0, 1 - dNow / DECIDE.carryPressureRangeM));
    }
    const pv = value(p, carrier.id);
    const u = DECIDE.possessionDiscount * (
      pv * (1 - 0.8 * pressure) * 0.92 -
      // carrying into reach risks the tackle — risk-scaled turnover, same
      // family as the pass penalty (dodging is not free)
      turnoverW * pv * pressure * DECIDE.carryTurnoverGain
    );
    const runThrough = {
      x: Math.min(PITCH.length - 0.5, Math.max(0.5, here.x + Math.cos(ang) * DECIDE.carryCommandM)),
      y: Math.min(PITCH.width - 0.5, Math.max(0.5, here.y + Math.sin(ang) * DECIDE.carryCommandM)),
    };
    options.push({ kind: 'carry', target: runThrough, regime: carryRegime, utility: u });
  }

  // SHIELD — the floor: keep what you have
  options.push({ kind: 'shield', utility: DECIDE.shieldUtility + DECIDE.possessionDiscount * pvHere * 0.2 });

  // CLEAR — deep and pressured only: escape beats a forced turnover
  const ownProgress = attackSign(team) > 0 ? here.x / PITCH.length : 1 - here.x / PITCH.length;
  const pressed = opponents.some((o) => Math.hypot(o.pos.x - here.x, o.pos.y - here.y) < DECIDE.clearPressureM);
  if (!keep && ownProgress < DECIDE.clearMaxX && pressed) {
    const dest = { x: attackSign(team) > 0 ? here.x + 30 : here.x - 30, y: here.y < GOAL.centerY ? 8 : PITCH.width - 8 };
    options.push({ kind: 'clear', dest, speedMps: 18, utility: DECIDE.clearUtility + (1 - risk) * 0.05 });
  }

  options.sort((a, b) => b.utility - a.utility);
  return options;
};

/** the L4 evaluation — pure, deterministic, exhaustive over the action set */
export const decide = (input: DecideInput): Intent => {
  const options = evaluateOptions(input);
  const { current } = input;
  let best = options[0];
  // commitment inertia: stay the course unless the new best CLEARLY beats it
  if (current) {
    const same = options.find((o) => o.kind === current.kind &&
      (o.kind !== 'pass' || (current.kind === 'pass' && o.receiverId === current.receiverId)));
    if (same && best.utility - same.utility < DECIDE.switchCost) best = same;
  }
  return best;
};
