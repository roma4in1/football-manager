/**
 * agent-model.ts — shared world-state types + AGENT_CAL for the agent engine.
 *
 * Every tunable lives in AGENT_CAL — calibration never chases constants
 * across modules (same discipline as the aggregate engine's CAL). The shared
 * helpers here (arrivalTime, positionValue, xgProxy) are the single source of
 * truth all three sub-models read, so decision and execution can never
 * disagree about geometry or chance quality.
 *
 * Dependency direction (enforced by review + dependency-cruiser's engine
 * isolation): agent-model ← {agent-positioning, agent-decision,
 * agent-execution} ← agent-engine. Sub-models never import each other.
 */

import type { Attributes, BallFlight, Phase, PlayerInstructions, Tactics, Vec2 } from './engine-types.ts';

/** ALL agent-engine tunables. Placeholder values only — calibration is Wednesday's job. */
export const AGENT_CAL = {
  // ── tick loop ──────────────────────────────────────────────────────────────
  tickSeconds: 0.5, // sim step
  decisionEveryTicks: 2, // carrier re-decides at this cadence
  // Replay sampling. 1s — dense enough that a pass (0.5–1.5s of flight), a
  // carry step, and a goal→kickoff reset are all VISIBLE as frames instead of
  // spline fiction between 6s keyframes (phase-2 verdict: the 6s replay read
  // as elastic mass drift with unclear possession). The viewer is t-based, so
  // cadence is a free choice per engine: the aggregate engine keeps its own
  // 6s frameDt and its replays play unchanged. Storage: ~2700 frames/half in
  // one JSONB blob, pruned after 4 matchweeks — fine at league scale.
  frameEverySeconds: 1,

  // ── pitch control (Spearman-style, coarse grid) ───────────────────────────
  pitchControlCols: 21, // 5 m cells across 105 m
  pitchControlRows: 14, // ~4.9 m cells across 68 m
  arrivalTimeReactionSeconds: 0.7, // velocity carries the player through this window
  controlSteepness: 4, // logistic slope on best-arrival-time differential (per second)
  maxAccelMps2: 6, // ×(acceleration/20) at use sites — accel phase of the arrival model

  // ── positioning ────────────────────────────────────────────────────────────
  anchorPull: 1.0, // weight toward the phase anchor
  ballAttraction: 0.35, // attractor: ball position
  markingAttraction: 0.5, // attractor: assigned opponent (out of possession)
  markingRadiusM: 16, // opponents beyond this aren't picked up
  spaceRepulsion: 0.3, // repulsor: teammate crowding
  repulsionRadiusM: 8,
  maxSpeedMps: 7.5, // scaled by pace/20 at use sites
  cruiseSpeedShare: 0.35, // jog share of max speed for near-target shuffles
  urgencyDistM: 10, // target this far away → full sprint
  // ── motion smoothing (the yoyo fix) ──────────────────────────────────────
  // Targets recompute every tick from moving attractors (ball pulls, marking
  // pickups, press membership), so raw target-chasing reverses direction
  // tick-to-tick — the oscillation the replay made visible. Players hold
  // still inside a small deadzone and carry momentum through target changes.
  // ── block frame (EA-sim compactness reference, phase 2 iter 2) ───────────
  // Real teams play as ONE compact mass that travels with the ball: in the
  // reference footage all 20 outfielders occupy about a third of the pitch,
  // far areas empty except the GKs. Mechanism: each side's anchor shape is
  // re-centred toward the ball (gain), compressed front-to-back (depth
  // scale), clamped so the block never parks inside either box, and tucked
  // toward the ball's side laterally. gain 0 = the legacy spread-out shape.
  blockFollowGain: 0.5, // how far the shape's centre travels toward the ball
  blockDepthScale: 0.75, // front-to-back compression of the anchor spread
  blockCenterMinM: 24, // centre never closer than this to either goal line
  blockTrackYGain: 0.25, // lateral tuck toward the ball's flank
  // Zone discipline — the compact block's necessary other half. Duels fire by
  // proximity, so compressing 20 players around the ball multiplied contact
  // rates and open play collapsed (screen: goals 1.3–2.0, shots 7–9). Real
  // compact blocks shepherd: only ENGAGED players (the positioning model's
  // direct set — pressers, loose/drop chasers, keepers) attack the ball at
  // full aggression; zone-holders react only to balls practically at their
  // feet and rarely dive into tackles.
  zoneReachShare: 0.45, // unengaged defenders' interception reach multiplier
  zoneEngageShare: 0.4, // unengaged nearest-man challenge-attempt multiplier
  moveDeadzoneM: 0.7, // already this close to the target → stand, don't micro-hunt
  accelSmoothing: 0.65, // per-tick blend of velocity toward the desired vector (1 = legacy instant turn)
  // Shape targets (anchor/marking/compactness blends) get an EMA with this
  // time constant before the kinematics see them: a possession flip re-bases
  // every non-engaged player's target at once (line-height toggle + phase
  // anchor swap), and without smoothing the whole block lurches end-to-end —
  // the "spring" the phase-2 replay verdict named. Direct chases (carrier,
  // presser, loose/drop chaser, receiver, GK) are EXEMPT: reactions stay
  // sharp, only the off-ball shape breathes.
  shapeTargetTauS: 2.0, // out of possession — the defensive block is the visible sloshing mass
  // In possession the smoothing must be light: at 2s everywhere the n=40
  // screen showed attackers easing into the box instead of attacking it —
  // aerial duels fell out of band (26.5–28.1 vs 30–50) and goals sagged ~0.2.
  // Off-ball runs are the attacking mechanism; they get a fast constant.
  shapeTargetTauAttackS: 0.8,
  fatigueSpeedPenalty: 0.45, // ×(1 − penalty·fatigue)
  lineHeightShiftM: 12, // defensive base x shift across lineHeight 0→1
  widthSpreadBase: 0.7, // y spread = base + gain×width
  widthSpreadGain: 0.6,
  compactnessPull: 0.4, // ×team.compactness toward team centroid, out of possession
  pressPullWeight: 1.7, // nearest defenders chase the ball
  pressersCount: 2, // how many join the press
  pressMaxDistM: 30, // base chase radius, scaled by pressTrigger at use site
  pressRangeBase: 0.6, // chase range = pressMaxDistM × (base + gain·pressTrigger)
  pressRangeGain: 0.8, // trigger 0.9 chases from ~40 m; 0.1 from ~20 m
  counterPressRangeBoost: 1.3, // gegenpressing window: wider net, extra body
  forwardRunPull: 0.3, // ×(offTheBall/20), possession phases, off-ball players
  gkBoxX: 5.5, // GK holds this deep
  gkBallTrackY: 0.3, // GK lateral ball tracking share

  // ── decision ───────────────────────────────────────────────────────────────
  // EV REBUILD (DECISIONS 2026-09-01): every option is scored in ONE honest
  // currency — expected goals this possession chain. A shot is worth its xG;
  // a pass is worth P·PV(target) − κ(1−P)·PV_opp(target) on the possession-
  // value surface below. The old cardinal constants (shotBaseScore −0.76
  // etc.) were noise-fitted and are GONE, not re-tuned — the four-point
  // temperature bracket (PR #39) falsified that whole regime.
  // Temperature now means "how often a player picks a slightly-worse option"
  // on the xG scale: EV gaps run ~0.01–0.15, so T≈0.04 = mostly-best-with-
  // variance, never deterministic.
  softmaxBaseTemperature: 0.04,
  temperaturePerDecisionsPoint: 0.002, // T = base − k·(decisions−10), floored
  temperatureFloor: 0.012,
  // sharpness (condition/sharpness split; league layer feeds 0–1, 1 = sharp).
  // MEDIUM by design: full-unsharp ≈ −2 decisions points on the choice
  // channel (0.004 / 0.002-per-point) — a marginal call flips, a star doesn't
  // become filler (magnitudes rescaled with the EV rebuild; the realism
  // sharp suites re-verify the medium weight). Decision + fatigue layers
  // ONLY: execution noise stays attribute-driven (frozen invariant).
  sharpnessTemperaturePenalty: 0.004, // T += this · (1 − sharpness)
  pressureTemperatureGain: 0.05, // pressure's rushed-thinking share of T (EV scale)
  sharpnessFatigueGain: 0.5, // fatigue accrual ×(1 + this·(1 − sharpness)) — condition drains faster when rusty
  composurePressureRelief: 0.02, // pressure penalty attenuation per composure point
  pressureSecondWeight: 0.5, // second-nearest opponent's share of felt pressure
  passOptionCount: 5, // geometric candidates per decision (vision widens toward this)
  carryOptionCount: 3, // forward + two diagonals
  riskAppetiteScoreBias: 0.024, // instructions bias SCORING only (frozen invariant; EV units, centered)
  riskTurnoverDiscount: 0.8, // riskAppetite shrinks the turnover-cost term
  // score-state behavior (DECISIONS.md): chasing teams open up, leading teams
  // see the game out. scoreState ∈ [−stateMax, stateMax], positive = chasing,
  // from goal difference × (base + timeGain·matchFraction). Decision biases +
  // positioning shifts only — execution noise stays attribute-driven.
  stateUrgencyBase: 0.25,
  stateUrgencyTimeGain: 1.0,
  stateMax: 1.1,
  stateRiskTurnoverDiscount: 0.32, // chasing discounts turnover fear (tempered)
  stateShotBias: 0.02, // chasing shoots earlier (EV units)
  stateHoldBias: 0.02, // chasing hates holding; leading loves it (EV units)
  statePushShiftM: 7, // team base line shifts this far at full urgency
  stateForwardRunGain: 0.5, // chasing off-ball runs push harder
  stateGapTaper: 0.3, // each extra goal of deficit adds only this much urgency
  stateLeadCautionShare: 0.6, // leaders keep this share of the see-it-out shift
  homeExpansiveness: 0.3, // constant home scoreState offset — expansive hosts
  // instruction biases — EV units, CENTERED on 0.5 (a default slider is a
  // strict no-op by construction); ±bias at the extremes
  shootingBiasScoreBias: 0.03,
  holdPositionScoreBias: 0.02,
  dribbleBiasScoreBias: 0.015,
  crossBiasScoreBias: 0.04,
  // option geometry
  passRangeM: 30, // beyond → longPass (lofted)
  leadPassM: 2.5, // targets lead the receiver toward goal
  throughLeadM: 9, // through-ball variant: hard lead into space
  throughOptionCount: 2, // for the most advanced mates
  ambitiousOptionCount: 2, // most-advanced onside mates beyond the nearest set
  shotRangeM: 26,
  crossWideYOffsetM: 13, // |y − 34| beyond this in the final third → crossing zone
  // the #42 carry-physics fix, applied IN-ROUND with the ball-flight model
  // (fixing either alone reshuffles the excess into the other): 8m per 1s
  // decision was 8 m/s WITH the ball — above the 7.5 m/s sprint cap, carriers
  // unchaseable by construction. 4.5 m/s is a fast dribble.
  carryStepM: 4.5,
  clearOwnRelXM: 30, // inside own-relative x AND pressured → clear is an option
  clearPressureFloor: 0.45,
  // ── the possession-value surface (EV currency: expected goals) ────────────
  // PV(p) = floor + max·(x_rel/105)^exp × width-taper — the simple xT-style
  // grid-as-formula (stop-rule honored: no learned grid). Anchors: own box
  // ~0.01, midfield ~0.05, box edge ~0.2, penalty spot ~0.27 — so a 0.3-xG
  // chance BEATS keeping the ball there, and a box-edge shot (0.08) LOSES to
  // retaining possession (0.2): shoot-vs-play falls out of the units.
  // shooter optimism: a small documented behavioral bias — players overrate
  // shots (half of real shots are speculative range efforts). This supplies
  // the low-xG mix that pure EV never chooses; execution still converts at
  // honest shotQuality, so optimism costs goals exactly like real punts do.
  shotOptimism: 0.012,
  pvMax: 0.341,
  pvProgressExp: 3.0,
  pvPeakXRelM: 94, // PV plateaus at the penalty spot — the byline is worth LESS, not more
  // the keeper's area is not dribble-through-able: the GK claims/smothers a
  // carrier this close to goal (rational play exposed that nothing else
  // stops a carry to the goal line)
  keeperClaimRadiusM: 8,
  keeperClaimBase: 0.381, // per tick inside the radius, ×(0.5 + gkPositioning/20)
  pvWidthPenalty: 0.35,
  pvFloor: 0.01,
  // EV scoring: P·PV(target) − κ(1−P)·PV_opp(target); κ modulated by risk
  // appetite + score state exactly as before (unit-free multipliers)
  valueControlWeight: 0.05, // pitch-control fold into PV(target) — EV units
  turnoverCostWeight: 1.0,
  // hold/clear — principled context terms on the same PV scale
  holdRiskBase: 0.04, // dispossession risk while holding, unpressured
  holdRiskPressureGain: 0.3, // + this × pressure
  holdDecay: 0.88, // holding never creates value by itself
  tempoHoldPenaltyEv: 0.02, // high tempo teams hate standing on the ball (EV units)
  // turnovers launch COUNTERS: their value on winning the ball is the static
  // surface plus a transition premium that grows the deeper WE were — this is
  // what prices a sloppy final-third giveaway (static PV alone made it free)
  counterPremium: 0.121,
  clearKeepShare: 0.35, // a clearance is a contested 65/35 giveaway…
  clearEscapeGain: 0.5, // …that buys out of pressure×PV_opp(here) danger
  xtProgressExp: 1.6, // positionValue = (x_rel/105)^exp × width falloff (legacy surface: positioning/heatmaps)
  xtWidthPenalty: 0.5,
  passBaseLogit: 1.919, // P(complete) logit intercept
  passSkillLogit: 1.0, // ×(skill/20 − 0.5)·2
  passDistDecayM: 20, // logit −d/decay
  laneRiskLogit: 2.652, // ×(1 − nearest-opponent-to-lane / laneRadius)
  laneRadiusM: 4,
  controlCompletionLogit: 4.279, // ×(ourControl(target) − 0.5)
  carryBaseLogit: 1.0,
  carryPressureLogit: 2.2,
  // (shotBaseScore/shotValueWeight/holdBaseScore/holdPressurePenalty/
  //  clearBaseScore/clearPressureGain: DELETED — noise-fitted cardinals,
  //  replaced by the EV formulas in agent-decision.ts)
  // shared xG proxy (decision scoring now, shot/GK models in parts c–d)
  xgMax: 0.45,
  xgDistDecayM: 11,
  xgCentralityFloor: 0.25, // angle factor: floor + (1−floor)×centrality

  // ── pressing challenges (Phase B, DECISIONS 2026-09-01) ───────────────────
  // The mechanism the press sweep needed: defenders close enough to the
  // carrier ATTEMPT to win the ball — an attribute duel, frequency scaled by
  // the challenger's pressingIntensity and the team's pressTrigger. This is
  // how press↑ produces turnovers/ppda↓/fouls, through play, not a knob.
  challengeRadiusM: 2.901, // a defender this close may engage the carrier
  challengeAttemptBase: 0.079, // per tick in radius, ×(0.5+intensity)×(0.5+trigger)
  challengeDuelLogit: 0.9, // ×(tackler duel skill − carrier retention skill), sigmoid
  challengeFoulShare: 0.282, // failed challenges that clip the man — feeds the card ladder
  challengeGraceTicks: 2, // a fresh receiver can't be stripped for this many ticks (1s)
  // ── reception pressure (the buildup-zone action supply) ───────────────────
  // Rational play made deep builders challenge-immune (they release on the
  // exact tick the grace expires), collapsing ppda/foul supply. The missing
  // physics is the PRESSED FIRST TOUCH: a presser arriving on the receiver
  // forces an error sometimes — defender bite (tackling/aggression) vs
  // carrier control (firstTouch/composure), scaled by pressing intensity.
  receptionPressRadiusM: 4.340, // presser this close at the moment of reception
  receptionErrorBase: 0.218, // ×(0.5+intensity)×(0.5+trigger) attempt rate
  receptionDuelLogit: 1.0, // duel slope, same shape as challenges
  receptionFoulShare: 0.18, // won duels that came through the man — card ladder

  // ── ball flight (Phase 1: real travel, receiver runs, spatial races) ──────
  // A kicked ball is a first-class in-flight object: it moves along its
  // (noised) path at the family speed while the world keeps ticking —
  // receivers RUN to arrival points, defenders converge, and interception is
  // WHERE BODIES MEET THE BALL, not an abstract completion roll. This is the
  // mechanism the goals floor demanded (DECISIONS 2026-09-03: instant arrival
  // teleported receivers 10–25m per completion with zero elapsed time).
  ballInterceptRadiusM: 1.1, // a GROUND ball passing this close to an opponent is playable
  ballInterceptAnticipationGain: 0.4, // reach ×(1 − g/2 + g·anticipation/20): reading the game widens reach
  // playable ≠ taken: a driven ball flashing past a boot is an ATTEMPT —
  // full probability only on dead-center contact, one try per defender per
  // flight (a beaten defender doesn't get a second bite at the same ball)
  ballInterceptTakeBase: 0.384,
  // take ×(1 − g/2 + g·anticipation/20): reading the game converts reach into
  // takes — the attribute-expression half of interception (reach is the other).
  // 0 = flat takes (no-op multiplier).
  ballInterceptTakeSkillGain: 0,
  ballReceiveRadiusM: 1.6, // arrival: a body this close to the drop can take the ball
  // drop-chase gate slack: how late a defender may arrive and still contest.
  // A driven ball is gone when it's gone; a HANGING ball is contestable at
  // the bounce — high balls invite bodies (this is where aerial duels live)
  dropChaseSlackGroundS: 0.4,
  dropChaseSlackLoftedS: 1.6,
  interceptControlBase: 0.454, // P(clean control | intercepted) = base + gain·firstTouch/20
  interceptControlGain: 0.4,
  ballDeflectScatterM: 3.0, // failed control: the ball squirts loose this far (gauss)
  shankDirNoiseMul: 2.5, // a technically-missed pass is a REAL bad ball: extra scatter
  shankVelNoiseMul: 2.0,
  // BLOCKED RELEASE: a pass struck under a presser's nose can hit his legs —
  // the loose-ball moment every crowded midfield produces. Rate rides felt
  // pressure; the blocker's anticipation reads the release.
  ballBlockBase: 0.17, // ×pressure ×(0.5 + anticipation/20), at kick, pressure > floor
  ballBlockPressureFloor: 0.357,
  ballBlockScatterM: 2.5,

  // ── execution ──────────────────────────────────────────────────────────────
  passDirectionNoiseRad: 0.12, // ×(20 − passing)/20 at use sites
  longPassDirectionNoiseRad: 0.2, // reads longPassing, never passing
  crossDirectionNoiseRad: 0.18, // reads crossing
  passVelocityNoise: 0.1,
  shotDirectionNoiseRad: 0.15, // reads finishing (feet) / heading (headers)
  carryNoiseM: 0.6, // dribbling-scaled waypoint scatter
  receiveNoiseM: 1.2, // firstTouch-scaled trap scatter
  aerialHeightCmWeight: 0.02, // duel score: height contribution per cm over 170
  aerialJumpingWeight: 0.6,
  aerialHeadingWeight: 0.4,
  aerialStrengthWeight: 0.25,
  gkAerialHandsBonus: 2, // keepers can catch — a reach edge in claim contests
  aerialArrivalPerSecond: 3, // duel-score points per second of arrival advantage
  aerialNoiseSigma: 2,
  // success resolution (execution owns the strike; the FLIGHT owns the outcome)
  groundPassSpeedMps: 14,
  loftedPassSpeedMps: 16, // chord speed of the arc — hang time favors defenders
  // (raceSteepness/interceptOffsetS/anticipationRaceS: DELETED — the
  //  pre-resolved probabilistic interception race is replaced by the real
  //  in-flight spatial race; anticipation now widens interception REACH)
  execComposureRelief: 0.025, // pressure attenuation ×composure (execution side)
  passExecBaseLogit: 1.9, // technical completion given no interception
  passExecSkillLogit: 1.8, // ×(attr/20 − 0.5)·2
  passExecPressureLogit: 1.0,
  loftedSkillExtraLogit: 1.8, // longPassing/crossing bite harder on lofted balls
  carryExecBaseLogit: 2.2,
  carryExecSkillLogit: 1.2,
  carryExecPressureLogit: 1.8,
  carryControlLogit: 0.8, // ×(ourControl(end) − 0.5)
  shotOnTargetBase: 0.0,
  shotSkillLogit: 1.0,
  shotDistDecayM: 14, // logit −d/decay
  shotPressureLogit: 0.8,
  gkBeatBase: -0.05, // P(goal | on target) logit vs keeper quality
  gkXgWeight: 3.0, // ×(xgProxy − 0.1): big chances beat keepers
  gkQualityLogit: 1.2, // ×(mean(gkReflexes, gkPositioning)/20 − 0.5)·2

  // ── phases ─────────────────────────────────────────────────────────────────
  counterPressSeconds: 6, // window after losing the ball (types.ts note: ~6 s)
  counterAttackSeconds: 6, // window after winning it, opponent unset
  finalThirdX: 70, // own-relative x beyond which possession is 'finalThird'
  buildUpX: 35, // below which controlled possession is 'buildUp'

  // ── events: fouls / cards / injuries / offsides / set pieces ──────────────
  foulPerTackle: 0.14, // P(foul | failed-carry challenge), aggression-scaled
  aggressionFoulGain: 0.4, // ×(1 + gain·(aggression/20 − 0.5))
  aerialFoulRate: 0.02, // duel loser brings the man down
  yellowPerFoul: 0.17,
  redPerFoul: 0.0068, // straight red; second yellow also sends off
  bookedCautionFactor: 0.1, // players on a yellow tackle carefully
  boxFoulFactor: 0.18, // nobody dives in inside their own box
  injuryPerTickBase: 0.0000024, // ≈ 3.2%/player/match at 10800 ticks incl fatigue gain
  injuryFatigueGain: 1.0, // hazard ×(1 + gain·fatigue)
  offsideToleranceM: 0.5, // linesman: receiver this far beyond the second-last defender → flagged
  // Passers now judge STRICTLY (accept only receivers at/behind the line):
  // the old +1.5m judgement band made every band-sitting pass a
  // deterministic same-tick offside (~20/team-match with realistic squads —
  // DECISIONS 2026-08-30). Offsides instead come from MISTIMED RUNS below.
  passerLineJudgementM: 0, // accept receivers up to line+this — 0 = at the line
  // ── mistimed runs (the offside model) ─────────────────────────────────────
  // A receiver riding the line (within rideZone of it) on a forward pass
  // occasionally mistimes the run — keyed draw, better off-the-ball movement
  // strays less. This is where offsides come from now; the geometric flag
  // stays as a backstop for genuinely-beyond receivers.
  offsideRideZoneM: 3.5, // "on the shoulder" = within this of the second-last defender
  mistimedRunProb: 0.024, // per risky (line-riding, forward) pass; harness squads ride ~160/match → ~2.4 offsides (real ~2.2)
  offsideTrapGain: 0.8, // mistime prob ×(0.6 + this·defLineHeight): a high line IS the trap
  offsideTimingSkill: 0.5, // ×(1 − skill·(offTheBall/20 − 0.5)·2): OTB 20 halves it, OTB 0 ×1.5
  lineHoldBufferM: 2.0, // attackers hold this far INSIDE the line (onside-safe hover)
  penaltyGoalProb: 0.76,
  cornerProb: 0.638, // P(corner | saved/off target) — deflection/parry supply at ~11-shot volume
  setPieceHeaderXgFactor: 0.41, // headers convert worse than feet from the same spot
  setPieceDeliveryNoiseM: 3.5, // ×(20 − setPieceDelivery)/20
  homePressureRelief: 0.348, // re-fit for the flight-physics pressure economy (was 0.45: pressure gained teeth — blocks/challenges/receptions — and the one home mechanism over-compounded to 0.51-0.56 home share) // crowd effect: home carrier feels less pressure

  // ── bookkeeping ────────────────────────────────────────────────────────────
  fatiguePerTick: 0.00007, // ~0.24/half at tick 0.5 s before stamina scaling
  fatigueWorkShare: 0.9, // share of the tick's fatigue that scales with distance run
  staminaFatigueRelief: 0.5, // ×(1 − relief·stamina/20)
  ppdaZoneOwnRelXM: 55, // build-up zone: passer's own-relative x below this
  ratingGoalBonus: 0.8, // playerRatings: base 6.5 ± these
  ratingAerialBonus: 0.05,
  ratingCardPenalty: 0.4,
} as const;

// ── CALIBRATION-ONLY override hook ───────────────────────────────────────────
// AGENT_CAL_OVERRIDES='{"knob":value,...}' patches AGENT_CAL at module load —
// the joint-search evaluator's injection point (parallel candidates without
// per-candidate source patches). Same discipline as the league test overrides:
// one env var, loud at load, visible in `fly config show`, and the go-live
// checklist rule applies — it must NEVER be set on a production machine.
if (process.env.AGENT_CAL_OVERRIDES) {
  const overrides = JSON.parse(process.env.AGENT_CAL_OVERRIDES) as Record<string, number>;
  for (const k of Object.keys(overrides)) {
    if (!(k in AGENT_CAL)) throw new Error(`AGENT_CAL_OVERRIDES: unknown knob ${k}`);
  }
  Object.assign(AGENT_CAL, overrides);
  console.warn(`⚠️ AGENT_CAL overridden (calibration run): ${process.env.AGENT_CAL_OVERRIDES}`);
}

// ── world state ───────────────────────────────────────────────────────────────

export type Side = 'home' | 'away';

/** Mutable per-player sim state. Positions are GLOBAL frame (home attacks +x). */
export interface AgentState {
  id: string;
  side: Side;
  isGk: boolean;
  pos: Vec2;
  vel: Vec2;
  attributes: Attributes;
  instructions: PlayerInstructions;
  /** per-phase anchors in GLOBAL frame (away anchors pre-flipped at setup) */
  anchors: Record<Phase, Vec2>;
  fatigue: number; // 0–1, grows during the half
  /** match sharpness 0–1, fixed for the half (league-layer input; 1 = sharp) */
  sharpness: number;
  yellows: 0 | 1;
  sentOff: boolean;
  injured: boolean;
  startMinutes: number; // carried from resume state
  startFatigue: number;
  /** EMA'd shape target (transient, per half — NOT in HalfTimeState; a fresh
   * half re-seeds it from the player's position, deterministically) */
  shapeTarget?: Vec2;
}

/** Read-only view handed to the sub-models each tick. */
export interface AgentSnapshot {
  readonly id: string;
  readonly side: Side;
  readonly isGk: boolean;
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly attributes: Attributes;
  readonly instructions: PlayerInstructions;
  readonly fatigue: number;
  readonly sharpness: number;
}

/** A kicked ball travelling through the world (Phase 1 ball-flight model). */
export interface BallFlightPath {
  from: Vec2;
  to: Vec2;
  speedMps: number;
  /** meters already travelled along from→to */
  travelledM: number;
  kickerId: string;
  kickerSide: Side;
  /** intended receiver (runs onto the ball); null for clears */
  receiverId: string | null;
  actionType: 'pass' | 'longPass' | 'cross' | 'clear';
  /** the kicked trajectory; lofted/high are unplayable mid-flight and are
   *  contested at the drop point instead */
  flightEnum: BallFlight;
  /** kick timestamp + a per-half sequence for keyed draws + event emission */
  kickT: number;
  flightId: number;
  /** technically clean strike (a shank still flies, just somewhere worse) */
  cleanStrike: boolean;
  /** the raw trajectory left the pitch: dead at `to`, restart to the other side */
  outOfBounds: boolean;
  /** defenders who already tried (and failed) to take this flight */
  attempted: Set<string>;
}

export interface BallState {
  pos: Vec2;
  flight: BallFlight;
  /** player in control, or null while the ball travels / is contested */
  carrierId: string | null;
  /** side last in control — drives phase inference while the ball travels */
  lastTouchSide: Side;
  /** non-null while a kicked ball is travelling (carrierId is null then) */
  inFlight: BallFlightPath | null;
}

/** One team's static context for the half. */
export interface TeamContext {
  side: Side;
  tactics: Tactics;
  playerIds: string[]; // active (sent-off excluded)
}

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;

export const clampToPitch = (p: Vec2): Vec2 => ({
  x: Math.min(PITCH_LENGTH, Math.max(0, p.x)),
  y: Math.min(PITCH_WIDTH, Math.max(0, p.y)),
});

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Time for one player to reach a point: the reaction window carries them at
 * their current velocity, then they accelerate toward the point up to vmax.
 * vmax scales with pace and fatigue, the acceleration phase with the
 * acceleration attribute (kinematics: d_accel = vmax²/2a).
 */
/**
 * Value of holding the ball at a point for the side attacking goalX — an
 * xT-style proxy: grows toward the opponent goal (power curve), damped
 * toward the touchlines. In [0, 1].
 */
/**
 * Possession value in EXPECTED-GOALS units: P(this possession chain ends in
 * a goal | ball at p). The decision layer's single currency — a shot's xG
 * and a pass target's PV are directly comparable. Simple xT-style formula
 * (power curve to goal, tapered wide); anchors documented at the knobs.
 */
export function possessionValue(p: Vec2, goalX: number): number {
  const xRel = goalX === 0 ? PITCH_LENGTH - p.x : p.x;
  // plateau at the spot: possession ON the byline is not more valuable than
  // at the penalty spot — without this, rational carriers dribble to x=105
  const progress = Math.pow(Math.min(AGENT_CAL.pvPeakXRelM, Math.max(0, xRel)) / PITCH_LENGTH, AGENT_CAL.pvProgressExp);
  const widthTaper = 1 - AGENT_CAL.pvWidthPenalty * Math.pow(Math.abs(p.y - PITCH_WIDTH / 2) / (PITCH_WIDTH / 2), 2);
  return AGENT_CAL.pvFloor + AGENT_CAL.pvMax * progress * widthTaper;
}

/**
 * Agent-side shot quality: xgProxy × the SHOOTING-ANGLE reality — the goal's
 * subtended angle from the shot position, normalized to the penalty spot.
 * Kills the byline exploit (rational carriers drove to x=105 where distance-
 * only xg peaks; the actual angle there is ~zero). AGENT ENGINE ONLY —
 * xgProxy itself is shared with the aggregate engine and stays frozen.
 */
export function shotQuality(shotPos: Vec2, goalX: number): number {
  const postNear = { x: goalX, y: PITCH_WIDTH / 2 - 3.66 };
  const postFar = { x: goalX, y: PITCH_WIDTH / 2 + 3.66 };
  const a1 = Math.atan2(postNear.y - shotPos.y, postNear.x - shotPos.x);
  const a2 = Math.atan2(postFar.y - shotPos.y, postFar.x - shotPos.x);
  let subtended = Math.abs(a1 - a2);
  if (subtended > Math.PI) subtended = 2 * Math.PI - subtended;
  const ref = 2 * Math.atan(3.66 / 11); // the angle from the penalty spot
  return xgProxy(shotPos, goalX) * Math.min(1, subtended / ref);
}

export function positionValue(p: Vec2, goalX: number): number {
  const xRel = goalX === 0 ? PITCH_LENGTH - p.x : p.x;
  const progress = Math.pow(Math.max(0, xRel) / PITCH_LENGTH, AGENT_CAL.xtProgressExp);
  const widthFalloff = 1 - AGENT_CAL.xtWidthPenalty * Math.pow(Math.abs(p.y - PITCH_WIDTH / 2) / (PITCH_WIDTH / 2), 2);
  return progress * widthFalloff;
}

/**
 * Shared xG proxy — distance decay × centrality. Used by decision scoring
 * now, and by the shot/GK resolution models (parts c–d) so the two never
 * disagree about what a good chance is.
 */
export function xgProxy(shotPos: Vec2, goalX: number): number {
  const d = dist(shotPos, { x: goalX, y: PITCH_WIDTH / 2 });
  const centrality = 1 - Math.min(1, Math.abs(shotPos.y - PITCH_WIDTH / 2) / (PITCH_WIDTH / 2));
  const angleFactor = AGENT_CAL.xgCentralityFloor + (1 - AGENT_CAL.xgCentralityFloor) * centrality;
  return AGENT_CAL.xgMax * Math.exp(-d / AGENT_CAL.xgDistDecayM) * angleFactor;
}

export function arrivalTime(p: AgentSnapshot, x: number, y: number): number {
  const vmax = Math.max(
    0.5,
    AGENT_CAL.maxSpeedMps * (p.attributes.pace / 20) * (1 - AGENT_CAL.fatigueSpeedPenalty * p.fatigue),
  );
  const accel = Math.max(0.5, AGENT_CAL.maxAccelMps2 * (p.attributes.acceleration / 20));
  const tReact = AGENT_CAL.arrivalTimeReactionSeconds;
  const px = p.pos.x + p.vel.x * tReact;
  const py = p.pos.y + p.vel.y * tReact;
  const dx = x - px;
  const dy = y - py;
  const d = Math.sqrt(dx * dx + dy * dy);
  const dAccel = (vmax * vmax) / (2 * accel);
  const tRun = d <= dAccel ? Math.sqrt((2 * d) / accel) : vmax / accel + (d - dAccel) / vmax;
  return tReact + tRun;
}

