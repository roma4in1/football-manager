# DECISIONS

Running log of decisions that aren't obvious from the types or schema alone.
Newest first. Keep entries short: what, why, where enforced.

## 2026-07-21 — Round: lead a runner, play feet to a stepper; attack the lone man; shoot

Three judgments, each landed in ISOLATION (the night's lesson) with the
suite verified between:

- **The down-the-line interception**: the passer's lead extrapolated the
  receiver's velocity over the FULL flight (1.3–1.8 s ≈ 8–10 m), aiming
  balls deep and dragging receivers off their spots to chase their own
  pass. Feet balls now lead ≤0.7 s; RUNNING mates (>3.5 m/s) and through
  candidates keep the real lead — you lead a runner, you play a stepping
  man to feet. Bonus cascade: line-vs-runs splitting balls 7 → 16/16.
- **The wide-then-center arc**: the isolation principle (from the L5e
  brief, landed standalone): a defender with no cover within 12 m is half
  the pressure — attack the lone man, respect the covered one. Front
  duels and runs verified pinned.
- **Shooting desire**: carry future-xG discount 0.5 → 0.38 — shoot-now
  beats carry-closer sooner. line-vs-runs: 16/16 shoot, 7 from range
  (was 3), avg first shot 16.2 m, 15 central squares.

59/59; dial 16/16 both poles; wall/runs/front-duels pinned.

## 2026-07-21 — L5e: the duel state machine needs a DESIGNED session (stop-rule; branch = design brief)

A full exploratory build of L5e (jockey, track, engage-score, stagger,
knock-and-go, dart-tracking) was BUILT, MEASURED, and REVERTED — ten
iterations of whack-a-mole where every fix inverted the guardrail
(close/heavy through-rates swung 0↔16 in both directions). The pieces
are correct individually and COUPLED fatally: they form one state
machine (jockey ↔ track ↔ engage ↔ staggered/beaten) that must be
designed with hysteresis and intercept geometry as a unit. Findings that
survive as the design brief:

- **The jockey needs two modes**: backpedal-capped (~4.5 m/s, facing
  play) vs a SLOW carrier; full-speed goal-side TRACKING vs one at pace
  (the cap alone donates a permanent 4 m escort trail).
- **Never duel from the wrong side**: a trailing ball-chase can never
  pinch (the ball is always ahead of the carrier) — engage only
  goal-side/alongside; otherwise cut the path ahead to REGAIN the side.
- **The no-man's band kills everything**: jockey hold (2.0 m), engage
  range (2.6 m), and the attacker's arc (2.2–2.7 m) must be designed
  together or nothing ever engages.
- **The failed lunge is the beaten moment**: without a stagger (~0.8 s
  planted), repeated 27% tackles compound to inevitability over any
  crawl (16/16 defender wins vs elite close control).
- **Engagement pressure grows with jockey time** (delay = waiting for
  support; support may not come) and spikes on a STOPPED carrier.
- **The knock-and-go is the attacker's half** (jockeyed + space behind →
  self-pass past the shoulder + race): its clearance is DEFENDER-relative
  (the knock-past drill's too-tight lesson recurs in EV form) and it
  requires the isolation principle below or it never fires.
- **Attack the isolated man**: carry pressure from a defender with no
  cover within ~12 m should discount (~0.45) — one lone jockey was
  repelling a close-control carrier from half the pitch (a 16 s orbit of
  his own half, measured).
- **Dart-tracking cannot be naive**: goal-side man-tracking of runners
  drags line members out (goal-side integrity 75% → 27%) — tracking must
  HAND OFF along the line (the mark-switch run from defender_runs), which
  is itself part of the state machine.
- Both duel sides must be brains, and the shield floor must not exceed
  deep-field carry EV (0.03 froze carriers at kickoff; now-known, to
  re-apply in the session: shieldUtility ≈ 0.014).

Codebase reverted to the green L5d state (59/59, all rates pinned).
The L5e session builds the machine from this brief.

## 2026-07-21 — L5d starvation redesign DEFERRED (builder decision); L5e opens

The support-angle starvation (round 6's stop-rule finding) waits for its
coherent redesign pass; the grid stands judgeable at 62:33 with zero
freezes meanwhile. Next sub-phase: L5e marking & duels — the jockey
guardrail (head-on close-control must fall to ~55–65%) comes due.

## 2026-07-21 — L5d round 6: pressure lowers the floor + an honest stop-rule report

The judged complaint (simple passes skipped; forced balls and dribbles
preferred) split three ways under measurement (49 pressed-carrier
decisions classified): 16 healthy, 12 DECISION FAULTS (a ≥0.55 ball
existed but the calm-conditions floor buried it), 21 STARVED (no
completable pass existed — a support-creation failure).

SHIPPED: the decision-fault fix — under a live press (opponent ≤3.5 m)
the pass floor drops ×0.8: you take the 60% ball rather than dying with
it. Faults 12 → 9, grid stable (62 transfers / 20 long / 0 freezes),
all rates and floors intact.

STOP-RULE REPORT (spec §10: a proven tension is a finding): the
STARVATION half resisted three local retunes, each verified harmful in
isolation — (a) untethered keep pass-value → far-corner attraction;
(b) wider support rings under tethered value → balls to roaming
supports devalued, grid collapse; (c) distance-damped untethered value
→ circulation collapse + a slide-test flip. The support-positioning ↔
pass-valuation ↔ floor system is INTERLOCKED and needs a coherent
redesign (one designed pass over supportSpot + keepValue + the pass
term together), not knob turns. Recorded as the open L5d item; the
grid remains judgeable (62:33 with zero freezes) meanwhile. 59/59.

## 2026-07-21 — L5d round 5: the switch lives and nobody freezes

The judged pair (grid-5v4, post-coverage): keepers refused long passes
and froze under the press. Two mechanisms:

- **The catch absorbs pace**: the grid arrive-cap computed roll-room
  beyond the destination with a hard floor — a boundary-line switch had
  ~2 m of room, so every long ball became a 3.4 s float that the press
  converged on (long = uncompletable = never chosen). The cap now
  credits the receiver's trap (cap = 4 + √(2·decel·room)): only the
  MISSED ball rolls out, and that risk is priced by pC, not banned.
- **The shield collapses under a live press**: with every lane covered
  and every carry taxed, shield won repeatedly — a pressed statue. With
  an opponent inside 3 m, shield's utility drops ×0.45: standing still
  under a closing press is the worst real option, so the best move wins.

Post: 64 transfers (19 LONG >16 m — switches live), 0 freezes, 35
losses (64:35 — competitive, press still strong), 5 dead balls. All
rates intact (wall-pass wait unaffected — the path-ball exemption
dominates its EV). Rondo circulation up again (128 transfers/8 seeds).
59/59.

## 2026-07-21 — L5d round 4: press-unit coverage — no line in a grid

The judged defect: the grid's four pressers overlapped and covered
useless space. Structural cause: non-engaged pressers fell back to
shapeSpot — a GOAL-PROTECTING LINE — which in a boundary grid stacked
all four at one shared depth.

- **pressCoverSpots** (decide.ts): a pressing unit's non-engaged members
  take DISTINCT assignments over the carrier's ranked passing options
  (lane k → nearest free defender, greedy, deterministic; leftovers
  compact onto the ball–centroid axis). Applies when pressing > 0.3 and
  the first defender is engaged; LINE units (pressing ≤ 0.3) keep L5c
  shape untouched.

Measured: min presser-pair distance now averages 4.6 m (was stacked),
2.3 of 4 lanes covered at any moment, and the grid flipped from 73
transfers / 25 losses to 33 / 69 — four ORGANIZED pressers in a tight
box genuinely suffocate five keepers. Balance knobs if the eye wants
the keepers favored: pressing intensity, cover depth (0.45), keeper
attributes. 59/59; rondo (2-man unit → lane-1 cover ≈ the old shadow)
and all rates intact.

## 2026-07-21 — L5d round 3: the positional grid (builder ask) — bounded 5v4

Scenario format gains BOUNDS (drill grids: a loose ball crossing them
goes dead, like the pitch edge) and the EV became bounds-aware — the
first sessions ended in seconds because keepers aimed and weighted
passes with full-pitch semantics and every miss rolled out dead:

- pass destinations outside the grid are skipped ("you do not pass to
  out"), arrival pace is capped so the roll-out DIES INSIDE (the thread
  room-cap, generalized), carry directions leaving the grid are not
  plans, run-through targets clamp to the box.

grid-5v4: five keepers (keep objective, pentagon homes) vs four pressers
(pressing 0.85) in a 32×32 box hugging the sideline (live trap trigger).
Nothing scripted. Across 8×50 s seeds: 73 transfers, 25 losses, 21
counterpressed back within 7 s, 6 dead balls, double-press 2%; label
distribution press 419 / shadow 345 / delay+shape 1755 / counterpress
373 — the whole collective-pressing vocabulary in one judgeable drill.
59/59.

## 2026-07-21 — L5d round 2: the curved press and the delay stance (pressing.md)

pressing.md's failure-case list named our residual defect exactly:
"wrong angle — player runs directly at ball → passing lane remains
open." Two mechanisms landed:

- **The curved press approach**: beyond 3 m, the first defender closes
  FROM the side of the lane being denied (pressApproach: carrier +
  1.4 m toward the most-open dangerous lane) — his body cover-shadows
  the escape as he arrives, forcing play the other way; the last 3 m
  hand over to the L3 hunt (contain + tackles need the chase command).
- **The delay stance** (the passive band): below the trigger threshold
  with the carrier within 11 m, the first defender holds off goal-side
  at ~4.5 m — slow the attack, wait for the trigger (also the seed of
  L5e's jockey).

Effect: rondo turnovers 10 → 19 per 8 seeds (the press became effective
through DENIAL, not swarming — double-press still ~1%), 15/19 regained
within 7 s. pressing.md mapped in REFERENCES.md; false press, waves,
man-orientation, trap direction recorded for L5e/L6. 59/59; dial and
all rates intact.

## 2026-07-21 — L5d round 1: coordination is real — election, demotion, controlled duels

Two judged defects:

- **Duel launches**: a sprinting duel winner's claim got the runner's
  stride-weight touch (~8 m/s, an 18 m roll). A CONTESTED scramble claim
  (opponent within 3 m) is now a CONTROL touch (≤3 m/s — keep it in the
  duel). Post-tackle loose-ball speed caps ~5.3 m/s (≈8 m roll).
- **Both defenders chased the ball**: three compounding causes fixed —
  the first-defender election FLAPPED as the ball moved (now sticky: the
  engaged presser keeps the job unless clearly beaten); the shadow's
  lane choice used raw advancement (now OPENNESS-weighted completion —
  shadow the lane my teammates don't already close); and counterpress
  was a swarm with no election AND left demoted hunters with stale
  chase commands the defensive chain couldn't reclaim (counterpress now
  elects the nearest man, registers as a pressing state, and demotes
  cleanly into shadow/shape).

Post: double-press 0% (was ~100% pre-L5d, 9% mid-fix), shadow active,
presser hand-offs orderly. HONEST EQUILIBRIUM SHIFT: coordinated
pressing turns the ball over LESS (10 losses/8 seeds vs the swarm's 41)
— one press + one lane-shadow against four keepers is genuinely hard,
which is why the 4v2 rondo is a possession drill. The passers' EV
visibly avoids shadowed lanes (press-resistance emerging free). If the
eye wants more turnovers, the knobs are pressing aggression and trigger
thresholds — not more chasers. 59/59.

## 2026-07-21 — L5d OPENED: pressing — counterpress, the elected press, the shadow

Branch feat/engine2-l5d. The defensive chain (counterpress > press >
shadow > shape), from the defensive.md/defender_runs pre-specs:

- **Counterpress is INNATE** (transition instinct, not organization): the
  5–8 s window after losing the ball; chases loose or opponent-carried
  balls within 15 m; overrides stale attack commands; applies even to
  'keep' brains — the immediate hunt is literally the rondo's rule. The
  rondo transformed: 41 losses / 39 REGAINED within 7 s across 8 seeds
  (the chasers-keep-it-forever era ends).
- **Organized pressing is a KNOB** (instructions.pressing, default 0 —
  zero regression surface): trigger-scored per defensive.md (the receive
  moment, sideline traps, isolation, proximity), with exactly ONE
  first defender (nearest-elected). The rondo chasers upgraded from two
  blind scripted hounds to press brains: one presses, one shadows —
  double-press share fell from ~100% to 3%, circulation stayed healthy
  (94 transfers/8 seeds).
- **The shadow** (second defender): sits on the pressed carrier's best
  escape lane at 40% from the carrier (defender_runs' shadow press /
  passing-lane block).
- Contact unchanged: L3's contain/tackle machinery owns engagement.

Fallout: the continuity invariant allowed exactly vmax·DT — a collision
nudge while sprinting in a press scrum read as a teleport; the cap now
allows movement + the (newly capped, 0.5 m/tick) separation
displacement. 59/59; dial 16/16 both poles, runs/wall/threads intact.
Known-and-deliberate: line-vs-runs' shape-holding line (pressing 0)
still never engages — give it a pressing instruction to judge the full
chain; press-resistance interplay emerges free via the carrier's
existing pressure EV.

## 2026-07-21 — KDB completion DEFERRED to curve + aerials (builder decision)

The elite-passer decision terms are in (precision margin, lines broken,
uncuttable pace); the full across-the-defence ball waits for BALL CURVE
and AERIAL play — the flat 40 m diagonal is honestly dead on the ground.
Finish the De Bruyne kit when those physical passes land. L5c judgment
continues in parallel; next sub-phase: L5d pressing.

## 2026-07-21 — The elite passer (builder ask: replicating De Bruyne/Messi)

The design finding: in a true-state engine everyone already SEES
everything — elite vision is not perception, it is (a) SELF-KNOWLEDGE in
the risk model and (b) valuing what the pass DESTROYS. Three mechanisms
landed (decide.ts):

- **Precision buys margin**: pC gains (passing−14)·0.02 s of interception
  margin — the De Bruyne term: he attempts the ball because HIS version
  of it completes. Baselined at 14 so good pros don't inherit elite
  appetite (the first cut at −12 flipped the risk dial).
- **Lines broken**: every defender the pass puts behind the ball adds
  value beyond the destination (×0.016 × risk × passing/20) — the
  multi-line ball exists because this term exists. Risk-pure scaling
  (a floor of appetite at risk 0 also flipped the dial).
- **Fast balls are harder to CUT**: interception reaction +0.01 s per m/s
  over 8 — the missing second half of passing.md's "driven passes are
  harder to intercept" (the flat 0.35 s made every zipped diagonal
  cuttable).

Demonstrated at the honest scale (a 25 m one-line breaker): passing 12
DECLINES it (rates it 0.017, carries), 15 attempts it, 19 attempts it
decisively. The full 40 m cross-field diagonal measured honestly DEAD on
the ground (2.3 s of flight lets everyone converge — pC 0.018 at any
skill): the true across-everything KDB ball is AERIAL (lofted-driven,
~1.5 s, over the lines) — it arrives with the recorded aerial pass +
curve work, on top of these decision terms.

Fallout absorbed: the counter dial drill had been OUTGROWN — the run
machinery matured until the left thread was a safe killer ball and the
"risky pole" premise eroded; d2's recovery now covers the left channel
(the drill re-staged, not the model nerfed). passFloorBase re-seated to
0.80 as the lane model got honest. 59/59; threads 27/29 collected,
runs/wall/dial intact.

## 2026-07-21 — L5c round 5: threads die in the space

The judged overhits measured true and were NOT normal: 13 of 37
line-vs-runs threads rolled dead (35%) — many fired with only 9–11 m of
room behind an already-deep line, aimed line+4.5 with pace to spare,
straight over the dead-ball boundary.

- **No behind, no ball in behind**: the rider/driven candidates require
  ≥14 m of room behind the line (mirrors runPlan's own run gate).
- **The weight dies IN the space**: thread depth = min(4.5, 0.3·room)
  and the arrival pace is capped so the roll-out ends ~4 m short of the
  boundary (arrive ≤ √(2·decel·rollRoom)).

Post: 27/29 threads collected, 2 dead, 0 intercepted. Note for the
methodology file: two overlapping sed-style edits in one script silently
lost the first when the second's assert threw — verify grep after
multi-part patches. 59/59; runs/wall/dial intact.

## 2026-07-21 — L5c round 4: the shot economy — no infinite deferral

The judged shyness: attackers too scared of defenders, range shots
near-absent, and no square ball into the centre for a better look.
Structural cause: the carry's xG-gradient bonus (0.8·xG at the sample)
made "carry closer" ALWAYS out-value "shoot now" — infinite deferral —
while the pass EV had NO chance-creation term (passing.md lists it in
the pass score explicitly), so the square/cutback was invisible value.

- Carry future-xG discounted (0.8 → 0.5): the ball can be lost en route;
  shooting NOW is certain to at least be an attempt.
- Passes credit the RECEIVER'S shot (+0.6·xG at the destination, score
  objective) — the centre square ball now carries its true value.
- Shots considered from 30 m (was 26) — the EV decides if range is
  worth it.

Post: line-vs-runs 14/16 seeds shoot with 3 from range (>17 m, was 0)
and 4 central squares (was 0); runs/wall/dial/splits all intact. 59/59.

## 2026-07-21 — L5c round 3: the bend-receive — a runner never turns back for his ball

The judged wrongness (runs-in-behind): the runner stopped, turned, and
walked BACK to meet a thread played into his run — hold-up behavior with
no defender to hold up against. Cause: at release, the dart's velocity is
angled across the seam, so the strict in-stride check (current velocity,
±1 m corridor) failed and the STATION receive machine took over —
braking, turning, stepping back.

- **The bend-receive** (sim.ts): a runner whose thread is in flight bends
  (≤1.2 rad of current heading) onto the ball's PREDICTED PATH at pace —
  the earliest path point he reaches at current speed, no caps, no
  braking; the ball catches him up in stride. Gated to actual runners
  (bendReceive set, armed when the receive reflex fires for a body in
  runningLine) so the judged station/crossing receives are untouched.
- Post (wb-1): the striker runs forward the whole flight (4.4–5.3 m/s,
  never braking) while the ball closes along his path and arrives at
  d=1.1 in stride. runs-in-behind 16/16/16; all other rates intact.
  59/59.

## 2026-07-21 — L5c round 2: the splitting ball, carry courage, shots through legs

Three judged over-conservatism knobs (line-vs-runs) + passing.md mapped:

- **The splitting ball**: the sub-floor lane tax (×0.35 flat) crushed the
  threaded ball's payoff along with its risk — a speculative player never
  split a tight CB pair. The tax now rides risk (0.25 + 0.45·risk), and
  runners get a DRIVEN thread variant (passing.md #9/#13: less flight
  time beats closing defenders; the receiver pays the hot-arrival tax).
  Post: 8/16 line-vs-runs seeds thread the CB gap (was ~never).
- **Carry courage**: the pressure tax weight 0.8 → 0.55 — momentum and
  control mean a defender meters away is a problem, not half the spot's
  value (the judged dribble-away-from-everyone).
- **Shots are discounted, not vetoed**: the block corridor TAPERS with
  distance (0.45 m at the boot → wider downrange; the flat 0.9 m made any
  loitering body a veto) and point-blank costs ×0.35 instead of ×0.15 —
  shots go past close defenders and through legs. Striker-breakaway
  shots ROSE 13 → 15/16; line-vs-runs 16/16 shots, 3 under a defender
  within 3.5 m. The xG unit test re-pinned to discount-not-veto.

59/59; dial and wall-pass rates intact.

## 2026-07-21 — L5c round 1: the step-up, the line-height knob, and the no-offside cap

From the builder's defensive.md/defender.md (mapped in REFERENCES.md):

- **The STEP-UP**: the line only dropped — the missing half of
  step/drop/hold. A high line now squeezes toward a distant ball;
  `instructions.lineHeight` (0 low block … 1 high line, default 0.5
  mid-block) is the FIRST TACTICS KNOB (L6 will set it per team/role).
- **The no-offside cap**: stepping past the deepest attacker without an
  offside law doesn't trap him — it abandons him (goal-side collapsed to
  26% the moment the step-up landed). The line never steps beyond the
  deepest attacker +1.2 m until L9 arms the trap.
- **Metric honesty**: line-vs-runs' goal-side ratio now counts LIVE play
  only — a scored striker standing next to the goal poisoned 160
  dead-ball ticks against the line's floor.

defender.md validates the L3 duel inventory and pre-specs L5e's engage
model (tackle-score); NEW gap recorded: AERIAL play (jump/heading) is
wholly absent — needed before L8 crosses. 59/59; dial and runs intact.

## 2026-07-21 — L5c OPENED: defensive shape — the line as a unit

Branch feat/engine2-l5c (chain l3→l4→l5a→l5b merged to main; PR #53).
The first DEFENDING brains in the engine. shapeSpot (decide.ts): shared
line depth (hold home; drop goal-side of the ball, 12 m buffer, floor
10 m from goal), ball-side slide (0.4×, cap ±7), cover-shadow bend
(carrier→deepest-threat lane at line depth), ordered spacing ≥5.5 m —
computed identically per member, so the unit coheres without messages
(the communication reference's losslessly-shared-state regime). The line
SLIDES, never chases: pressing is L5d's, jockeying L5e's. 'keep' brains
skip shape (a rondo has no goal to protect).

Scenarios: back-line-shift (a back three of brains vs keep-circulation —
level to ±0.6 m, slides with the ball, spacing held) and LINE-VS-RUNS —
the first true small-sided interplay: the APPROVED L5b attack against a
living line, nothing scripted on either side. The dart still breaches,
the thread still arrives, and the line retreats goal-side and contests
deep (goal-side ≥75% pinned; breaches are the attack succeeding).

Perf ~39 µs/tick with shape+decisions on (budget ~185). 59/59; all prior
rates intact (dial 16/16 both poles, runs 16/16/13, wall 16/16).
Known-and-deliberate: the line backpedals to its floor rather than ever
engaging (no pressing yet) — the drop-forever look is L5c-only honesty.

## 2026-07-21 — L5b scenarios APPROVED + reference index (roles / spatial / communication)

Builder approval: runs-in-behind and wall-pass both pass the eye (the
hover-burst-thread round). Floors stand as pinned (threads met moving
beyond the wall ≥12/16; run triggered/received/finished ≥15/12/10).

Three new references mapped in engine2/REFERENCES.md:
- **roles.md → the L6 pre-spec**: roles as parameter bundles over L5
  behaviors; the risk/objective instruction surface is the embryo; target
  man ≈ the wall-pass pivot, advanced forward ≈ runPlan's bias, regista ≈
  deep support + delay-release.
- **spatial.md → the perception-pass pre-spec** (spec §3's deliberate
  "imperfect later"): vision cones, scan cadence, reaction delay,
  confidence, memory. True-state analogues already live (posValue/
  keepValue, passCompletion, predictBall). Gate: after L5 stabilizes.
- **communication.md → gated WITH perception**: today runningLine/
  waitingRunners/intendedReceiver ARE the messages, delivered losslessly;
  explicit messaging + chemistry + miscommunication only mean something
  between imperfect perceivers. Build the two together.

## 2026-07-21 — L5b round 3: the breach — hover, burst, thread

The judged defects: runs dragged way wide of the defenders; no run UP TO
the breach; the one-two either ping-ponged or threaded way too deep. The
judged spec: give → the wall WAITS → the thread goes as the runner is
ABOUT TO BREACH the line. Five mechanisms:

- **Seams hug the line** (runPlan): shoulder seams at defender ±4 m (±8 m
  dragged runners to the touchline) with stronger locality weighting.
- **Hover-and-burst**: riding GLUED to the line left a straight dart
  nowhere to go (instant termination, zero pace — the judged stall).
  Runners now hover ~5 m off the line and attack it in bursts; the reload
  depth is what makes pace at the breach possible.
- **Darts aim THROUGH the line** (the knock-past lesson's third
  appearance): a dart target AT the line arrive-braked the runner to a
  walk at exactly the breach moment.
- **The breach gate**: the release tax lifts only when the runner is
  darting, at pace (≥3 m/s), AND within a stride of the line (≤4.5 m) —
  "about to breach," per the spec. The thread's destination is
  LINE-relative (line +4.5 m in the runner's lane), at a softer weight —
  the old runner-relative +7 m at firm pace was the judged too-deep ball.
- **The backheel EV discount is pressure-gated**: an unpressured carrier
  TURNS before striking (turn-then-strike already executes it), so
  discounting his EV for a blind ball he will never hit double-counted —
  it killed the wall's thread with an open lane and no time pressure
  (pC 0.98 raw → 0.65 → under the floor, by facing alone).

Rates: wall-pass 16/16 threads met moving BEYOND the wall (was 11 moving,
2 advanced); runs-in-behind 16/16 received (the striker hits ~7 m/s
through the CB gap, collected between d1 and d2); dial 16/16 both poles;
57/57.

## 2026-07-21 — Run taxonomies extended: midfield + defensive references

The builder added midfield support runs (20) and defensive runs (26) —
mapped in engine2/RUNS.md. Midfield: most support variants are LIVE via
L5a's supportSpot (the lane-openness × value candidate space covers
simple/forward/backward/lateral/escape); bounce-pass support is the L5b
one-two; pocket runs gate on L5c's lines, rotations/overloads/half-space
roles on L6. The DEFENSIVE list is effectively the pre-spec for
L5c/L5d/L5e — it maps one-to-one onto the spec's own sub-phase
acceptance lines (ball-side shift/weak-side compression = L5c's
compactness+shift; shadow press = cover shadows; jockey = the recorded
L5e head-on guardrail) and should seed those scenario libraries when the
sub-phases open.

## 2026-07-21 — L5b round 2: the run taxonomy + the emergent one-two

The builder supplied a 34-run taxonomy (reference/types_runs.md), now
mapped in engine2/RUNS.md by status: live / emergent / gated. The gating
principle worth recording: runs that MANIPULATE a defender (dummy, decoy,
blindside, shadow, double movement, spin, false-nine drop) are
semantically empty until defenders perceive and react — L5c/L5d/L5e own
them; building earlier would be animation, not football. Cross-family
runs (near/far post, box crash, peel-off, delayed box run) gate on L8.

The WALL PASS (#22) built this round as the emergent test case — nothing
scripted; five mechanisms earned:

- **The one-two burst**: a giver near the line darts IMMEDIATELY (the give
  is his trigger — lastGiveTick; no patient ride phase).
- **Flight counts as possession**: the run block engages while the ball
  flies to a teammate, or the wall's instant return beats the run into
  existence.
- **The release waits for PACE**: the wait tax lifts when the dart is
  MOVING (≥3 m/s), not when it merely starts — and never applies to the
  ball into the run's PATH (destOverride): the first-time return is played
  early precisely because the run is coming.
- **Straight darts**: when the runner's seam IS the gap, the dart goes
  through it (adjacent-seam-only darts ran to the corner and killed every
  return lane).
- **'keep' is a rondo device**: staging the wall man with the keep
  objective ZEROED the path ball via the station tether — pivots are
  score-objective bodies pinned by script.

State: give → dart-in-flight → wall waits → early return → met MOVING in
11/16. The RETURN DEPTH (led beyond the wall into the gap — 2/16) is the
open judgment knob, deliberately unpinned. Runs drill 16/15/14, dial
16/16 both poles, 57/57.

## 2026-07-21 — L5b round 1: the dart — the release meets the run

The judged shape: a real runner PICKS UP SPEED before the ball is played,
often diagonally behind one defender into the next gap — the static
line-ride with a post-release burst was backwards.

- **The run cycle** (sim.ts): approach → RIDE (reload at a jog on the
  seam) → DART (sprint diagonally across a defender's blind side into the
  ADJACENT seam, ~1.6 s) → back to ride if the ball doesn't come. The
  dart lane comes from runPlan (the neighboring seam — the judged
  "behind d1, receive between d1 and d2" geometry).
- **The release meets the run** (decide.ts): passes to riding/approaching
  runners are taxed ×0.45 — you don't play the through ball while the
  runner stands on the line; the dart lifts the tax and the ball goes
  while he is AT PACE (wb-1: dart t=12, release t=15). Phase-gated, not
  speed-gated — the approach run's pace masqueraded as a dart until the
  waitingRunners set carried the phase into decide().

16/16 triggered/received/finished; dial intact; 56/56.

## 2026-07-21 — L5b OPENED: runs — trigger, seam, line-ride, release, burst

Branch feat/engine2-l5b (stacked on l5a). The in-behind run, fully
emergent (the runs-in-behind drill scripts NOTHING for the striker):

- **runPlan** (decide.ts): a run is ON when the team has the ball, the
  runner is ahead of the carrier, within ~22 m of the last defender's
  line, and ≥12 m of room exists behind it. The channel is a SEAM —
  between line defenders or off the outside shoulder, never a marker's own
  lane (the first cut rode the marker's channel and every through ball
  died on the marker).
- **Line-riding** (sim.ts): the runner advances capped 0.4 m short of the
  line at a jog (the v1 line-riding insight, geometric — no offside law
  until L9); the receive reflex owns the burst when the ball is played.
  Run priority beats support; scripts beat both (scriptedUntil).
- **The rider's ball** (decide.ts): a rider jogs, so speed-gated through
  candidates never saw him — runners get an explicit candidate into the
  space behind the line. **The delayed release** (the forward note, now
  live): when the best pass's value is still RISING with the run
  (projected +0.5 s), the carrier holds a beat.
- **AUDIT-CLASS FIND — the unsampled lane tail**: passCompletion's sample
  grid stopped at f=0.90 — the final two meters of EVERY pass were never
  checked, so a tight mark standing ON the receiver was invisible to the
  model. Sampling now lands exactly on f=1.0. All 55 prior tests survived
  the correction (the pinned rates were honest), and rondo circulation
  IMPROVED again (94 → 121 transfers/8 seeds — better pass selection).

Rates: run triggered 16/16, striker received 16/16, move finished with a
shot 16/16; dial 16/16 both poles; 56/56.

## 2026-07-21 — Forward note: curl and the trivela (builder ask)

Spin/curve stays DEFERRED per spec §3 ("earns a layer only if scenario
evidence shows its absence matters"). The earning conditions are now
concrete: (a) bending a ball around a blocker — the lane model calls a
blocked lane dead; curl is the real answer; (b) crosses and corners (L8);
(c) keeper-beating placement (L7). The TRIVELA additionally hooks into the
facing model: an outside-boot ball is how a player passes 45–90° against
his facing WITHOUT turning — when curve lands, it slots in as a skill-gated
alternative to turn-then-strike (technique attribute, execution-noise
scaled). Until then: straight balls, noisy by passing skill.

## 2026-07-21 — L5a round 1: the side-foot range + the three-body squeeze

- **Side-foot passes** (judged): turn-before-strike now only fires for
  balls genuinely BEHIND the body (>100°, was >60°) — a 45–90° ball is
  standard play, struck without turning. Rondo circulation jumped 62 → 94
  transfers per 8 seeds. The angle-noise growth stays (a 90° side-foot is
  slightly noisier than a straight ball).
- **The defender's pause** (judged question): d1 standing ~1 s after the
  through ball passes him is his SCRIPTED reaction cue — normal until
  L5c/L5d give defenders real triggers (recorded boundary).
- **Three-body squeeze** (surfaced by the interpenetration test): a
  crowder pushing the middle man into a third body breached the floor —
  single-pass pairwise separation cannot resolve chains; the solver now
  iterates ×3.
55/55; dial 16/16 both poles.

## 2026-07-21 — L5a OPENED: support & structure — first cut for judgment

Branch feat/engine2-l5a (stacked on l4). The first L5 sub-phase: off-ball
brains whose team has the ball move to OFFER AN ANGLE — supportSpot() is
the carrier's lane model pointed the other way (lane-openness × value −
crowding, tethered to a home that deforms toward the ball). Engagement
rules earned by immediate breakage:

- **Idle bodies only, past their last scripted cue**: the first cut
  pre-moved the striker before his scripted run and broke the breakaway
  2/16 — a body with a FUTURE atTick command is waiting for his cue, not
  idle (scriptedUntil map). The script is the run until L5b.
- **Attacking support only**: brains without possession stay put —
  defensive shape and pressing are L5c/L5d.

Post: rondo passers reposition (28/32 across 8 seeds) and circulation
ROSE to 62 transfers/8 seeds; the counter mid trails the play as a real
outlet after releasing (the statue-passer gap from the audit, now
closed). 55/55; dial 16/16 both poles; striker/knock-past unchanged.
Judge in the workbench: rondo (passers sliding along their edges to open
lanes), counters (the trailing outlet).

## 2026-07-21 — L4 ACCEPTED + BAR 2 (TECHNICAL) CLAIMED

L4 (on-ball decisions) passes the builder's acceptance after 7 judgment
rounds + the systems audit. The final gate question — the counter striker
angling around the box edge instead of driving the center — verified as
CORRECT: d2's recovery station owns the central channel; the striker
rounds him and cuts in late (real striker line vs a covering defender).
The center-beating tools he lacks are recorded later-layer content
(feints; teammate runs to drag the cover).

**Bar 2 — Technical (spec §9) CLAIMED**: individual actions read as
football skills. Evidence: the L3 technique matrix (first touch by
pace/height/pressure/gait, tackles, shielding, knock-past) and the L4
choice layer (EV carry/pass/shoot with real lane geometry, the risk dial's
two poles, turn-then-strike, half-turn receives, in-stride through balls),
all under scenario assertions (53/53) and seven rounds of the builder's
eye. Bars 3+ await L5.

Next: L5a (support & structure) — first L5 sub-phase, one per PR.

## 2026-07-21 — L4 systems audit: gap sweep (builder ask — "what else is missing?")

An automated anomaly sweep (run-check speed dips under flighted balls, dead
balls nobody reacts to, stuck carriers, per scenario × seeds) plus a
code-path review of the interaction seams. Found-and-fixed now:

- **Lane-chaser stutter**: the race-mode set-at-the-line brake fired on
  MARGINAL meets too — chasers half-stopped at points the ball crossed
  0.3 s later anyway. Braking now requires being comfortably early
  (arrive ≥0.35 s before the ball); marginal meets run through flat out.
- **Stray balls died untouched**: only the intended receiver ever reacted
  to a pass — a deflected ball dying in no-man's land was ignored by
  players standing over it. The nearest idle brain now collects a loose,
  dying, unclaimed ball within 8 m (labeled 'collect'). Deliberately NOT
  pressing: opponent-carried balls stay unreacted (L5d's).
- **Tried and reverted**: in-stride receives under CONTEST — aiming at the
  current-pace meet concedes the earlier intercept to a sprinting chaser
  (striker rates fell 14→10/16). Race mode keeps flat-out pMeet; the
  contested run-through needs opponent-aware meet selection — recorded as
  a refinement, likely alongside L5b.

Recorded gaps by owning layer (not built, deliberate):
- **L4-extension**: lofted balls (kicks support loftDeg; decisions never
  chip — blocked lanes and keepers will demand it), true first-time flicks
  and dummies (current one-touch is claim → fire ≈0.1–0.2 s — close),
  contested in-stride (above).
- **L5a**: post-pass movement (passers are statues), support angles.
  **L5b**: run triggers, the delayed release (forward note exists).
  **L5c/L5d**: shape; pressing/reacting to opponent-carried balls (the
  rondo ends when a chaser wins it; scripted winners stand unpressured).
  **L5e**: jockeying/backpedal, shoulder contests (tow-lock note exists),
  the head-on guardrail. **L7** keeper; **L8** restarts (ball goes dead at
  the boundary); **L9** fouls.
- **Physics notes**: the ball can pass through a claim-LOCKED body's feet
  (a just-fumbled player's body doesn't block — minor); no aerial play
  (jump/header) anywhere yet; facing during in-stride receives never
  glances at the incoming ball (cosmetic at 2D scale).

Sweep findings that are CORRECT behavior (leave): chasers setting on lanes
they comfortably reach (intercept posture); a station receiver braking to
receive; scripted drill bodies standing at drill end. 53/53.

## 2026-07-21 — L4 judgment round 7: the touch goes in FRONT; idle bodies watch the play

Two judged defects and the knock-ons of fixing them:

- **The continuation touch** (sim.ts): the directional first touch controlled
  the ball to the boot but weighted it as a CUSHION (speed×1.07) — at
  running pace the ball died at the receiver's feet, read as "controlled
  behind him." A runner's (>3.5 m/s) first touch is now weighted like a
  carry touch (a proper stride ahead) and the contact always snaps just in
  FRONT of the boot (lateral contacts read as behind too). Post: the
  counter-high runner's ball rides 0.4→1.5 m ahead through the claim.
- **Idle ball-watching** (sim.ts): a hold body with no facing target froze
  wherever it last pointed (the judged mannequin body shapes) — idle
  non-carriers now lazily track the ball (3 rad/s).
- **Racers set at the line** (sim.ts): an early racer to a LOOSE ball blew
  through the meet point with momentum (the ball rolled past behind his
  overshoot — loose-ball-race caught it). Race mode now brakes into the
  meet when early. Gated to loose balls only: braking chasers of a CARRIED
  ball accidentally invented proto-jockeying (set-defender pinch, front
  duel collapsed 0/16 — the L5e boundary defended by a test).
- **Separation capacity** (technique.ts, 2.5 → 3.5 m/s): a beaten man
  lunging back at 2.6 m/s squeezed a one-tick 0.45 m overlap past the old
  clamp. 53/53; dial 16/16 both poles; rondo texture unchanged.

## 2026-07-21 — L4 judgment round 6: clean pace is automatic; pressure is a skill

The judged rondo mistouches measured at ~1-in-9 receives — and the probe
showed every one was a CLEAN-pace pop (nearest chaser 4–8 m away), not a
pressured touch. Two model corrections:

- **Pace onset to genuinely driven** (touchEasySpeedMps 6.5 → 8.0): a
  10.5 m/s ground ball to good feet is near-automatic (fumbles now ~5%,
  none below 9 m/s; one-touch releases 37/41 within 0.3 s).
- **Pressure vulnerability skill-scaled** (touchPopPressure 0.52 ×
  (1 − 0.65·ft/20)): a closing body barely troubles silk feet and ruins
  heavy ones — one flat pressure constant could not serve both the pinned
  heavy-spill floor and elite composure. Heavy-pressed spill holds ≥0.33;
  silk pressured lands ~15% (a real body still disrupts).

Keyed-draw note again: two rounds of small nudges flipped zero seeds —
the fixed per-(tick,id) uniforms quantize rate tuning. 53/53; dial intact.

## 2026-07-21 — L4 judgment round 5: the run is not checked

The judged defect (sharpest on the counter-high long ball): receivers
slowed to ANTICIPATE at the meet point — the receive machine's timed
approach is right for a station receiver and wrong for a runner — so the
firm through ball rolled on behind the checked run.

- **In-stride receives** (sim.ts): a runner (>3.5 m/s) whose CONTINUED run
  at current pace comes within 1 m of a flighted pass's predicted path
  takes the ball at that meet, flat out — no timed cap, no brake-into-line.
  Self-selecting by geometry: if running through does not meet the ball
  (true crossing receives, early arrivals), the timed machine handles it as
  before. Flight-only (>4 m/s ball): a sitting or dying ball must still be
  braked into — the first cut hijacked static collects and resurrected the
  charge-and-overrun bug (three tests caught it immediately).
- Post: the counter-high runner holds 4.1→6.2 m/s through the whole flight
  and takes the ball moving at his feet. 53/53; dial 16/16 both poles;
  rondo unchanged (10.6 m/s, half-turn one-touch).

## 2026-07-21 — L4 judgment round 4: pace is routine, body shape is the skill

The judged rondo truth: pros don't struggle with a 10 m/s ball over 12 m —
the difficulty is ANGLING THE BODY for the first-time next ball.

- **Pop difficulty onset moved to driven pace** (technique.ts,
  touchEasySpeedMps 4 → 6.5): control difficulty now starts where real
  difficulty starts; bounces, gait, and pressure still bite from zero.
  Pressure raised to compensate (0.22 → 0.34 — the equalizer; the pinned
  heavy-pressed spill floor holds). Note: keyed pop draws are fixed per
  seed, so small probability nudges can flip ZERO seeds — tune in steps
  big enough to cross draws.
- **The half-turn receive** (sim.ts): the intended receiver scans DURING
  the flight (decide() ignores ball state, so he evaluates as if the ball
  were already at his feet, at the reconsider cadence) and opens his body
  halfway between the incoming ball and his anticipated next play. Aligned
  first-time balls now fire without the turn delay (wb-1: claim t=12 →
  release t=13); a next ball against the body shape still pays the
  turn-then-strike cost. This is the coached "receive on the half-turn,"
  and it is the mechanism the judgment asked for: distance-trap difficulty
  out, body-shape difficulty in. 53/53; dial intact 16/16 both poles.

## 2026-07-21 — L4 judgment round 3: zip the passes, trust the feet

The judged sluggishness ("passes not fast enough, or the touches are
lacking") measured true: rondo passes averaged 9.0 m/s at launch — the
hot-arrival tax was receiver-blind, so the EV floated every ball soft.

- **Receiver-aware weight** (decide.ts): the comfortable arrival pace rides
  the RECEIVER'S firstTouch (≈ 5.5 + 0.35·ft m/s) — silk feet get the ball
  zipped (rondo now ~10.5 m/s and quicker circulation), heavy feet get it
  soft. The attribute now shapes how teammates PLAY TO you, not only how
  you control.
- **Deeper skill relief** (technique.ts): touchSkillRelief 0.75 → 0.85 —
  silk feet fumbled ~16% of firm balls (judged "touches lacking"); elite
  touches now kill pace reliably (~11% at 10.5 closing for ft 15) while
  heavy feet barely change (the pinned heavy-pressed spill floor holds).
- **Cautious floor re-seated** (passFloorBase 0.72 → 0.78): untaxing firm
  balls to good receivers pushed the through ball's pC over the LOW-risk
  floor and flipped the dial — a safety-first player does not hit a
  2-in-3 ball. Dial re-verified 16/16 both poles. 53/53.

## 2026-07-21 — Forward note: delayed releases and defender-baiting (builder ask)

Asked during L4 judgment: can tactics later DELAY a pass to time a run, or
attract defenders to open space in behind? Yes — recorded so those layers
inherit the intent:

- **Delayed release (L4-extension, gated on L5b)**: a `delay` intent — the
  carrier holds a beat when the through ball's EV is RISING (runner
  clearing the line). Same machinery as the lane model, projected onto the
  teammate; needs L5b's real run triggers to have something to wait for.
  Offside-timed delays additionally need the L5c/L9 continuous line.
- **Baiting (gated on L5c/L5d)**: carrying at a defender to trigger his
  commit, then releasing into the vacated space — needs REACTIVE defenders
  (shape + press triggers) and then a shallow one-ply opponent-response
  term in the carry/pass EV. The lane model already exploits committed
  defenders (projection opens the space behind them); baiting is choosing
  to CAUSE the commit.
- **Surface at L6**: "patient buildup" / "draw the press" / "tempo" become
  instruction parameters shaping these EV terms — the risk dial is the
  prototype of that surface.

## 2026-07-21 — L4 judgment round 2: turn-then-strike, wider caution, line-breakers

Three judged asks, three mechanisms:

- **Turn, then play** (sim.ts): a decided kick more than 60° off facing no
  longer fires as a degraded backheel — the body TURNS first (hold-with-
  facing, L1's rotation rate) and strikes clean when aligned. The turn's
  delay is its honest cost: defenders keep closing, and the re-decide can
  abort the pass the turn made stale. The backheel execution penalty stays
  for whatever still fires misaligned.
- **The cautious release** (decide.ts): the carry-pressure horizon is now
  risk-scaled (7 m + 6·(1−risk)) — a safety-first carrier's danger radius
  is wider, so he releases to the open man BEFORE engaging the 1v1 (wb-1:
  safe ball at t=27, up from t=45; the judged ask). Same round also made
  commitment inertia RELATIVE (8% of current utility, floor 0.004) — an
  absolute switch cost was mis-sized at every utility scale and had blocked
  three separate judged behaviors by a hair each.
- **Line-breaking through balls** (decide.ts): a pass to a RUNNER (>2.5
  m/s) evaluates a third candidate — the firm ball aimed 0.7 s BEYOND the
  meet point, into the space he is running into — so the deep man takes it
  in stride instead of checking back to his own feet (wb-1 high: received
  at speed mid-run, carried 25 m). Soft-to-feet and firm-to-feet remain the
  other two weights; EV picks.
- **The xG-gradient carry** (decide.ts, surfaced by the striker rates):
  within ~34 m of goal, carry directions add 0.8·xG(sample) — pure
  positional value let a chased striker drift to the corner flag where the
  angle dies (3/16 no-shot seeds, now 2/16, both honest chaser wins).

53/53. Perf unchanged (~14 µs/tick).

## 2026-07-21 — L4 judgment round 1: the backheel, the corner-dodge, and the dial's true poles

Four judged defects, four mechanisms:

- **The backheel** (technique.ts): kicks off facing degrade — noise
  ×(1+1.6·(misalign/π)²), power fades beyond 90° (×0.55 at a blind 180°);
  the pass EV discounts completion to match. DECIDED kicks only — scripted
  kicks stay facing-blind (the script is the player's intent, body shape
  included; the first cut penalized drill feeders parked facing "wrong" and
  killed three L1–L3 scenarios).
- **The corner-dodge** (decide.ts): carrying near defenders now carries a
  risk-scaled TURNOVER term — dodging was free, so the mid dribbled to the
  corner flag instead of ever releasing. With d1 parked ON the carry line
  (drill), the mid now faces a real man and a real choice.
- **The dial's true poles** (judged semantics): risk-low plays the SAFE
  OUTLET (16/16 first passes to the settled right man), risk-high hits the
  THROUGH BALL (16/16 to the deep runner). What it took: the through lane
  must be clear at the release moment (d1 off the lane), the outlet must be
  SETTLED (a second runner's lead point out-valued the through ball), a
  deeper floor for speculative feet, inertia rescaled (a 0.0007 gap blocked
  the safe release forever), and Δpv payoff weighting (a 55% through ball
  honestly loses to a 95% square ball on raw EV — preferring it anyway IS
  the instruction).
- **Pass weight is a tradeoff, not a formula** (decide.ts): each pass now
  evaluates TWO weights — soft (dies at the receiver's stride) vs firm
  (beats interceptors, arrives hot, taxed for it) — and keeps the better.
  The old linear weight hit every ball to arrive at pace and roll 60 m when
  a receive missed (the judged corner-flag sail).

Supporting fixes surfaced by the probes: lane threat = min(current,
projected) defender position (projection alone rated a mid-turn chaser off
the lane he then cut — the rondo's death); the receive final stride aims at
the CROSSING point nudged up-line (a noisy pass's lateral gap went unclosed
— a judged 3 cm miss); receiver-beaten tail threats soften rather than
vanish (a marker standing on the receiver still taxes the ball). 53/53;
dial asserted by first-pass TARGET now.

## 2026-07-20 — L4 OPENED: on-ball decisions (continuous EV) — first cut for judgment

Branch feat/engine2-l4 (stacked on l3). The carrier evaluates carry / pass /
shoot / shield / clear by EV against the actual world (decide.ts, pure +
deterministic; execution noise stays in L3's noisyKick — the §3 contract).
Value scale: 1.0 ≡ goal; PV ∈ [0,0.35]; non-shot actions ×0.55 possession
discount — striker-shoots-by-construction falls out of the scale, no role
flag (breakaway: 15/16 shoot, the 16th is the chaser honestly winning).
Brains are per-body opt-in (`brain: 'onBall'`); scripted bodies untouched.
Instructions: risk (turnover penalty + completion floor + progressive-payoff
weight) and objective ('score' | 'keep').

Mechanisms that earned their place through probes:

- **Pass lanes, accel-honest + projected**: intercept threat = defender's
  real accel ramp then cruise, at his projected position when the ball
  passes. The flat d/vmax model doubled the threat and killed every lane.
- **Next-touch release**: a decided kick fires the moment the ball is at the
  boot (coupleCarry), not after a gather-trap — the 1.1s trap latency closed
  every lane the decision had correctly picked.
- **Carry commands run THROUGH the valued point** (16m command for a 6m
  valuation) — a command AT the lookahead kept the carrier in permanent
  arrive-braking (the knock-past lesson, third appearance).
- **In-stride claims hook the ball to the boot**: a racing claim can resolve
  with the ball behind the runner; any push from there trails him forever.
- **Race final stride**: a contested chaser with the ball on top of him
  steps AT it — the 0.3s reaction margin made imminent meets "unreachable"
  (pMeet jumped deep and he carved off the line as the ball arrived).
- **Static balls are braked into** (receive machine off-line branch): tNear
  is meaningless for a waiting ball; charging it at 5.8 m/s overran by 2.7m.
- **Pass friction (0.85)**: a pass is not a lossless value teleport, or the
  square ball forever edges out carrying forward.
- **keepValue with a station tether**: without the anchor the optimal rondo
  is to flee the square (judged corner sprint); without 'keep' at all, the
  rondo players rationally attack the goal.
- **Point-blank xG crush**: a boot on the shot line within 2m blocks the
  shot outright — else the EV shoots into the man on its toes forever.
- **Dead ball at the boundary**: shots rolled to x=226 (restarts are L8's;
  until then the ball dies where it crosses).

The risk dial expresses as TEMPO, not target choice: low = keep it on the
boot (0/16 early release), high = hit the early forward ball (16/16). The
deep in-behind ball needs RUN ANTICIPATION (knowing the lane opens as the
run develops) — that is L5b's run-trigger context, recorded as the layer
boundary, not forced with more knobs. Scenarios: rondo-4v2 (keep objective,
one-touch circulation, ~7 passes before the chasers win it), counter-3v2 +
risk-low/-high pair, striker-breakaway. Action labels ride FrameBody.action
into the workbench label overlay (live source only — the stored stream stays
kinematic, matching tx/ty). 53/53 tests; ~14µs/tick with decisions on.

Accepted residuals for later passes: decision-quality attributes (vision /
decisions / composure / anticipation) don't yet modulate the EV (perception
is perfect per spec §3 v2.0); off-ball brains don't press after turnovers
(L5d); the sliding tackle remains the parked L3-extension.

## 2026-07-20 — L3 ACCEPTED (builder's judgment) + the L5e head-on guardrail

L3 (individual technique) passes acceptance after 12 judgment rounds; the
user merges feat/engine2-l3 (L2 already merged). Standing target recorded
for L5e marking/duels, agreed with the builder: the head-on duel's
close-control carry-through (today 16/16 — a set defender with only a
lunge, no jockey) must DROP to roughly 55–65% for a close-control carrier
vs an average set defender once jockeying/backpedal + the shoulder barge
land, with heavy feet well below that and tackling-class attributes moving
the split. duel-1v1-front-* are the guardrail drills; re-floor their test
rates at L5e (real take-on completion: elite ~55–65%, typical ~40–50%).

## 2026-07-20 — L3 judgment round 12: the head-on duel + pressure-shortened touches

The judged ask: duels only ever showed the defender arriving FROM BEHIND —
"can we see an attacker running unto a defender?" New drills
duel-1v1-front-close/-heavy: defender parked in the lane facing the
carrier, stepping in to meet him; second efforts scripted both ways so the
loser presses instead of jogging off.

First cut exposed a real technique hole: carriers took full cruise-weight
touches straight into the set defender's zone — instant pinch at a 4m gap,
16/16, no duel at all. Fix (engine, coupleCarry): PRESSURE SHORTENS THE
TOUCH — a defender ahead (inside 4.5m, ±60° of the touch heading) caps the
roll-out to (0.55 − 0.15·dribbling/20)·gap, floor 0.7m. Same family as the
pressured first touch: technique under pressure is L3's.

Post: the duel actually happens (closest gap ~0.85m, 16/16 engagements) and
touch quality decides it — close control carries through 16/16 (a set
defender who can only lunge gets beaten; jockeying/backpedal is L5e's),
heavy feet lose the head-on 8/16 to the pinch/tackle window. The lunge at a
full-speed dribbler stays ~20% per attempt (the speed punishment) — honest,
and the reason close control wins: real head-on stops come from jockeying,
which this layer deliberately does not have. Knock-past unchanged (14/16).
46/46.

## 2026-07-20 — L3 judgment round 11: contested chases race, losers keep hunting (the knock-past regression)

The judged report: "the attacker can no longer beat the man." Probing found
FOUR stacked causes, two engine, two drill:

- **Contested vs uncontested chases** (engine, sim.ts): the receive state
  machine (rounds 6–10) applied to EVERY chaseBall — including races. A
  chaser timing his meet and stepping politely into the ball loses any
  contested ball. Now: an opponent carrying the ball, or an opposing chaser,
  makes the chase a RACE — flat-out to the earliest meet point, no timed
  caps. Uncontested chases keep the judged receive machine untouched.
- **Losing chasers keep hunting** (engine, sim.ts): completeChases ended
  ALL chases on any claim — the attacker whose sweep was stabbed by the
  defender stood down for seven seconds (the judged give-up). Chases now
  complete only for the CLAIMANT'S TEAM; an opponent's claim converts your
  chase into the press. loose-ball-race's reset re-timed for this (far-fast
  stands down by script — that drill is about races, not duels).
- **The braking arc** (drill, knock-past.ts): the attacker's followPath
  ENDED at (54,33), so he braked to a stop mid-move — the "flying start"
  the scenario promised never existed. A tail waypoint keeps him at sprint
  until the chase takes over (pattern: never end a followPath where the
  next command needs momentum).
- **The tight knock** (drill, knock-past.ts): the knock passed 0.75 m from
  the parked defender — inside his 0.9 m claim reach, swept deterministically
  in 14/16 seeds, at EVERY commit back to the round the user judged "fine"
  (the watched seed was the lucky one). Widened (y 28.5→26) and firmed
  (8→9 m/s), defender reaction humanized (0.6 s→1.0 s flat-footed).

Post: attacker takes the first claim 14/16, carries beyond the park 16/16;
the 2 defender stabs are the move's honest risk. The test now asserts the
FIRST claim after the knock (≥11/16) — the old floor (recollect-anywhere
≥7/16) passed on tackle-backs while the watched race was lost every time.
Audit note for L5e: prolonged shoulder contact acts as a TOW (the inelastic
closing-cancel equalizes pair speed — a pace-15 man cannot pull past a
pace-11 man he's touching); the barge layer owns real shoulder contests.
45/45.

## 2026-09-13 — L3 judgment round 10: the fast feed is a timing problem, not a read problem

The 17 m/s crossing drill never made the line — a scenario-timing error,
not a behavior one: the receiver departed too late to ever beat a driven
ball across, and no read fixes an impossible run. Departure re-timed like
a real runner's cue (leave BEFORE the feed); 16/16 takes, met mid-stride
on the line. The reliability floor returns to 13/16 — a driven ball's
difficulty lives in the first-touch roll, not the read. 45/45.

## 2026-09-13 — L3 judgment round 9: the receive state machine, settled

- **The rapid right-left-right**: the two-phase boundary FLAPPED — hovering
  at exactly 1.2 m off the line alternated the target between line-point
  and meet-point every tick. The receive phase is now STICKY (enter ≤1.2 m,
  exit >1.8 m) — same hysteresis lesson as the contain press, now applied
  twice; recorded as a standing pattern: any behavioral phase boundary
  needs hysteresis or it thrashes at the boundary.
- **The final stride**: with the ball ≤1.2 s out, the receiver STEPS AT THE
  BALL (~2.4 m/s) instead of standing a meter off waiting — touches are
  taken moving into the ball. While set earlier than that, he now WATCHES
  the ball in (facing tracks it — the head no longer wobbles with target
  changes).
- **Faster passes join the matrix** (the judgment ask): first-touch-run-
  across-fast (17 m/s driven crossing feed) with an honest lower
  reliability floor (10/16 vs 13/16) — a driven crossing ball is
  legitimately missable even with a good read. 45/45.

## 2026-09-13 — L3 judgment round 8: phase-1 receives brake into the line

The angled receive overran on momentum: phase 1 (attack the line) was
uncapped, and a 45° approach carried the receiver past the meeting point
— he took the ball behind himself. Phase 1 now BRAKES into the line when
in receiving posture (the ball needs >0.5 s to reach his line-point);
stern chases of a ball already past stay uncapped. Probe: the angled
receiver decelerates 6.5 → 1.5 m/s into the line, sets facing the ball,
takes it in front of himself. 45/45.

## 2026-09-12 — L3 judgment round 7: the TWO-PHASE receive (attack the line, then time the take)

Third and final iteration on receive movement, human-driven each round:
blow-through → wait-downfield → parallel-converge (still read as running
away) → THIS. The earliest-meet target is mathematically right but
produces a converging parallel drift; a real receiver's path has two
phases, now implemented: OFF the ball's line → run at the nearest point
of the path (visually attacking the ball); ON the line (≤1.2 m) → the
earliest meeting point at arrive-with-the-ball speed, standing when set.
Probe: the across receiver runs straight at the incoming ball's line,
brakes as it arrives, and takes the touch AT the crossing. 45/45.

## 2026-09-12 — L3 judgment round 6: TIME-MATCHED receiving replaces margin-seek

Human note on the margin-seek fix: a player does not run AWAY from a close
ball to wait downfield — he moves toward it. Correct. The margin-seek
relocated the receiver to a comfortably-early point that could sit 15 m
down the line.

- **Time-matched approach**: chaseBall attacks the NEAR meeting point at
  the speed that arrives WITH the ball (cap = distance/meeting-time, floor
  0.6 m/s, braking into the point, standing only when already there with
  the ball >0.5 s out). Toward the ball always; through the line never;
  relocating away never. Chasers racing a ball they can barely reach are
  uncapped (need ≥ vcap) — races unchanged. Probe: the across receiver now
  converges alongside the rolling ball at ~5 m/s and takes it in stride at
  the natural meeting point. 45/45 on first run — the earlier margin
  machinery deleted, not patched.

## 2026-09-12 — L3 judgment round 5: margin intercepts + the tackle/foul taxonomy decided

- **The across overshoot, root-caused at last**: the intercept solver picks
  the earliest MARGINALLY-reachable point — tStar ≈ the chaser's own
  arrival by construction, so the "early" brake never fired and a matched
  crosser carried his momentum through the line (then stern-chased the
  ball he missed, target flipping 15 m downfield). chaseBall now MARGIN-
  SEEKS: prefer the first path point reachable ≥0.55 s early — set up on
  the line, brake, stand, take. Fetching your own touch never margins (a
  dribbler doesn't stop ahead of his ball and wait). Fast feeds now get
  taken further along the line — the honest adjustment, not a miss.
- **Poke reach 1.45 m**: the contain press point is carrier-relative
  (1.05 m) while the ball can rest a step beyond the carrier — 1.3 m
  lunges stood 7 cm short forever. A lunge is a full leg extension.
- **TACKLE/FOUL TAXONOMY (design locked, layer-homed)**:
  (1) standing/poke tackle — BUILT (cooldown lunges at a glued ball,
      tackling+strength vs dribbling+balance, carrier-speed-scaled);
  (2) interception — BUILT (swept claims, pinch races, the passive reach);
  (3) SLIDING tackle — L3-extension PR: high commitment (reach ~2.2 m,
      stronger clean-contact win), slider DOWN ~1.2 s win or lose,
      mistimed/through-the-man slides emit FOUL-CANDIDATE events;
  (4) shoulder-to-shoulder barge (legal body contest nudging the carrier
      off his line) — L5e duels, on top of the existing collision physics;
  (5) holding/shirt-pulls/drag-backs — deliberate FOULS; the action only
      lands WITH L9 adjudication (without a cost model, always-hold
      dominates). Foul-candidate EMISSION can start at L3 (contact
      geometry on failed tackles); adjudication (advantage, cards) is L9
      per spec — fouls emerge from contests, never rolled abstractly.

## 2026-09-12 — L3 judgment round 4: early interceptors plant; the knock-past exists

- **The across/angled overshoot**: chaseBall targets never braked — an
  EARLY interceptor blew through the meeting line at full run and the ball
  passed behind him. interceptPoint now returns its meeting time; a chaser
  arriving >0.4 s early brakes into the point (stepBody brakeAtTarget) and
  STANDS to receive (≤0.5 m). Late chasers still sprint. The crossing
  receiver now reads the path, plants, and takes it.
- **knock-past** (the judgment ask: "take a touch around a defender into
  space and run onto it"): new scenario — carry at run, release a low
  knock mid-stride past the set defender's shoulder, cut the arc behind
  him, run onto your own touch while he turns and races the re-collect.
  Findings en route: the knock needs ~2 m of passing clearance (kick noise
  drifts it into a parked defender's passive reach); a standing knock
  gives up two seconds (the move needs the flying start); and vs a SET,
  reacting defender the move is honestly ~even — beating a turned or
  committed one, and picking that moment, is L4 decision intelligence.
  Asserted: winnable (≥7/16 outright) and always a contest (≥14/16
  resolve to either player, never the void).
- **Scenario-scripting trap recorded**: afterPrevious commands live in ONE
  queue consumed at EVERY arrival — mixing them with atTick re-targets
  eats queued commands at earlier arrivals (a probe showed the attacker
  frozen at his arc's end, command-less). Multi-stage single-body scripts
  should be pure atTick. 45/45.

## 2026-09-11 — L3 judgment round 3: the DIRECTIONAL first touch

Human note: a charging receiver who survived the pop roll still killed the
ball DEAD at the meeting point — then overran his own trap and had to
circle back (the judged 360). No such thing as taking it in stride.

- **The directional first touch**: a MOVING receiver's successful control
  now redirects the ball into his route (next command's target — chase
  completions resolve first so the touch aims at where he is actually
  going) at ~his own speed, weighted by firstTouch (poor feet push it
  heavier), capped by dribble-to-arrive. A standing receiver still kills
  it dead. The dead-stop trap survives only where it is true.
- Asserted: across 16 seeds of the head-on charge, successful takes stay
  in stride ≥70% (carrier 1s later, ball progressing along the route, the
  receiver's speed never collapsing to a stand-and-turn). 44/44.

## 2026-09-11 — L3 judgment round 2: frame-relative sweep, gait difficulty, receive geometries

- **"Doesn't reliably pick up the ball" was a second tunneling class**: the
  swept claim tested the ball's path against the receiver's END position —
  but a charging receiver moves ~0.6 m/tick himself, so RELATIVE motion hits
  1.6 m/tick and skips the 0.9 m reach window. Claims now sweep in the
  receiver's frame (his displacement subtracted). Regression: the full
  receive-geometry matrix must make contact ≥13/16 seeds per drill.
- **Receiver gait matters**: pop difficulty += 0.025 per m/s of the
  receiver's OWN speed (walk +0.04 → sprint +0.20), on top of closing
  speed. Ordering asserted (walk < run < sprint at fixed closing speed).
- **Receive geometries**: new first-touch-run-across (90°) and -angled
  (~45°) scenarios; the crossing runner ADJUSTS to the pass at the end
  (kick noise moves the meeting point meters — nobody receives on rails;
  the L3 script approximates what L4 perception will own). The onto-drill
  keeps a genuine straight-line charge by shortening the feed (lateral
  noise stays inside the charge line). Model choice recorded: reception
  ANGLE expresses through relative-velocity magnitude + gait term — no
  separate angle parameter until the eye demands one.
- **Receive reach answered and pinned**: 0.9 m, below knee height (0.5 m),
  frame-relative swept — in ATTRIBUTES.md. 43/43.

## 2026-09-10 — L3 judgment round 1: the 360°, the seed problem, bracing, moving receives

Human verdict on L3: first-touch matrix reads right (silk dead / heavy
popped), tackle duels work; four notes, all landed:

- **The 360° orbit → CONTAIN**: a chaseBall presser at a glued ball now
  holds a press point (carrier-relative, outside the collision disc,
  BEARING ANCHORED on entry, hysteresis on exit, STANDS at the point via a
  new kinematics stand-mode that stops without completing the command).
  The failure was three stacked loops, each probe-caught: drive-into-body
  converts to tangential slide (orbit); single-threshold engagement flaps
  (charge → bounce → re-anchor → thrash); and a presser who cannot stand
  loops through his point, bumping the carrier off his own ball — which
  was silently stealing every hold. Asserted: total bearing sweep < 1.5π.
- **The workbench gained a SEED control**: stochastic drills differ per
  roll by design (heavy-pressed kills ~60% of touches) — a fixed seed was
  presenting one outcome as THE outcome. Judging stochastic behavior means
  re-rolling; the instrument now does.
- **Shield BRACING**: a pressed standing carrier rotates back-on to the
  presser (~side-on through the turn) — the visible truth of the shield;
  physics unchanged at L3.
- **Moving receives + the CLOSING-SPEED model**: first-touch difficulty now
  rides |ball − receiver| velocity, not raw ball speed — cushioning a ball
  you run WITH is easy, charging ONTO a drive is hard. Two new scenarios
  (first-touch-run-with / -onto) assert the split (in-stride ≤ 0.15 pop,
  onto > with + 0.1). 42/42.

## 2026-09-10 — Engine V2 session 3: L3 individual technique (@fm/engine2)

First touch, kick execution noise, tackles, shielding — plus the two audit
items (solid bodies, reach-gated kicks). The keyed RNG's first real
consumers; stochastic mechanisms are asserted as RATES across seeds.

- **First touch**: the trap is now a quality roll — pop probability from
  ball speed/height/pressure, relieved by firstTouch (the spec's acceptance
  line as a formula). Popped balls squirt 2–4.5 m/s scattered; the fumbler
  is claim-locked 0.8 s (his touch WAS the miss). Rates asserted: silk kills
  driven balls; heavy feet under pressure spill ~38%.
- **Kick execution noise** (passing): direction/power sigmas with skill
  floors; kicks reach-gated at 1.1 m (the remote-control-strike audit fix).
  Scatter asserted across 30 seeds (elite σ≈0.9 m at 40 m, poor ≈4×).
- **Tackles**: physical contests for a GLUED ball only (running touches are
  the pinch's domain) — tackling+strength vs dribbling+balance, ÷(1+0.2·
  carrierSpeed) because lunging at a sprinter is far harder than at a
  standing shielder. Won tackles knock the ball loose AND claim-lock the
  loser — the probe found the dispossessed carrier instantly re-claiming
  the knock (the kicker-refractory bug class; the win was silently undone
  and the claim even froze the tackler's completed chase).
- **Solid bodies**: pairwise soft separation (0.7 m, ≤2.5 m/s resolution)
  with inelastic closing-velocity cancellation — head-on sprints no longer
  ghost through. Asserted across every scenario.
- **Carriers ride their dying touch**: the dribble-to-arrive profile slows
  the BALL ~3× earlier than the body's own braking would — a probe showed a
  sprinter overrunning his slowing touch straight into the trailing
  defender's lap. While carrying, body speed caps to the touch profile.
- **Far-foot dribbling**: near a marker, touches bias away from him instead
  of alternating (alternating feet fed every second touch to the shadow).
- **STOP-RULE finding — the 1v1 outcome-split is L5e's, not L3's**: with a
  chase-only defender (no jockey/contain — that intelligence IS L5e), the
  recovery duel's outcome-split by touch quality proved a knife edge under
  every honest physics refinement; forcing it via geometry scans was
  fitting. The L3-crisp claims stand instead: a close-control dribbler
  with a step on a chase-only recovery defender KEEPS the ball (11+/12,
  asserted); attribute-decided dispossession lives in the standing tackle
  duel (strip 20/20 at edge +13, hold 10/10 at edge −13). The duel-1v1
  scenarios stay as watchable drills; their outcome-split assertion waits
  for L5e.
- 39/39 assertions; profile 7.2 µs/tick, 0.39 s/match (~460× headroom).

## 2026-09-09 — L2 physics audit: known holes, ranked, with owning layers

Post-tunneling sweep of L1/L2 for more holes of the same families. Nothing
blocks L2 acceptance; each item is recorded with the layer that owns it so
none rots into a surprise.

- **Bodies interpenetrate** (no body-body collision at all — duellists ghost
  through each other). Most visible remaining hole. OWNER: L3 opening item
  (soft repulsion ~0.6 m; shielding/tackles build on it).
- **Kicks are not reach-gated**: a scripted kick fires with the ball
  mid-touch meters from the boot — a remote-control strike. Scenario
  footgun today, wrong once L4 kicks under pressure. OWNER: L3 kick
  execution.
- **Sub-tick bounce contact**: bounces resolve at tick boundaries — up to
  1.6 m of pre-scrub horizontal travel per bounce at 16 m/s. Invisible at
  5 Hz; flight tests absorb it. OWNER: comment now, exact-contact solve
  only if L7 keeper timing ever needs it.
- **predictBall ignores other bodies** — chasers anticipate free physics,
  not rivals' traps. Fine at drill scale. OWNER: L5 (reading opponents).
- **No pitch boundaries** — ball and bodies can leave the world; scenarios
  self-police via the sanity assertion. OWNER: L8 (dead ball/restarts).
- **Perfect instantaneous trap + per-tick touch re-fire**: the L2
  simplifications that L3's first-touch model (quality vs ball speed/
  height/pressure; touch EPISODES) explicitly replaces.
- **Stamina costs nothing** — deferred by spec §5-L1 phasing.
- **Constant rolling friction**: hard passes roll far (16 m/s → ~75 m).
  Plausible-but-long; if L3 passing drills read as balls running forever,
  the lever is a speed-proportional drag term — the EYE rules, not a
  pre-tune.
- **Cross-JS-engine float determinism**: byte-identical within one engine;
  Math.cos/atan2 are not spec-exact across engines (Safari vs V8 may
  diverge by ulps over 54k ticks). Stored streams are the replay truth, so
  this only matters if live browser sims are ever compared against Node
  assertions — do not chase it as a "nondeterminism bug".

## 2026-09-09 — L2 judgment round 2: the tunneling ball + the body shield

Human note: pickups sometimes MISS — the ball passes through a player with
its direction unchanged. Diagnosis: discrete-sample claims. A 16 m/s ball
moves 1.6 m/tick, wider than the whole 0.9 m control disc — it crossed the
claimant BETWEEN ticks and never interacted.

- **Swept-path claims**: claiming now tests the ball's movement SEGMENT
  this tick (closest approach per body), so nothing tunnels; a claim is a
  controlling TRAP at the meeting point (ball stops at the man — perfect
  at L2, first-touch quality arrives with L3). Regression test drives a
  16 m/s ball through a standing body.
- **The body SHIELD** (the fix exposed it): with tunneling gone, every
  duel config pinched close control — defenders were reaching THROUGH the
  attacker, because L2 had no bodies. Minimal body-blocking: a pinch needs
  a clear stealer→ball line; if the carrier stands within 0.5 m of that
  line, the touch is shielded. A heavy touch running meters ahead escapes
  the shield's shadow — the L2 bridge to L3's full shielding contests.
- Duel re-scanned under the corrected physics: the locked geometry (flank
  recovery, pace 13) still separates — close control escapes the route,
  heavy feet pinched mid-route. 32/32; 5.2 µs/tick.

## 2026-09-09 — L2 judgment round 1: four notes, five mechanisms, three probe-caught bugs

Human notes on the first L2 build (anticipation, carry cost, speed-dominant
touches, direction-change + 1v1 scenarios) — all landed as mechanisms:

- **Intercept anticipation**: chaseBall runs to the earliest reachable point
  on the ball's PREDICTED path (clone-stepping the real physics, bounces
  included) — never the ball's tail. The debug overlay shows the live
  intercept. Corollary bug fixed: an intercept is completed by CLAIMING the
  ball — a chaser who "arrived" at his predicted point used to quit the
  chase and watch the ball roll past 1.2 m away.
- **Carrying is slower than running free**: regime caps × (0.84 +
  0.04·dribbling/20) while coupled (~12–16%). Recovery defenders of equal
  pace now catch dribblers — as they should.
- **Touch balance re-fit**: speed is the DOMINANT touch-length driver
  (speedGain 0.18 vs controlGain 0.22 acting on the carry-slowed speed;
  measured ordering close-jog < heavy-jog < close-sprint < heavy-sprint).
  Note: the carry speed penalty partly cancels the control gain at equal
  regime — the honest margin is thinner than intuition says.
- **Touches are AIMED AT THE ROUTE and alternate feet** (±0.12 rad): a
  probe caught fetch-steering + velocity-aligned touches forming a
  straight-line donkey-and-carrot that dribbled a carrier to x=185; aiming
  the touch at the intent (current waypoint) self-corrects lateral drift
  and threads gates. The BALL clears the carrier's gates (near-or-passed
  test, checked every tick) — otherwise the next touch aims backward at a
  gate the ball already flew past. Intermediate waypoints are passed
  loosely (1.2 m) — a slalom gate is rounded, not stood on.
- **The pinch**: a mid-touch ball (beyond control radius from its carrier)
  is stealable by anyone in claim reach who is NEARER THE BALL than the
  carrier — the touch is itself an arrival race. A glued ball cannot be
  claimed (that dispossession is L3's tackle). Duel geometry scanned
  empirically: a flank-recovering pace-13 defender separates the variants
  (close control escapes the full route; heavy feet pinched mid-route).
- **Scenarios +3** (dribble-weave slalom, duel-1v1-close/heavy): 31/31
  assertions, L1 + L2 regression green, determinism ×2 across all fifteen.
  Profile 5.6 µs/tick, 0.30 s/match (~600× headroom).

## 2026-09-08 — Engine V2 session 2: L2 ball physics + possession coupling (@fm/engine2)

One layer, one PR (feat/engine2-l2). The ball is ALWAYS a physical object;
"carried" is a coupling loop, not an attachment.

- **Free ball**: 3D state (x, y, height), phases carried/rolling/airborne/
  dead (dead reserved for L8). Rolling friction 1.7 m/s² (a 14 m/s drive
  rolls out ~58 m), gravity flight (no drag — deferred with spin), bounce
  restitution 0.55 with 0.75 ground friction per contact, bounce → roll
  handover below 1.2 m/s vertical. Asserted against projectile math (range
  = v²·sin2θ/g ± discretization) and monotone roll-out.
- **The dribble is touches + chasing**: in reach, a moving carrier pushes
  the ball ahead at carrier speed × (1.06 + 0.10·speed-share + 0.25·(1 −
  dribbling/20)); between touches the ball is just a rolling ball. Two
  mechanisms make it read as football: DRIBBLE-TO-ARRIVE (a touch is never
  weighted past the carrier's own destination — without it the pre-braking
  touch rolled 8–33 m past his stop and sprint carries always ended in
  giveaways) and the GATHER (a chaseBall carrier traps the ball dead
  instead of touching on — without it collection was a donkey-and-carrot
  that dribbled the probe carrier to x=185, clean off the pitch).
  Possession breaks by physics past a 4 m gap.
- **KICKER REFRACTORY (0.8 s)**: a kicker cannot claim his own strike —
  without it any kick under ~9 m/s was instantly re-claimed by its own
  kicker standing at the strike point and silently undone.
- **Loose balls are arrival races**: claims = nearest body within 0.9 m of
  a below-knee ball, deterministic tie-break; the chaseBall command races
  a live ball and completes when anyone claims. Asserted: the short feed
  goes to near-but-slow, the long feed to far-but-fast — outcomes from
  physics, nothing scripted.
- **Scenarios** (+7: dribble-close/heavy × jog/sprint, struck-ball,
  loose-ball-race, carry-turn): 27/27 assertions, L1 five still green,
  byte-identical determinism ×2 across all twelve. Workbench renders the
  ball with a height cue (lifted dot + ground shadow) and a carrier ring;
  the stored stream carries a delta-compressed ball track.
- **Profile**: 4.8 µs/tick, 0.26 s per full match (~700× headroom); stream
  2.45 MB gzipped. `dribbling` is the first L2 attribute consumer
  (ATTRIBUTES.md updated); firstTouch/receive quality is L3's.

## 2026-09-08 — Bar 1 CLAIMED (spec §9): L1 accepted in full after the turn refinement

- Human re-judged the workbench scenarios post-refinement: curved-run reads
  right (brake → plant → rip → relaunch), and all other scenarios pass the
  eye. With the earlier session's differentiation verdict this completes
  Bar 1 — motion reads as bodies with momentum; no teleports, no yoyo, no
  gliding. Evidence: the five-scenario library at 19/19 assertions plus the
  recorded judgments. L2 (ball physics + possession coupling) is next.
- **Positioning-split design locked (implemented at L5, not now)**: the pool
  already encodes attacking-vs-defensive positioning as `offTheBall`
  (pen-area touches + progressive receptions) vs `positioning`
  (interceptions/blocks/clearances). No pool rename; engine2's L5 layer maps
  them to `attackingPositioning`/`defensivePositioning` at its boundary —
  the `balance` pattern. Recorded in engine2/ATTRIBUTES.md (the standing
  attribute → behavior reference, maintained per layer).

## 2026-09-07 — L1 Bar-1 judgment: ACCEPTED with one refinement — turning is stats-only, and it found a latent orbit

Human verdict on the workbench scenarios: elite-vs-mid sprinter differentiation
good, movement accurate enough; one note — turning speed must derive from
agility/balance/acceleration, NOT pure sprint speed. Implemented as mechanism:

- **`balance` added to BodyAttributes** (engine2-native; the v1 pipeline does
  not derive it yet — mapping is a later session). Lateral grip = f(mean(
  agility, balance)); braking/relaunch stay acceleration's.
- **Cornering speed is now a stats-only quantity**: v_corner = grip·τ/θ
  (τ = turnTimeBudgetS 0.55). The old rule scaled the misalignment brake off
  the REGIME CAP — pace leaked into corners (measured: pace 19 carried 1.74
  m/s through a 180° vs 1.30 for pace 10). Plus **carve readiness**: above
  v_corner×1.25 steering is mostly withheld (ω × (v_corner·1.25/v)², floor
  0.12) — brake first, rip the turn at corner speed. Post-fix: pace 10 vs 19
  corner within 0.15 m/s; agility/balance 18 vs 6 differ by construction.
  Asserted (kinematics.test.ts "turning speed follows agility/balance, NOT
  pace"). Gentle carves (mild misalignment, no corner braking) keep radius =
  v²/grip growing with speed — that test moved to the 25° domain, where the
  physics still owns it.
- **Latent ORBIT limit cycle found and killed by the refinement work**: a
  body that just missed its arrival window would circle the target forever
  at the exact radius its grip-bounded turn rate sustains (probe: a stable
  0.7 m ring at 2.2 m/s around the shuttle marker). Two human mechanisms fix
  it: STEP-TURNS (below 2.6 m/s the running-gait grip bound yields to a
  plant-and-pivot rate, 5.0 rad/s) and a PROPORTIONAL FINAL APPROACH
  (desired ≤ residual + 1.2·d on must-stop targets — the spiral always
  tightens). Both asserted via the arrival/shuttle scenarios.
- 19/19 assertions; profile after refinement: 4.6 µs/tick, 0.25 s/full
  match (~730× headroom) — carve math costs a third more per tick, and it
  does not matter.

## 2026-09-07 — V2 visual reference: EA FC 26 2D footage in reference/eafc/ (local, untracked)

- Five phone captures of EA FC 26's 2D career-mode sim view live in
  `reference/eafc/IMG_7241–7245.MOV` (gitignored with all of `reference/` —
  ~500 MB of media stays out of the public repo; the folder is on the dev
  machine, not in history).
- **Per-layer protocol**: when building or judging a V2 layer, extract frames
  yourself (`ffmpeg -i <file> -vf fps=3 <scratch>/frame_%04d.jpg`) and view
  them as that layer's visual reference. This is REFERENCE for the builder's
  eye and the workbench legibility bar (spec §4) — NEVER a per-frame fitting
  target; §9 Bar 5 is aspirational and the gates remain the stats guardrail
  plus the human's judgment.
- What the footage pins for L0 legibility (checked against the shipped
  workbench, no changes needed): desaturated dark pitch, subtle striping,
  thin bright lines, plain high-contrast numbered dots (GK color-popped),
  small white ball, no on-pitch text. GK distinction and the ball cue become
  relevant at L2/L7.

## 2026-09-07 — Engine V2 session 1: L0 workbench + L1 kinematics (@fm/engine2, @fm/workbench)

First build session of ENGINE-V2-BEHAVIORAL-SPEC.md. Ground-up `@fm/engine2`
(zero deps, keyed RNG from birth, fixed 10 Hz tick) + the dev-only
`@fm/workbench` instrument. One PR because kinematics can only be judged by
watching them.

- **L1 model**: bodies with momentum. Speed builds on a force–velocity curve
  (available accel = peak × (1 − v/vmax)); braking = 1.3× accel; heading
  changes bounded by lateral grip (ω = grip/v ⇒ turning radius v²/grip grows
  with speed²); misaligned movers brake toward cornering speed (a 180°
  re-target is brake → tight carve → re-launch, never a pivot); decelerate-
  to-arrive targets a firm plant (residual 0.4 m/s), tolerance 0.35 m;
  standstill pivots allowed, grip-rate-limited. Attribute maps (0–20, same
  pool scale): pace → 5.0+0.26p m/s (elite 10.2), acceleration → 3.2+0.24a
  m/s² peak, agility → 3.5+0.28g m/s² grip. Regimes walk/jog/run/sprint =
  {abs 1.6, 0.5·vmax, 0.78·vmax, vmax} — the effort STRUCTURE lands now,
  the stamina bill later (spec §5-L1).
- **Scenario library v1** (versioned TS defs, workbench-loadable, asserted):
  shuttle-runs, curved-run, arrival, chase, regimes. 18/18 assertions incl.
  chase outcomes BY PHYSICS (70 m: pace-18 beats accel-18; 8 m: reversed),
  per-tick continuity everywhere, byte-identical determinism ×2 per scenario.
- **Frames**: full-rate 10 Hz internal; stored stream = 5 Hz delta-compressed
  JSON (cm positions, deciradian facings, stance NOT stored — derived
  presentation, was ~20% of bytes). §7 measurement (22 bodies, 54,000 ticks,
  worst-case command churn): **3.2 µs/tick → 0.17 s per full match, ~1030×
  inside the 3-min budget**; stream 9.1 MB raw / **2.5 MB gzipped** (the
  as-stored figure; raw JSON exceeds the "few MB" wording — binary packing
  is the known lever if L2+ pressure needs it, not built speculatively).
- **Workbench**: canvas pitch (EA-2D legibility bar), oriented bodies
  (facing notch), team colors, selected-body inspector; toggleable overlays
  (velocity vectors, movement targets, id+regime labels, tick/clock HUD);
  play/pause, scrub, 0.25×/0.5×/1×, single-tick step; scenario select
  resets deterministically; live-10 Hz vs stored-5 Hz source toggle (judges
  the replay format against the sim truth). `pnpm --filter @fm/workbench dev`.
- **Boundaries**: engine2 imports nothing from v1/server/web (depcruise
  `engine2-stays-pure` — concepts port, code does not); workbench reads
  engine2 only. v1 byte-identical to main this PR; all v1 suites re-run
  green (engine 31/31, server 18 files, web 63/63).
- **V1 EA-compactness iteration SUPERSEDED and stood down** (spec §2): the
  uncommitted block-frame + zone-discipline WIP is parked on
  `park/v1-phase2-motion-wip`, unmerged, with its finding recorded there:
  compressing v1's anchor geometry collapsed open play (goals 1.3–2.0,
  shots 7–9 across all screened geometries) because v1's proximity-fired
  duels multiply contact rates under compactness — behavioral compactness
  needs zone-disciplined engagement, which is exactly V2 L5 territory on
  continuous time, not a v1 keyframe retrofit.

## 2026-09-05 — ball-flight/arrival model: the goals floor is broken (engine arc phase 1)

The #42-named structure was rebuilt: the kicked ball is a first-class moving
object. Goals 6.2 → **2.93–2.99** (n=600 ×3; the 5.15 floor across 40 prior
candidates is gone), shots 12.5 ✓, xg/shot 0.104 ✓, completion 83.9 ✓,
aerials 31.3 ✓, reds/injuries/offsides/fouls ✓. Behind SIM_ENGINE=agent;
aggregate untouched (82/0 re-verified twice).

- **The mechanism**: passes travel at family speed (ground 14 / lofted 16
  chord, #33's straight flight kept) while the world ticks. Receivers MEET a
  ball to feet (reception at the body en route) and RUN ONTO a ball led into
  space. Ground interception is a spatial ATTEMPT where bodies meet the ball
  (anticipation-widened reach, full odds only dead-center, one try per
  defender per flight); lofted balls contest at the drop; a cross into the box
  is ALWAYS attacked by the nearest defender (the beat-the-ball gate is for
  open field). Execution owns only the strike (clean/shank); the old
  pre-resolved pSafe race is deleted. Out-of-bounds exists (unclamped pass
  endpoints, boundary clip, throw-in restart); BLOCKED RELEASES exist
  (pressure-rated, anticipation-read); completion for balls that die in space
  is judged at first control. carryStepM 8→4.5 landed IN-ROUND (the #42
  interaction). Provenance A/B: unpaid flight time 9.0s→0.0s per pre-shot
  chain, receiver warp 4.3m→0.3m per completion, attack speed at physics
  parity (was +33% free).
- **Two latent artifacts the teleport had hidden, fixed**: loose balls were
  unclaimable forever (attractor blending converges BETWEEN anchor and ball —
  the nearest man now chases loose balls/drops TO CONTACT); and frame
  sampling was decision-tick-aligned (every 6s sample caught the just-kicked
  carrier-null instant — frames now sample odd ticks).
- **The joint re-fit** (search, not hand-poking): 40+ candidates over the new
  physics surface (tiered: 24×n40 → 6×n100+sweep screens → 10 refinements →
  full n=150×3 on three profiles). The churn axis MEASURED: high churn (c14)
  passes 5/5 sweeps + bands but compresses quality into coin flips (real-pool
  top-8 win share 0.475, elite STs tied); low churn (c16) holds realism 7/7
  STRONG (r=0.853–0.864, STs 0.86–0.97 vs 0.60–0.71). Realism is not
  tradeable → shipped c16-based + cross-contest + rate trims
  (homePressureRelief 0.45→0.348 — the one home mechanism over-compounded
  once pressure gained teeth; header conversion 0.62→0.41; injury base
  2.4e-6; redPerFoul 0.0068). REFUTED en route: steeper duel slopes as a
  quality decompressor (elite box duels favor elite CBs — STs inverted
  0.51 vs 0.89); flat micro-blends (c14b re-rolled two sweeps for nothing).
- **Sweeps at gate scale**: press→ppda, press→fatigue, risk→passAcc (FIRST
  EVER pass — real flights make risky lead passes genuinely fail),
  risk→xg/shot, lineHeight→offsides all PASS; longPassing plumbing ×2 PASS.
  **crossBias→aerials +1.0–1.9 vs the +2 gate** — always directionally
  positive, level in band via the cross-contest mechanism, slider margin
  short. Documented open, not forced.
- **Tensions reported per the stop-rule (with evidence, not forced):**
  (1) **possession σ 12.4–12.9 vs 6–9 — immune to the entire searched space**
  (40+ candidates incl. extreme probes on every physics dim; range observed
  11.5–13.1). Quality now compounds through the physical race; the σ lever is
  outside these rates. (2) **draws-vs-ordering**: the flight physics nearly
  banded draw_share (0.183–0.23 vs the old 0.19–0.22 fail) and that
  arithmetically compresses top-8 win share to ≈0.55 — the realism gate's
  >0.55 now COIN-FLIPS per keyed re-roll (measured 0.475–0.625 across ~10
  re-rolls; final state: real-plain 7/7 ✓ authoritative, fixture-sharp 7/7 ✓,
  fixture-plain/real-sharp 6/7 on that one check). RESOLVED (user-accepted):
  the tripwire gate re-aligned 0.55 → 0.52 (realism-harness.ts, rationale in
  the gate comment). Worded for the future reader: the gate moved because
  draw_share IMPROVED into band and arithmetically compresses win share —
  ordering itself held or strengthened (r=0.86, goal ratio 1.7:0.9, ST/GK
  checks). It is not a lowered bar; at 0.52 the check still fails any engine
  whose top-8 stop beating the bottom-8. Same class as the 0.60 → 0.55
  re-alignment when PR #10's tempering accepted draws over dominance.
  (3) scoreline cluster residuals: goals 2.93–2.99 (0.03–0.09 over), away
  0.312–0.345, sp-share 0.348–0.359, ppda 13.3–13.65, 2nd-half 0.46–0.50
  (pre-existing structural: needs fresh-legs subs / late-desperation).
- **Stats now emitted per player** (the season-stats layer's feed): assists
  (goal-event assistId + tallies; set-piece deliveries count), key passes,
  GK saves ('save' events + HalfStats.playerStats — optional field, aggregate
  never sets it). SEASON-2-PARKING's assist item unblocks.
- **e2e carried-share check RE-SPECIFIED** (league-admin.test.ts): the old
  `> 0.5` carried-frame gate was written against the teleport era (~0.95
  carried); real flights + chased loose seconds honestly sit at 0.48–0.52,
  which straddled the gate per roll. The knockdown-to-teammate idea is NOT a
  gate-mover (arithmetic: ~31 duels × ~2s ≈ 1% of frames — it stays Phase-2
  motion-feel work, without the gate claim). The check is now a TWO-SIDED
  band (0.4, 0.9) — ~0 still catches the fabricated-replay regression it was
  built for, ~0.9+ now catches a silent flight-model regression — PLUS a new
  positive assertion the teleport engine could never pass: sampled frames
  must catch balls in lofted flight. Net: the guard got stronger, at the
  physics' honest level. Ball-at-feet-when-carried ≥95% unchanged.
- **AGENT_CAL_OVERRIDES** env hook (calibration-only, loud warning,
  unknown-knob throw) is the search's injection point; never set in
  production (go-live checklist rule).

## 2026-09-04 — accounts arc phase 1: email + password auth replaces magic links

Kicked off LOBBY-DESIGN-SPEC (self-service accounts → club identity → league
lobbies). Phase 1 only: kill magic-link login, add email + password accounts.

- **Why drop magic links:** Gmail's link pre-scanning redeemed the single-use
  token before the human clicked, so real logins hit `link_already_used`. A
  password has no single-use token to burn.
- **Hashing = Node's built-in `scrypt`, NOT argon2id/bcrypt** (the spec named
  those). scrypt is the same OWASP tier (memory-hard) and ships with Node, so
  the zero-runtime-dependency / no-native-build discipline that keeps
  `node:24-slim` buildable holds — argon2/bcrypt are native modules node-gyp
  can't build in that image without extra toolchain. Hash is a self-describing
  PHC string `scrypt$N$r$p$salt$hash` (`server/league-password.ts`) so cost
  params can be raised later without a migration. N=2^15, r=8, p=1.
- **`accounts` BRIDGES to `managers`, sessions stay manager-keyed.** New
  `accounts(email, password_hash, manager_id, reset_token…)`; `sessions` still
  reference `manager_id`, so ALL gameplay code (keyed on sessions→managers→
  clubs) is untouched. Phase 3 moves sessions/gameplay onto `account_id` and
  retires the seeded managers/clubs. Reset tokens stored as sha256(token), never
  raw.
- **Sign-up CLAIMS a seeded manager** with the same email that has no account
  yet, so the existing seeded test clubs stay reachable (verified: signing up
  `alice@demo.io` lands on Alpha FC's auction). A brand-new email creates a
  clubless manager → `/me` returns `club:null` and the web shows an account
  placeholder (club/league creation is Phases 2–4). setup-production.ts is left
  in place; it's removed in Phase 3.
- **`/me` is now session-scoped** (works before a club exists, nullable
  club/season); gameplay routes stay club-scoped (403 without a club). Reset
  link points at `/reset` (an SPA route), so the SW `/api/*` navigation denylist
  from PR #27 is unaffected. One Fly machine keeps the per-process login
  rate-limiter whole. Enforced: `server/league-api.ts`, `web/src/App.tsx`.

## 2026-09-03 — transition round: hypothesis REFUTED, the real structure named, stop-rule invoked

The scoped mechanism (transition-defense reformation) was NOT built — the
brief's own diagnose-first order killed it, and what the diagnosis found is
recorded with the engine reverted to the #41 state (the most balanced
calibration achieved: everything banded except the goal cluster).

- **Transition hypothesis refuted by provenance**: only 9–10% of open-play
  shots come within 6s of a turnover (median 16s). The excess is NOT fast
  breaks into unformed shapes. Reformation would have fixed a fiction.
- **What the provenance actually found — carry physics**: the median
  pre-shot possession contains ZERO passes. carryStepM 8 per 1s decision =
  dribblers at 8 m/s WITH the ball, above the 7.5 m/s sprint cap: carriers
  were unchaseable by construction, walking 40–100m into the box. Fixing it
  (4.5 m/s) shifted the regime but not the totals — event traces then showed
  tackle→tackle→tackle PINBALL: the buildup-supply rates (tuned under 8 m/s
  carriers) over-fire against chaseable ones, churning possession, and
  box-adjacent churn manufactures shooting episodes.
- **The floor, measured**: a fourth automated search round (churn-rate
  rebalance, 10 candidates; 40 total across the arc) bottoms at goals 5.15 /
  shots 16.9 / xg 0.146 — with possession σ regressing when rates rebalance.
  No reachable configuration satisfies goals ~2.75 within this structure.
- **The remaining structure (next suspect, untested)**: INSTANT PASS
  ARRIVAL — every completed pass TELEPORTS the receiver to the endpoint
  (`receiver.pos = endPoint`): no ball flight time, no defender race, 10–25m
  of free progression per completion. Chance creation rides it everywhere
  (and it interacts with carry speed: fixing one reshuffles into the other).
  The fix is a BALL-FLIGHT/ARRIVAL model — travel time, receiver runs,
  interception races. That is a real project (its own arc), not a knob or a
  contained mechanism, and per the stop-rule it is reported, not smuggled in.
- **Launch recommendation**: the engine arc cannot complete on this
  trajectory without the ball-flight project. The AGGREGATE engine remains
  the calibrated (82/0), launch-ready generator. Launch on aggregate now;
  continue the agent arc post-launch behind SIM_ENGINE=agent. Everything
  the arc built is real and keeps its value: EV decisions, 5 responsive
  sweeps, banded ppda/fouls/σ/offsides, real replay motion.

## 2026-09-02 — buildup supply + the trap: ALL FOUR dead sweeps now respond

The final scoped round of the calibration arc (post-#40). Both mechanisms
delivered; the goals/xg/shots cluster is the one open item, now with a
named suspect.

- **RECEPTION PRESSURE (the buildup-zone action supply)**: rational
  quick-release play made deep builders challenge-immune (grace ticks =
  decision cadence — release-on-first-decision is unstrippable), which is
  why ppda/fouls were knob-insensitive across 20 candidates. The missing
  physics is the PRESSED FIRST TOUCH: a presser within 4m of a teammate
  completion forces an error draw — defender tackling/aggression vs
  receiver firstTouch/composure, rate ×(0.5+intensity)(0.5+trigger), won
  duels sometimes fouls (card ladder + penalty/free-kick chains). Result:
  **ppda 12.7–13.1 IN BAND, fouls 12.4–12.8 IN BAND**, and
  **press↑→ppda↓ passes decisively** (10.7 vs 14.0−2 at n=150).
- **THE TRAP (offside sweep)**: box-centric EV play pushed the ride zone
  toward halfway where offsides are illegal, inverting the sweep. Modeled
  the trap itself: mistime probability ×(0.6 + 0.8·defending lineHeight) —
  a high line IS a harder timing problem. **lineHeight↑→offsides↑ passes**
  (2.58 vs 1.46+0.5); default offsides ~2.0/team ✓.
- **Sweep scoreboard at n=150**: press→ppda PASS, press→fatigue PASS,
  risk→xg/shot PASS, lineHeight→offsides PASS, crossBias→aerials PASS.
  risk→passAcc is directionally right but noise-bound at the −1.0 gate
  (deltas 0.3–0.9 across runs); the risk slider demonstrably expresses
  through the xg channel. Risk bias is now LEAD-SCALED for ground passes
  (a square ball is not a risk decision; a hard through ball is).
- **OPEN (the last cluster, next round's brief)**: goals ~6.2, shots ~18,
  xg/shot ~0.165 — proven insensitive to the ENTIRE defensive knob space
  (three search rounds, 30 candidates; more pressure raises shots via
  turnover transitions). Prime suspect: TRANSITION DEFENSE — turnovers
  launch attacks into press-committed, un-reformed shapes; the chance
  quality of those transitions is what no completion logit touches.
  Diagnose with possession-length-before-shot provenance first.
- Guards: realism 7/7 ×4, aggregate 82/0 (n=600), unit 31/31, agent e2e
  5/5, offsides ~2, possession σ ~9–10 (marginal band edge), keyed
  determinism throughout.

## 2026-09-01 — the EV rebuild: principled decision layer (phases A+B done, C partial)

The decision layer was rebuilt on first principles per the step-2′ decision —
one currency (expected goals this possession chain), no noise-fitted
cardinals. Phase report:

- **Phase A (done)**: `possessionValue(p)` — xT-style surface in honest xG
  units, PLATEAUING at the penalty spot (rational carriers exploited a
  monotone surface by dribbling to x=105); `shotQuality` = shared xgProxy ×
  the goal's SUBTENDED ANGLE (agent-only — xgProxy itself frozen for the
  aggregate); shot EV = its quality (+ documented shooter-optimism 0.017 for
  the speculative mix); pass/carry EV = P·PV(target) − κ(1−P)·PV_opp(target)
  with a COUNTER PREMIUM on turnover value (static PV made final-third
  giveaways free); hold/clear context-priced on the same scale. Instruction
  biases centered (0.5 = strict no-op) in EV units; temperature rescaled to
  the EV gap scale (base 0.04) = mostly-best-with-variance. Completion
  models and execution noise untouched — the attribute invariant holds by
  construction.
- **Phase B (done)**: pressing CHALLENGES — a defender within 2.9m may
  engage the carrier (attribute duel: tackling+anticipation vs
  dribbling+composure), frequency riding pressingIntensity × pressTrigger,
  failed challenges feed the foul/card ladder. Plus the physics rational
  play demanded: KEEPER CLAIMS (the goalmouth was dribble-through-able),
  receive-grace (strip-cycle prevention), GK unchallengeable.
- **Phase C (two search rounds — partial)**: automated random search
  (scratch cal-search.py) over the residual knob set. Banded for the first
  time ever: possession σ 9.2 (target 6–9 — was 13–15 under every previous
  regime). PROVEN structurally out of the searched space: ppda (17–19 vs
  10–13) and fouls (7–9 vs 10–13) — rational high-completion play collapsed
  the old failed-carry dispossession supply, and challenges don't land in
  the ppda-counted BUILDUP zone; next mechanism = buildup-zone defensive
  action supply. xg/shot (~0.15 vs ≤0.12) trades against volume via
  optimism; goals ~5.8 until those land.
- **GATES at checkpoint**: realism 7/7 ×4 (the ordering guard held through
  the entire rebuild); sweeps at n=150: press→fatigue PASS, risk→xg/shot
  PASS, crossBias→aerials PASS (three of the four dead sweeps now respond
  DECISIVELY — the point of the rebuild); press→ppda directionally right,
  gated on the buildup mechanism; lineHeight→offsides needs its threshold
  revisited (EV play yields ~1.3 offsides — box-centric, fewer line-riders).
  Aggregate 82/0 (bit-identical path), unit 31/31, agent e2e 5/5,
  keyed-RNG determinism throughout.
- **The human acceptance is visible**: strikers SHOOT from shooting
  positions (a 0.3-xG chance now outscores a square pass by construction).
  Goals/match not yet in band — remaining work is the two scoped items, not
  a rethink. Process note: a git-stash timeout nearly lost the rebuild
  mid-arc (two harness reads silently measured the old engine); recovered,
  and WIP now commits immediately.

## 2026-08-31 — calibration step 2 attempted: NO safe temperature exists — joint re-fit required

The step-2 thesis (rescale the temperature, re-tune possession σ + home
shape) is FALSIFIED by a four-point bracket. Engine changes REVERTED; the
evidence and the revised plan are the deliverable.

- **The bracket** (ENGINE=agent, n=150 × 3 seeds, band failures + sweep
  responsiveness at each effective temperature):
  | stack | eff. T | band fails | the 4 sweeps |
  | baseline | ~0.80 | ~14 | unresponsive (the step-1 diagnosis) |
  | ÷1.3 | ~0.55 | 39 | press/risk STILL unresponsive |
  | ÷1.6 | ~0.42 | 44 | press/risk/xg unresponsive |
  | ÷2.75 | ~0.28 | ~50 | crossBias responds; press/risk don't |
  | ÷4 | ~0.18 | 55 | mostly unresponsive |
  Sweep responsiveness does NOT emerge at any point before the equilibrium
  collapses. Choice SHARES respond (probe: risk hi doubles longPass share at
  ÷4) but the sweeps measure OUTCOMES, and the same temperature change that
  frees the instruction signal also breaks goals/shots/xg-mix/fouls/headers/
  possession-σ — the outcome deltas drown in equilibrium shift.
- **Why the equilibrium breaks**: every cardinal score was implicitly FITTED
  to noise-dominated choice. Exposed at expressive T: shotBaseScore −0.76 is
  a noise gate (a 0.3-xg chance scored −0.45 vs +0.4 for a square pass —
  shots only ever fired via sampling noise; the live "striker passes
  backward" bug in one number); carries chain unrealistically (score fitted
  under noise); fouls/cards/headers collapse with the option mix.
- **press↑→ppda↓ is not a decision-layer failure at all**: pressingIntensity
  acts through positioning (chase pull), and no temperature made ppda
  respond — the pressing→forced-turnover pipeline needs a MECHANISM (defensive
  challenges off pressure), not a knob.
- **What step 2 actually is**: a joint automated re-fit of ~10–12 coupled
  knobs (temperature stack + option-score cardinals + completion logits)
  against the full 82-check objective, plus the pressing-turnover mechanism,
  plus the clear-chance shot kink (right shape, proven unshippable at old T:
  1.12× preference — drowned). Tooling now exists: scripts/cal-run.py runs
  hardened parallel evaluations on temporary Fly performance machines.
- **The dispatch pipeline** (hard-won, for every future run): fly ssh kills
  the session's process tree on disconnect (nohup does NOT survive) → remote
  work must be owned by the machine's PID1 (init waits on a go-flag);
  the stat harness prints NOTHING until completion → liveness = process
  existence via /proc, never log growth; every step verified, hard time cap,
  destroy-in-finally. Local-network blips must not be read as remote death
  (PID1 runs survive them — reattach, don't rerun).
- Working tree reverted to the step-1 state: all gates hold by construction
  (agent 64/18, realism 7/7 ×4, aggregate 82/0, offsides ~2).

## 2026-08-31 — launch blockers: the forced-close 23514 + the completion floor made structural

- **BUG 1 (N=2 season-boundary 23514) diagnosed and fixed — it was never the
  season-advance.** `forceMatchweekDeadline` pulled only `deadline_at` to
  now(); the schedule lays weeks out on the REAL cadence (each opens at the
  prior deadline), so every week after the first forced one still has
  `opens_at` in the future — the UPDATE violates
  `CHECK (deadline_at > opens_at)` (Postgres reports an UPDATE's new tuple
  as a "new row", hence the misleading message). Reproduced deterministically
  on a fresh N=2 league: week 1 forces fine, week 2 throws 23514. The N<4
  regular → season_end → rollover advance itself creates NO matchweek rows
  and is sound for all N (N≥4 seeds playoff weeks at now/now+cadence — also
  sound). Fix: forcing declares the week open-and-due NOW (`opens_at` comes
  along, LEAST-clamped). league-season-boundary.test.ts walks an entire N=2
  season through the force path to season 2's auction.
- **BUG 2 (auction completed at 11/13): made IMPOSSIBLE structurally; the
  historical root cause still needs the prod query.** Archaeology on current
  and prior code found no app path that passes the gate below the floor
  (counts are committed reads under the seasons row lock; nothing ever
  deletes squad_players; squadMin has been 13 since it existed). Rather than
  trust one ledger, completion now requires BOTH `squad_players` and ACTIVE
  `contracts` at squadMin per club (whichever is lower binds — the note's
  "counts diverge" suspect is now a blocker, not a slip-through), re-asserts
  the floor after the phase transition (violation throws and rolls back the
  whole completion, schedule included), and stale auction-close jobs firing
  after completion (queue lag — observed live with 1s lots) are now no-ops
  instead of signing players into a post-auction season — the one real
  post-completion squad-mutation path found. league-auction-floor.test.ts
  pins all three. Verification SQL for the live DB (run when convenient):
  `SELECT club_id, count(*) FROM squad_players WHERE season_id=<s> GROUP BY 1`
  vs `SELECT club_id, count(*) FROM contracts WHERE released_at IS NULL
  GROUP BY 1`, plus `SELECT * FROM auction_lots WHERE season_id=<s>` for the
  forfeit/re-open history.
- **Ops finding (launch checklist):** the fly app currently runs TWO
  machines; fly.toml's contract is ONE always-on process (duplicate pg-boss
  pollers are lock-safe but double timer traffic, and the per-process login
  rate limit halves). `fly scale count 1` before launch.

## 2026-08-30 — agent calibration step 1: the offside MODEL + the sweep diagnosis

- **Offsides diagnosed, then re-modeled** (was ~21/team-match; real ~2.2).
  The margin probe showed 100% of flags in the 0.5–1.5m band with receivers
  moving BACK toward onside — not stranded runners, and not a broken line
  (second-last defender was computed correctly). The cause was structural:
  passer judgement (accept ≤ line+1.5m) was LOOSER than the flag (+0.5m),
  and both evaluate the SAME tick's positions — so every pass to a
  band-sitting shoulder-rider was a deterministic offside. "Run timing"
  did not exist as a mechanic.
- **The new model**: passers judge STRICTLY (accept receivers at/behind the
  line — passerLineJudgementM 0), which makes same-tick geometric flags
  impossible for chosen receivers (the geometric check stays as a backstop).
  Offsides now come from MISTIMED RUNS: a line-riding receiver (within
  offsideRideZoneM 4 of the line) of a forward pass strays on a keyed draw
  (`rng.chance(…, tick, receiverId, 'offside-timing')` — no stream
  reshuffle), scaled by off-the-ball movement (offsideTimingSkill 0.5: OTB
  20 halves the rate, OTB 0 ×1.5). mistimedRunProb 0.015 — harness squads
  attempt ~160 line-riding passes/match → **2.2–2.3 offsides/team-match on
  all three seeds** (was 15.4–16.3 at prob 0.1; real ~2.2). The
  lineHeight↑→offsides↑ sweep still passes (2.70 vs 1.60, gate +0.5)
  because a higher line clamps more receivers into the ride zone —
  the mechanism preserves the tactical signal by construction.
- **Sweep diagnosis (Part B — the arc-scoping answer): wired, but drowned.**
  A choice-counting probe (decision-model injection) shows instruction
  biases ARE in the scoring and directionally correct — but the softmax
  temperature averages ~0.80 in play (base 0.55 + pressure noise) while the
  top1–top2 score gap averages ~0.08. Signal-to-temperature ≈ 0.1: choice
  is near-uniform among plausible options, so risk 0.15→0.85 moves option
  shares by ~1% (longPass 1.8→2.1%). THIS IS ONE ROOT CAUSE, NOT FOUR:
  press/risk/cross sweeps all fail for the same reason. Fix class:
  medium — re-scale the temperature stack (base/pressure-noise/decisions
  relief) so scoring expresses, then re-tune every band that shifts (this
  is the real calibration arc, one global knob with global consequences —
  NOT a per-instruction gain hunt, and NOT a rewiring problem). Caveat: the
  cross share was 0% in the synthetic probe (geometry gate), so crossBias
  needs re-probing with winger anchors after the temperature work.
- Realism (league ordering) re-verified ×4 after the offside change; the
  aggregate engine untouched (agent-only files).

## 2026-08-29 — engine switch attempted: BLOCKED on outcomes, not cost

The decided switch to the AgentEngine ran its three gates. Two passed, one
failed — the default STAYS AggregateEngine, and the failure is precisely
scoped:

- **INTEGRATION: PASS.** Full server suite (14 files) green with AgentEngine
  as the default (1:51 total — sims add ~20s). league-admin.test.ts is now
  PINNED to the AgentEngine as the standing proof: a real forced week-close
  sims through the real pipeline and the stored replay is verified real
  motion — ≥800 frames, carrier-tagged, ball within 1.5m of the tagged
  carrier on ≥95% of carried frames (the exception is a frame landing
  exactly on a goal-reset tick, where the ball sits at the centre spot while
  the next kicker is tagged), players covering real distance.
- **SIM-COST: PASS.** engine/bench-agent.ts (pnpm bench), run ON the
  production machine (shared-cpu-1x/512MB via fly ssh): mean 1.6s/half,
  p95 2.2s, ~3.2s/match, 545KiB frames/match, 14MB heap. An 8-club
  matchweek ≈ 13s inside the week-close job. No OOM, no timeout risk.
- **OUTCOMES: FAIL.** ENGINE=agent stat harness: **58 pass / 24 fail**.
  Systematic, not noise: possession σ ~13 vs the 6–9 band, ~20 offsides per
  team-match (info metric, visibly absurd in event lists), home-advantage
  shape off (home 0.39–0.43 vs 0.43–0.46, away high), second-half goal share
  low, and 4 instruction sweeps unresponsive (press↑→ppda↓, risk↑→passAcc↓,
  press↑→fatigue↑, crossBias↑→aerials). ISOLATED: re-run at legacy motion
  (deadzone 0 / smoothing 1) fails identically — PR #34's damping did NOT
  cause this; the agent engine was never calibrated to the stat bands. The
  stat-harness comment ("bands expected to fail until calibrated") was
  accurate; the realism harness (7/7 ×4) gates league-level ordering only.
- **What the switch now needs**: an agent calibration project — the offside
  mechanic first (~20/match points at run-timing/tolerance, likely a model
  fix not a knob), then possession-spread and home-advantage tuning across
  AGENT_CAL, then the sweep responsiveness — gated by ENGINE=agent stat
  runs. Same shape of work as the aggregate's original calibration arc.
- **Shipped anyway (inert without opt-in)**: `SIM_ENGINE=agent` env lets a
  deployment run the spatial sim knowingly (loud boot warning about the
  uncalibrated stats) — the test league can watch real motion today;
  `SIM_ENGINE` validated, default aggregate. bench-agent.ts stays as the
  cost gate for the eventual switch.

## 2026-08-28 — motion pass: the yoyo and the wandering ball — and the ENGINE FINDING

- **FINDING (load-bearing): production runs the AggregateEngine.** The
  orchestrator's default (`engine = new AggregateEngine()`,
  league-orchestrator.ts) was never flipped; nothing in server/ instantiates
  AgentEngine. So prod results are the aggregate engine's (stat-harness
  gated — fine), and prod REPLAYS are `fabricateFrames` — cosmetic fiction,
  not simulated motion. Both reported symptoms (yoyo, ball never at feet)
  were artifacts of that fabrication: IID gauss noise re-rolled around
  anchors every keyframe, and a ball random-walking (σ9m/frame) attached to
  nobody. The calibrated agent sim was never what anyone watched. SWITCHING
  ENGINES IS A SEPARATE DECISION (deliberately not made here): AgentEngine
  implements the same SimEngine contract incl. HalfTimeState v2 resume and
  passes the realism gates, but the switch needs its own validation pass —
  integration suite against AgentEngine, per-fixture sim cost check, and
  acceptance that all live-league results change generator.
- **Aggregate fabrication reworked** (cosmetic-only path — no stat reads
  frames): players get a persistent offset + momentum wander (calm drift,
  held shape — no more per-keyframe re-roll); possession is fabricated
  (carrier holds at feet a few frames → pass → occasional loose-frame
  turnover) and frames emit `carrier`. Fabrication now draws from a
  DEDICATED Rng fork; a legacy-stream burn shim replays the old draw
  pattern on the outcome stream because dropping those draws re-noised all
  three harness master seeds (v3 fell out of band). Shim removable only
  with an aggregate recalibration or the engine switch. Stat harness: 82/0.
- **Agent motion damped** (the yoyo fix where motion is real):
  `stepToward` gains a deadzone (0.7m — stand calmly instead of
  micro-hunting a jittering per-tick attractor) and velocity inertia
  (accelSmoothing 0.65 — direction changes curve, not reverse).
  CALIBRATION-TUNED: stronger damping (0.35–0.55 blends) compressed quality
  separation — the sharp fixture fell to 0.525 and the real pool sat at
  exactly 0.550 vs the >0.55 gate. At 0.7/0.65 ALL FOUR realism suites pass
  with margin: real 0.650, real-sharp 0.575, fixture 0.725, fixture-sharp
  0.625 (r 0.83–0.87 throughout).
- **ReplayFrame.carrier** (optional field): both engines emit who has the
  ball; the viewer glues the ball to the carrier's interpolated dot, renders
  carrier changes as the ball travelling between the two MOVING players, and
  falls back to nearest-player inference on pre-field frames.

## 2026-08-27 — replay viewer: spline motion + inferred possession

- **Viewer-only pass, deliberately**: the improved presentation is the
  DIAGNOSTIC for whether the underlying movement is good — engine frames
  (6 sim-seconds apart) are untouched.
- **Catmull-Rom through four keyframes** replaces linear lerp: players move
  in continuous curves instead of segments that snap direction at every
  keyframe (the "wave-like/rigid" look). Neighbor frames only join the
  spline across playable gaps (halftime still snaps); two-frame segments
  degenerate to a symmetric Hermite whose MIDPOINT EQUALS the old lerp, so
  existing behavior contracts held. The BALL flies straight whenever a
  segment endpoint is airborne — kicked balls don't curve — and splines
  only across carried ground segments. Rendering already ran per-rAF
  (60fps); continuity, not sampling, was the gap.
- **Possession is INFERRED, and that's a noted gap**: frames carry no
  carrierId — `carrierAt` names the nearest player within 2.2m of an
  on-ground ball, and the viewer adds hysteresis (+0.8m slack for the
  incumbent) against flicker. Ring on the carrier; a pass reads as ring
  off → ball travels (short fading trail) → ring on the receiver; a loose
  on-ground ball gets a dashed halo + trail so no-possession is a state,
  not a bug. IF inference flickers in practice, the honest fix is the
  engine emitting `ball.carrierId` per frame (one field in agent-engine's
  `frame()`) — sim-side, next calibration-free engine PR.

## 2026-08-26 — test-only week forcing: sim MW1 now, on the real pipeline

- **POST /api/admin/force-week-close** (TEST_FORCE_WEEK_CLOSE=1 +
  `{"confirm":"SIM NOW"}`): pulls the current matchweek's deadline to now()
  and calls the orchestrator's own `runWeekClose` — real sims with default
  lineups where none were submitted, bookkeeping, the between-week tick,
  reveal, season choreography. NOT a shortcut; it validates the live
  pipeline. Guard is structural: without the env flag the route is never
  registered (404), so it cannot fire in a real season.
- **MATCHWEEK_CADENCE_MINUTES_TEST**: schedule generation (auction
  completion + playoff seeding) reads `matchweekCadenceMs()` from the new
  `league-test-overrides.ts` instead of LEAGUE_CFG inline — real 7 days
  unless the var is set. Affects newly generated weeks only.
- All test overrides now live in ONE module (league-test-overrides.ts),
  warn ⚠️ at boot, and are enumerated in DEPLOY.md's go-live checklist —
  the lesson from the 5s timer that shipped invisibly from an edited tree.
- **OPEN INVESTIGATION (do not forget)**: the live test auction completed
  with Beta United at 11/13 — below squadMin. The completion gate
  (league-auction.ts maybeComplete) reads
  `clubs.every(count >= squadMin)` with squadMin from LEAGUE_CFG (13, no
  production tuning), which LOOKS correct — so either the count query
  (store.squadCounts) diverges from the UI's count, something removed
  squad_players/contracts after completion (forfeit? release?), or the UI
  undercounts (e.g. injured players filtered). Verify against prod:
  `SELECT club_id, count(*) FROM squad_players WHERE season_id=… GROUP BY 1`
  vs contracts, and check auction_lots forfeit history for Beta. Potential
  real-league blocker; investigate before the friends' season.

## 2026-08-25 — tactics editor polish + the live team-shape pitch

- **Zone labels live OUTSIDE the box** (a chip above the bbox, below when the
  zone hugs the top edge) — text can no longer spill out of a small zone at
  any size. **Zones resize** by dragging bbox-corner handles: every vertex
  scales about the OPPOSITE corner (rects resize classically; hand-shaped
  polygons keep their proportions; never flips, min 4×3m, clamped to pitch).
  Engine contract untouched (convex ≤8 verts — scaling preserves both).
- **Save preset from the editor**: the phase-preset shape gained `zones`
  (anchor + sliders + zones is the whole phase); saved from the editor's
  right pane without leaving the screen. Pre-zones presets (no `zones` key)
  apply without touching zones — device-local storage stays back-compatible.
- **The team tab is a live pitch, not bare sliders**: the eleven render
  through the ENGINE's own anchor deformation (AGENT_CAL via the new
  `@fm/engine/agent-model` export — read-only constants, no new dep edges):
  lineHeight shifts the block, width scales spread, compactness squeezes
  toward the centroid; ghost dots mark raw anchors so displacement is
  legible. Out-of-possession block shown (where all three bite);
  press/tempo don't hold shape, so they render as derived facts (N chasers,
  chase range in meters). The viz cannot drift from the sim because it IS
  the sim's formula.
- **Lineup-as-pitch (drag players on/off, bench alongside) SPLIT to its own
  PR** — real drag-and-drop with inherit-on-swap interplay; per the brief's
  own rule, too big to ride along.
- **Auction timer test override is now an ENV VAR, never a tree edit**:
  `AUCTION_LOT_SECONDS_TEST` (loud ⚠️ warning at boot, soft close derived,
  visible in `fly config show`, launch checklist demands it unset). The
  repo's LEAGUE_CFG stays 120s/20s — a 5s value must never be committed or
  invisibly deployed from an edited working tree again.

## 2026-08-24 — the economy reconciled onto the realistic-millions scale

- **The bug** (live test season): market values are real euros (elite ~200M)
  but budgets (100k) and wage caps (10k) were placeholders — one star's wage
  broke the cap and nothing was affordable; the auction was unplayable.
- **The scale** (LEAGUE_CFG): `defaultTransferBudget` 2B, `defaultWageCap`
  150k/wk, `wagePerMarketValue` 0.0001 → **0.000093**, `bidIncrementMin` 1 →
  **1M** (fixed, not a %: the minimum next bid stays head-computable
  mid-timer; 0.5% of an elite lot), `facilityCostByLevel` →
  **[50M, 100M, 200M, 350M, 600M]** (one facility maxes at 1.3B = 65% of a
  budget; both at 2.6B > budget — the PR #14 "can't max everything" rule
  survives the rescale). setupSeason defaults now read LEAGUE_CFG.
- **THE WAGE CAP IS THE PRIMARY BINDER** — and the parity lever to revisit
  after playtest. The formula is derived, not picked: the design basket
  (4×200M elite + 9×90M starters = 1.61B of value) must land just under the
  cap → 150k/1.61B ≈ 9.3e-5. That basket wages to 149,730 (99.8% of cap); a
  5th elite breaks it even trading a starter down; filling to squadMax
  breaks it; and the basket costs 1.61B of a 2B budget (≤85%), so money
  never binds first. All of this is a CI invariant
  (engine/league-economy.test.ts), so a future retune must re-derive.
- **6b re-calibrated on the new scale**: the growth harness's max-hoard
  ALLOTMENT was a hardcoded 100k — a fiction after the rescale (a hoarder
  could never afford a 50M facility and unspent compounding would trip the
  interest gate). It now tracks `defaultTransferBudget`. Re-run: 15/15 on
  fixture AND real pool — hoard-vs-bring gap +0.22/5yr (<0.5), increments
  decelerating, interest share 26.4% (<30%). X=0.10 and leftover→reserve 0.5
  are rate knobs and stayed put.
- Tests keep their toy economies via `AuctionTuning.bidIncrementMin` (the
  same pattern as the timer knobs); the split-lock 409 is scale-free and
  still covered.
- **Auction UI**: the lot now shows the player's WAGE and the cap impact
  ("wages if won 96k/150k", OVER CAP inline warning) — wage was invisible
  until a rejected bid; the money pane shows wage ROOM; `fmtMoney` (2.0B /
  350M / 18.6k) everywhere in the room because ten-digit numbers don't fit
  a 375px pane; bid controls step by the real increment (min / +10M).

## 2026-08-23 — production league setup is script-only, safe by construction

- `scripts/setup-production.ts` creates the league (managers/clubs/season →
  auction) on an EXISTING database — there is no in-app league creation.
  Safety is structural, not procedural: it never drops or seeds anything,
  refuses unless the DB is a virgin league (players > 0, zero seasons, zero
  clubs — half-states abort with "inspect first"), and DRY-RUN IS THE
  DEFAULT (`--apply` to write). One clubs.json shape serves both the 2-club
  test season and the real 5–10 club league.
- It creates the FIRST season only: rollover owns N+1, and replacing a test
  league pre-launch is a deliberate manual teardown (DEPLOY.md §1.4) — the
  script will not paper over an existing season.
- setupSeason now LINKS a pre-existing manager by email
  (`ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`)
  instead of failing on the unique constraint; an existing manager keeps
  their display_name. Managers stay seeded-not-registered.
- seed-demo.ts (destructive: drops schemas) now REFUSES non-localhost hosts
  at runtime — the LOCAL-ONLY rule is enforced, not just documented.
- Tested as an operator would run it: league-setup-production.test.ts spawns
  the actual scripts as child processes and asserts every guard (empty pool,
  dry-run writes nothing, apply creates + links, second apply refuses,
  seed-demo non-local refusal).

## 2026-08-22 — production deployment: Fly + Supabase + Resend, runbook-driven

- **Topology**: one always-on Fly machine (`fly.toml`, shared-cpu-1x/512MB,
  ~$5/mo) runs the existing single process (API + pg-boss worker) and serves
  `web/dist`. ALWAYS-ON IS LOAD-BEARING: pg-boss timers fire deadlines; Fly
  auto-stop would delay them until a request wakes the machine — `auto_stop
  = off`, `min_machines_running = 1` are correctness settings, not cost ones.
- **Supabase = connection string only** (we keep our own magic-link auth; no
  Supabase Auth/Realtime/Storage). Documented connection is the SESSION
  pooler (port 5432) — pg-boss + our explicit BEGIN/COMMIT row-lock
  transactions need session semantics; the transaction pooler (6543) is
  called out as unsuitable.
- **Email**: Resend behind the existing LinkDelivery interface
  (`league-email.ts`) — one HTTPS POST via global fetch, NO new dependency,
  provider swappable in one module. Selected by env (`RESEND_API_KEY` +
  `EMAIL_FROM`); absent → console stub as before, with a warning when
  `BASE_URL` is set (production smell). Failures THROW → request-link 500s;
  a swallowed send would be indistinguishable from the deliberate
  unknown-email 204. Noted as the fallback channel if iOS-push reveals flake.
- **Runtime config via env** (league-server.ts): HOST/PORT/BASE_URL override
  the LEAGUE_CFG dev defaults; BASE_URL drives magic-link URLs and flips the
  session cookie to `Secure`. Secrets (DATABASE_URL, SESSION_SECRET,
  RESEND_API_KEY) live in Fly's secret store, never committed.
- **`/api/health`** (unauthenticated): `SELECT 1` through the shared pool —
  proves HTTP + DB, probed by Fly's checks and CI.
- **The deployable artifact is CI-gated**: the new `deploy-image` job builds
  the repo Dockerfile (Node 24 runs the server TS directly — no server build
  step to drift; Vite builds the PWA; runtime stage installs prod deps only),
  boots it against a service Postgres, and probes /api/health + the SPA
  fallback. Verified locally the same way before shipping.
- **Schema cutover documented, no migration framework built**: pre-launch =
  create-once (`schema.sql` run once via psql); post-launch = hand-written
  ALTER migrations with schema.sql kept canonical (docs/DEPLOY.md §1.3).
- **Backups**: Supabase FREE tier has NO automated backups → nightly
  `pg_dump` workflow (backup.yml) uploads a GitHub artifact, 30-day
  retention. ENCRYPTED (AES-256, `BACKUP_PASSPHRASE` secret) because the
  repo is public and public-repo artifacts are downloadable by any logged-in
  GitHub user — a raw dump leaks manager emails and LIVE SESSION IDS.
  No-ops until the two secrets exist, so it merged ahead of go-live.
- **docs/DEPLOY.md** is the go-live runbook: Supabase → Resend → Fly secrets
  → deploy → Cloudflare DNS (DNS-only records — Fly owns TLS; cert issuance
  is unreliable behind the proxy) → verify → backup rehearsal. Includes ops:
  redeploy, health triage, SESSION_SECRET rotation (invalidates all
  sessions and unredeemed links per the PR #11 design — rotate between
  matchweeks).

## 2026-08-21 — design pass, chunks 2–4: every screen on the one language

- **home** (3 states): the fixture hero never scrolls; the attention column
  surfaces EXISTING state only (suspensions/injuries/affordable facility/
  training confirmation — never advice); scout = table position + last
  revealed results (full tactic-scouting stays season-2).
- **season**: results list via GET /api/results (the standings embargo join,
  tested pre/post-reveal); MATCH DETAIL replaces the separate result/replay
  screens — fixed score header, timeline/replay/stats tabs, goal rows carry
  ▶watch buttons that cue the replay 6 s before (ReplayViewer cueT prop).
- **squad player hub**: two-pane; 26 attributes grouped (gk group only for
  keepers), contract w/ seasons remaining, own season stats (apps/goals/avg
  rating/minutes — ASSISTS don't exist in engine events → parked), growth
  trajectory from attribute_audit. Training dial lives at /squad/training.
- **tactics**: the gravity-halo pitch editor (SVG; halo + dashed ring says
  "tends here, drifts, returns" — the screen's one job), 6 phase tabs
  morphing the team shape, faded-dot context players (tap to promote,
  exactly one detailed), zones with visible weight (add at anchor / drag /
  weight / remove), per-phase player sliders alongside; lineup tab with
  INHERIT-ON-SWAP (the config belongs to the slot); team instructions on a
  separate surface; presets are DEVICE-LOCAL (localStorage — server-side
  named presets need a table → parked; default_tactics stays the one
  server-saved plan, and the editor edits exactly that via the new GET).
- **market**: the auction rebuilt to the three-pane sketch — center live lot
  with position-aware bid stats (6–8 role attributes, full 26 on tap; pool
  payloads now carry attributes) + soft-close timer with a visible
  "+extended" pulse; left squad progress + per-position THIN warnings
  (4-4-2 floors); right money (fixed bidding balance + reserve + the split
  slider until first bid — display, never invest buttons). Transfers
  two-pane (market browse | your window). 375px check: the lot card never
  scrolls (stats grid scrolls within it), side panes 168/188px (148/172
  ≤480px height) scroll in-box.
- New server surface in the pass, all VIEWS over existing data: /results,
  /squad/player/:id, GET /default-tactics, pool attributes. Nothing from
  SEASON-2-PARKING was built; two items were added to it (assist tracking,
  server-side presets).

## 2026-08-20 — design pass, chunk 1: the design-system foundation

- **Palette stops proposed per DESIGN-SPEC** (clean/light, color = meaning):
  ink #1c2030 / muted #667085 on bg #f4f5f7, surfaces white, lines #e4e7ec.
  Selection/accent = the sketches' purple: #534AB7 (deep #423A99, soft
  #ECEAFB). Position hues — GK amber #D97706, DF blue #2F6FED, MF green
  #0E9F6E, FW red #E0475B, each with a soft tint for chips/rows. Status:
  fit green #0E9F6E, injured #D92D20, suspended #D97706, unsharp muted;
  condition bar green, sharpness bar indigo #6172F3.
- **Always-landscape shell**: 100dvh app frame, no page scroll — content
  panes own their scrolling (the ~375px-height rule: heroes never scroll,
  secondary columns scroll in-box; a max-height:480px media tier compacts
  rhythm further). Small-screen PORTRAIT gets the one prompt the app has —
  a hold-sideways card (a web app cannot force orientation; this is the
  minimal honest version of "always landscape").
- **Left rail, 5 sections** (triage/manage/deploy/invest/compete = home /
  squad / tactics / market / season), inline-SVG icons, active = purple
  pill. Market carries a red live-dot whenever phase ∈ {auction,
  transfer_window} (the "unmissable window" rule); the app refreshes /me
  every 60 s so the badge tracks phase without websockets.
- **Section frame + primitives**: Section (title + tab chips + body),
  .screen/.pane/.pane-hero/.pane-scroll two-pane primitives, PosChip (the
  position hue everywhere a player appears). Existing screens are HOSTED in
  their sections now (market → auction/transfers/facilities tabs, season →
  standings/bracket, squad → training) with legacy routes redirecting;
  their full redesigns land in chunks 2–4.
- Note: no frontend-design skill exists in this environment — DESIGN-BRIEF
  and DESIGN-SPEC are the authority for the pass.

## 2026-08-14 — end-of-season playoffs: top-4 knockout crowns the champion

- **Phase machine**: `playoffs` sits between regular and season_end —
  regular → playoffs → season_end (SQL trigger + TS mirror + smoke guards).
  regular → season_end stays legal for the DEGENERATE N<4 case only
  (demo/test leagues can't field a top-4 bracket); leagues of 4+ always
  play the knockout. The rollover trigger MOVED: season_end (growth, expiry,
  next auction) fires when the FINAL resolves, not at the last regular
  reveal — everything PR #19 does is unchanged, just re-gated.
- **Bracket**: top 4 from the FINAL table (points/GD/GF/name — the standings
  ordering is the seeding). Semis 1v4 and 2v3, TWO legs on aggregate, the
  HIGHER seed hosting the decisive second leg (the earned edge). The final
  is ONE match at a NEUTRAL venue: fixtures.neutral_venue zeroes the home
  boost in BOTH engines (aggregate homeShotBoost, agent homePressureRelief)
  — verified by an identical-clubs A/B (home edge present normally,
  symmetric under the flag) and by the realism fixture gate staying
  byte-identical (absent flag = no-op, no recalibration).
- **Ties are a structure over fixtures** (playoff_ties): playoff fixtures
  are REAL fixtures through the existing sim/HT/embargo/bookkeeping paths;
  the tie row carries seeds, leg references, the winner, and the shootout.
  The final tie is created only when both semis resolve.
- **Penalty shootout** (engine/penalty-shootout.ts, pure): triggers on a
  level aggregate (no away-goals rule, no extra time) or a drawn final.
  Best-of-5 alternating (deciding-fixture home side first), early
  termination when unwinnable, sudden-death pairs. Takers = the on-pitch XI
  (half-2 tactics minus sent-off) ordered by finishing, five best then the
  rest cycling; keeper = the on-pitch GK (gloves pass to the best
  gk-rated outfielder if he saw red). Kick model reuses the in-match
  penalty base (0.76) ± taker finishing / keeper (gkReflexes+gkPositioning)
  around 12, clamped 0.55–0.92 — constants live in the shootout module,
  NOT the harness-gated CALs (shootouts never occur in harness play).
  Deterministic: every kick draws Rng.fromSeed(`${fixtureSeed}|shootout|n`).
  The shootout decides the TIE ONLY — the 90-minute scoreline and stats
  stay as played (asserted).
- **Cadence**: leg 1 / leg 2 / final are three consecutive playoff-kind
  matchweeks on the normal weekly cadence — every existing mechanism
  (deadlines, HT windows, embargo, ticks, one-match bans between legs)
  applies untouched; compression would need new deadline plumbing for zero
  gain at human-manager scale. The between-week tick RUNS during playoffs
  (recovery, healing, sharpness — non-qualifiers rest and recover too);
  growth remains strictly a season_end event. Matchweek kind 'playoff'
  keeps playoff weeks out of the regular-season-over count.
- **Champion recorded** on seasons.champion_club_id when the final
  resolves, in the same reveal transaction (no embargo leak — the tie's
  winner/shootout only become non-null as the deciding week reveals).
  Bracket view: GET /api/playoffs (revealed leg scores only) + /playoffs
  screen with seeds, aggregates, shootout kicks and the champion.
- Timers: bracket seeding returns the three new matchweeks from the
  week-close transaction; the orchestrator arms their close timers after
  commit (the auction-completion precedent), injected into the core via
  CoreOptions.scheduleWeekClose.

## 2026-08-08 — pre-auction budget split (6b): bring vs reserve, calibrated

- **The split**: before bidding, a club divides its allotment into
  auction_budget (BROUGHT — the fixed bidding balance for the whole draft;
  NULL = no split set = bring everything, so every pre-6b flow is unchanged)
  and reserve_balance (held back). Set/re-set freely via
  PUT /api/auction/split until the club's FIRST bid (or won lot) — from
  then it binds (409 split_locked). Facilities stay un-buyable during the
  draft and bidding checks stay race-free because the bidding balance is a
  fixed number, not a live account.
- **Reserve is a LIVE balance** on club_seasons, mutated only under the
  club_seasons row lock (the same money lock facilities/transfers already
  take); transactions remain the audit trail. It is spendable ONLY on
  facilities + the mid-season window (buy fees and pool signings debit it,
  sale fees credit it) and NEVER re-enters auction bidding — banked money
  returning to the draft would be free-interest delayed spending. A
  bring-everything club therefore buys no facilities that season: that IS
  the decision weight.
- **Bindingness of leftover**: unspent bring converts to reserve at 0.5 at
  auction completion (runs once — the completing txn holds the seasons row
  lock and leaves the auction phase). At 1.0 the split is theater
  (bring-everything strictly dominates); at 0.0 prudent bidding is punished
  brutally; half-back makes over-bringing a real forecasting cost.
- **Growth tick: ONCE per season, at rollover** (reserve carries
  ×(1 + reserveGrowthRate) into season N+1). Interest is earned by HOLDING
  across the season boundary — bank-at-auction, spend-at-window earns
  nothing, killing the free intra-season interest play; and one compounding
  event per season maps 1:1 onto the harness. The new draft starts unsplit.
- **X = 0.10, CALIBRATED not guessed** (growth-harness scenario 4, CI
  fixture gate): max-hoard (bank the full 100k allotment every season, buy
  training facilities greedily) vs bring-everything (facility 0 forever) —
  the worst-case strategy gap. Measured: XI-mean gap grows +0.21 over 5
  seasons, DECELERATING (increments 0.041 → 0.029) — hoarding buys the
  already-bounded facility ceiling faster, not more; interest is 20.2% of
  principal banked (reserve ends ~471k of 500k). Honest finding: the gap
  gate is X-INSENSITIVE (facilities max by season ~1 at any X — the channel
  saturates), so the binding gate is the interest share (< 30%, "banking
  not investing") as the proxy for un-modeled window buying power. At
  X=0.5 that gate trips at 154.6% — the tripwire works. Verdict: "draft
  lean, hoard, bank, snowball" is NOT dominant at 0.10.
- Now-vs-later: the reserve system lands after rollover (#19) because the
  growth tick needs a season boundary to ride, and before any richer
  economy (prize money, gate receipts) so those can pay INTO an
  already-bounded reserve rather than inventing a second pot.

## 2026-08-02 — season rollover: the multi-season loop (season_end → complete → N+1)

- **The rollover rides the final week-close transaction**, immediately after
  season-end growth: growth → contract expiry → complete → season N+1 in the
  auction phase (league-rollover.ts). revealed_at stays the single
  exactly-once marker, so a crashed rollover replays from the reveal.
  season_end and complete flash by unobserved — nothing needs the pause
  until a renegotiation feature exists. Zero admin: the game repeats.
- **ORDER IS THE INVARIANT**: growth applies to contracted players FIRST, so
  an expiring player departs at his GROWN state and re-freezes in the pool
  by the locked rule (nothing ever touches uncontracted attributes). A
  re-draft picks him up exactly where the audit left him — verified both
  directions (audit.after == current state; never re-applied, never lost).
- **Retention scope v1: expiry only.** A contract signed season S with
  duration d covers seasons S…S+d−1 and expires when S+d−1 completes. NO
  renegotiation and NO manual release window: duration IS the retention
  mechanism (picked 1–4 at signing, wage flat by model — the forfeit-rule
  argument again: renegotiating wage would need a negotiation model we
  don't have), and the next auction re-acquires leavers on an open market.
  released_at remains the admin escape hatch.
- **Cross-season familiarity** (the transfer-PR open question, closed):
  pairs whose contracts BOTH carry at the same club keep
  familiarityCarryOver (0.5) of their end-of-season chemistry; any broken
  contract comes back cold — even re-drafted by the same club next week.
  Rationale: retention investment pays on the chemistry axis (duration > 1
  would be pointless there under a full reset), while the break still costs
  (full carry would ignore the off-season).
- **Money fresh, buildings carried**: season N+1 club_seasons copy the
  configured transfer_budget/wage_cap VALUES (spend resets automatically —
  transactions are per-season) until the reserve-growth economy exists;
  facility levels and the training dial carry (they're buildings/habits,
  and the growth harness already modeled persistent facility advantage as
  bounded). Carried players get fresh squad rows: the off-season heals —
  fatigue 0, injuries cleared, bans not carried (within-season sanctions,
  v1), sharpness back to the 0.3 cold start (pre-season rust for everyone).
- matchweek_count/transfer_week copy the old values at INSERT (schema CHECK)
  and are recomputed at auction completion, as always.
- **Proven repeatable**: league-rollover.test.ts plays TWO full seasons end
  to end through the production paths (real auction lots, real sims, real
  week-closes) and season 3 opens at the end — auction → weeks → window →
  weeks → growth+expiry+rollover → auction → … with every invariant above
  asserted, in ~2 s.

## 2026-07-27 — sharpness: the second fitness axis (condition/sharpness split)

- **Model**: condition = acute fatigue (existing `fatigue`); sharpness =
  match fitness on squad_players (REAL 0–1, schema DEFAULT 0.3 = the cold
  start). Built by minutes, decayed by the bench, tick-maintained. No smoke
  guard — a value column with no transition semantics (fatigue precedent).
- **Curves** (LEAGUE_CFG): gain 0.3/full match pro-rated by minutes/90;
  decay 0.06/week benched, 0.12/week injured (the treatment room can't train
  match-rhythm — this IS the "returnees come back LOW" rule, no extra clamp);
  floor 0.25. Calibration targets hit: a weekly starter saturates at 1.0, a
  4–6-week benching → 0.76–0.64 (noticeable, not crippling), a returnee is
  match-sharp after 2–3 games (0.3 → 0.6 → 0.9 → 1.0).
- **Cold arrivals — "not integrated" has two axes**: new rows (auction wins,
  pool signings) start at the 0.3 schema default; mid-season transfers clamp
  LEAST(current, 0.3) — like the familiarity wipe, and never a boost for an
  already-rustier mover.
- **just_returned GENERALIZED but the two costs stay DISTINCT**: the flag
  keeps exactly its re-injury-modifier meaning (consumed by one match);
  match-rust is a separate number with separate dynamics (decays while out,
  rebuilds over 2–3 games). One event (returning) moves both; nothing shares
  a number.
- **Effect is MEDIUM, decision + fatigue layers only** (execution noise
  stays attribute-driven — invariant intact): (a) fatigue accrual
  ×(1 + 0.5·(1−s)) — the visible cost, a rusty legs-drain; (b) decision
  temperature +0.06·(1−s), the SAME channel decisions relieve at 0.03/point
  → full-unsharp ≈ −2 decisions points. An unsharp star still beats a sharp
  filler; a marginal call flips. MEASURED into place: the first fit (0.09,
  −3 pts) dragged the real-pool mixed-distribution realism run to the 0.55
  win-share boundary with r 0.69 — too heavy per the medium rule, trimmed
  and re-measured.
- **Facility-INDEPENDENT by design**: sharpness SQL never touches
  club_seasons — play-rhythm is not health (medical) or development
  (training), and it would otherwise stack a third rich-club vector onto
  facilities. Tested (level 5 ≡ level 0).
- **Acceptance, both proven on the PR #17 fixture gates**: (1) full-sharp is
  a NO-OP — the default fixture realism run is BYTE-IDENTICAL to the
  pre-sharpness baseline (diff on --json output; keyed rng makes added reads
  free), so nothing leaks into the quality axis at s=1; (2) a realistic
  mixed mid-season distribution over the simmed XIs (deterministic
  name-hash: ~70% sharp 0.88–1, ~25% rotation 0.6–0.85, ~5% rusty
  0.35–0.55 — the XI is the most-played cohort, which a real mid-season
  keeps sharp; a 60/30/10 blanket was harsher than any realistic first
  team) passes 7/7 on BOTH pools: fixture win share 0.650 / r 0.818, real
  pool 0.675 / r 0.735. The mixed fixture run is a CI step
  (realism:ci:sharp): it trips if the penalty ever grows past medium.
  Stat harness untouched: 82/0 on all three seeds (synthetic squads carry
  no sharpness → 1 → no-op).
- UI: the two-bar condition+sharpness split on the lineup picker
  (FitnessBars), plus the training screen deferred from PR #16 (focus
  radio and intensity slider on GET/PUT /api/training).

## 2026-07-21 — harness CI fixtures: realism + growth tripwires in the merge gate

- **Problem closed**: the realism and growth harnesses were local-only (the
  fbref→squad join needs the human-populated, uncommitted cache CSV), so CI
  could not catch a squad-realism regression or a growth-compounding
  runaway — the guard only fired if a human remembered to run it. Proof it
  was real: the realism harness had been silently failing 2/7 since PR #10's
  tempering (top-8 win share gate 0.60 vs the ACCEPTED 0.575 balance point;
  market-value anchor 0.40 vs post-tempering ~0.31) and nobody saw.
- **Committed fixture pool** (engine/harness-fixture.json, ~330 kB): 24 real
  clubs / 411 players, generated by make-harness-fixture.ts (local, cache
  present; `pnpm harness-fixture` — regenerate when players.sql changes
  materially). Band-sampled, ends dense: the REAL top-8 and bottom-8 clubs
  plus 8 spread through the middle, so the top-vs-bottom check exercises the
  same extremes as the acceptance run (fixture win share replicates the real
  pool's 0.575 exactly — XIs are minutes-picked and seeds fixed). The clubs
  owning the pool's best and weakest eligible GK are always included so the
  keeper check keeps a real gk-attribute spread. Per club: most-played
  2 GK / 6 DF / 6 MF / 4 FW (XI-viable by construction).
- **Two modes, one loader** (harness-pool.ts): default = real pool, the
  AUTHORITATIVE acceptance gate, still run locally before an engine/growth
  PR merges; `--fixture` = the committed pool, run by the CI harness job
  (`pnpm realism:ci` / `pnpm growth:ci`) as a REGRESSION TRIPWIRE — it
  catches behavior drift, not absolute realism. Everything is deterministic
  (keyed rng, fixed seeds), so fixture results are stable until engine or
  growth code changes.
- **Gate re-alignments while wiring** (the drift this PR exists to prevent):
  realism top-8 win share gate 0.60 → 0.55 (PR #10 accepted 0.575);
  market-value anchor 0.40 → 0.25 (external sanity anchor, flattened by
  in-band draws); growth baseline σ bound 1.4× → 1.5× (tripwire margin —
  real pool sits at 1.34×, fixture at 1.42× from fixed-roster age mix). The
  realism round-robin sample is now evenly spaced across the FULL quality
  range (the old stride never reached the bottom clubs; real-pool r
  strengthened 0.71 → 0.82, anchor 0.31 → 0.58).
- **Tripwire proven to trip**: re-introducing the pre-brake growth config
  (facility slope 0.15, intensity gain ×2.0) makes `growth:ci` exit 1 —
  gap trajectory 1.04 → 1.96 (+0.92 vs the +0.5 bound) and the σ backstop
  at 2.0×. Reverted after the demonstration; both modes 7/7 and 12/12 at
  the tuned config.

## 2026-07-15 — training focus + season-end growth (ONE system), balance-gated

- **Architecture**: all math is pure in @fm/engine/growth (league-growth.ts);
  the server (league-training.ts) only moves rows. Weekly training accrues
  into squad_players.training_progress inside the week-close tick (revealed_at
  = exactly-once marker); the live attribute NEVER mutates mid-season.
  Season end applies accumulated training + the age curve in one pass for
  CONTRACTED players only (frozen-pool players never age or grow), writing
  attribute_audit ('season_growth') BEFORE each attribute update — the audit
  PK is the per-player applied-marker, so a retried pass skips cleanly.
  Attributes are fractional (2 dp) from the first growth on; 1–20 stays the
  scale.
- **Season-end trigger**: revealing the LAST regular matchweek (count of
  revealed kind='regular' weeks == seasons.matchweek_count — byes don't
  count) transitions regular → season_end through the SQL state machine,
  atomic with the reveal, and applies growth in the same transaction.
- **Weekly accrual** = (0.12 budget ÷ focus-group size) × intensity ×
  facility × age × minutes. Focus presets: balanced / possession / attacking
  / defending / physical — the budget SPLITS across the group, so narrow
  focus trains fewer attributes faster and no preset out-earns another in
  total. Keepers always train gk* whatever the club focus (a 'goalkeeping'
  preset would be dead weight for ten outfielders). Minutes: 90' = full
  rate, benchwarmers floor at 0.3 — development ties to the rotation
  economy. Age: ×1.6 at ≤20 → ×1 at 24–27 → ×0.25 at 33+.
- **Intensity is a real trade-off, one dial, both sides in the same tick**:
  accrual ×0 (full rest) → ×1 (0.5 default) → ×1.3 flat out (DIMINISHING
  returns past the default), while fatigue recovery scales ×1.25 (rest) →
  ×1 → ×0.75 (grind). Neutral at the default so pre-existing recovery
  behavior is unchanged.
- **Age curve at season end**: decline starts at 30, 0.2 raw pts/season per
  year past it, capped at 1.0, weighted per attribute — physical ×1,
  technical ×0.4, gk ×0.3, mental ×0.1 (legs go first, the brain stays).
  Young net-grow, peak plateau, veterans net-decline (harness: +0.176 /
  +0.112 / −0.273 composite per season for U21 / 24–27 / 31+ starters).
- **THE COMPOUNDING GATE (growth-harness.ts, tag growth — local/reported,
  like the realism harness: the fbref→squad join needs the human-populated
  cache CSV, which is deliberately uncommitted, so CI can't run it)**:
  5 simulated seasons on the real 2,128-player pool in its real 96 squads,
  same math as production. First fit (budget 0.12, facility ×1.75, intensity
  ×2 linear) RAN AWAY: rich-vs-poor XI-mean gap 1.02 → 2.23. Three
  structural brakes fixed it: intensity capped at ×1.3 (overtraining),
  facility slope 0.15 → 0.10 (×1.5 at level 5 — retunes the PR #14
  placeholder, same contract), and **headroom scaling** on gains
  (((20−v)/9)^1.2, clamp [0.1, 1.2]) so elite attributes crawl — the brake
  that binds ever harder as a club pulls ahead.
- **Measured verdict — the league stays competitive**: baseline (level
  field) σ 0.28 → 0.37 over 5 seasons, mean stable at ~11.2 (no inflation).
  Maximal bimodal stress (strong half: facility 5 + intensity 1.0 for five
  straight seasons, free of the fatigue bill; weak half: nothing) buys the
  rich cohort +0.45 XI-mean over 5 seasons with LINEAR-DECELERATING
  increments (0.09 → 0.05 by season 10, gap asymptoting ~+0.8) — headroom
  drag catches the leaders. That is ~1–2 table places for a maxed 130k
  facility + permanent grind: meaningful, not trivializing, not compounding.
  Gate design note: under a bimodal split, league σ mechanically restates
  the gap, so the pass/fail is the gap bound (+0.5/5yr) plus increment
  NON-ACCELERATION (the actual runaway signature), with σ < 2× as backstop.
  Caveat: fixed rosters — no churn — so late seasons decline league-wide;
  the divergence read is an upper bound on the rich edge.
- API: GET/PUT /api/training (focus + intensity), same phase rule as
  facilities (open regular + transfer_window). Client screen deferred — the
  dial is API-set this PR.

## 2026-07-09 — mid-season transfer window (the second market + the bye)

- **Two markets only**: the season-start auction and this one fixed week.
  The window is NOT a second auction — inter-club offers + fixed-price pool
  signings (league-transfers.ts), open only while phase='transfer_window'.
- **Window boundaries ride week-close** (league-orchestrator): closing the
  last pre-transfer regular week transitions regular → transfer_window;
  closing the transfer bye week itself IS the deadline — pending offers
  expire and transfer_window → regular resumes the second half. Both flips
  happen inside the tick+reveal transaction (revealed_at stays the
  exactly-once marker) and go through the SQL season state machine. The
  entry flip is skipped if the transfer week already revealed (late-retry
  backstop). The bye tick was already right: recovery + healing run, a
  one-match ban is NOT consumed by a bye.
- **Transfer wage rule: the contract rides along unchanged** (wage AND
  duration; the fee is the only new money). Rationale: duration never
  changes the weekly wage in our model, so there is nothing to renegotiate
  (same argument as the auction forfeit rule); re-deriving from market value
  would silently rewrite a contract the seller signed; and the buyer
  absorbing the existing wage is exactly what makes the wage-cap check at
  accept time meaningful. Mechanically a move is two UPDATEs — contracts
  .club_id and squad_players.club_id (PK is (season, player), so fatigue/
  injury/suspension/minutes ride along) — plus the fee txn (kind
  transfer_fee, club_id=buyer debited, to_club_id=seller credited).
- **Contested pool players: FIRST-COME under the players row lock**, not
  sealed bids. With the price fixed at market value there is no dimension
  left to bid on — a sealed fee bid would reintroduce the auction this
  window explicitly is not. First-come resolves instantly (the loser's txn
  sees the new contract and 409s), keeps squads knowable mid-window, and
  needs no deadline-resolution job or encumbrance of budget across pending
  bids. Wage = wageFromMarketValue, duration = transferContractDuration (2,
  no duration picker in the window).
- **Budget is bidirectional now** (store.budgetRemaining): transfer_budget
  minus all debits (auction_win, pool_signing, transfer_fee,
  facility_investment) plus transfer_fee credits — a sale funds new
  signings AND facilities (the
  facilities endpoints switched to the same function; one budget, one rule).
- **Offers**: one pending offer per (buyer, player) — re-offering replaces
  the fee (partial unique index); resolved offers are immutable (SQL
  trigger + smoke.sql guard). Offer-time checks are advisory; accept
  re-validates everything under locks (offer row → contract row → both
  club_seasons rows in club-id order — the club_seasons row lock is the
  club's money lock, the same one facilities investment takes). A stale
  accept (player already moved) expires the offer and 409s — the expiry
  commits even though the accept fails. Accepting also expires every other
  pending offer on that player.
- **Familiarity-cold on ANY club change**: a transfer wipes the player's
  dyads at the selling club and creates none at the buyer, so accrual
  restarts from zero co-played minutes — same integration cost as an
  auction signing (pool signings are cold by construction).

## 2026-07-09 — facilities economy: training + medical (youth DEFERRED)

- **Youth academy is explicitly deferred** — no schema column, no hook; it
  arrives with a youth-intake design, not as a third level counter.
- **Cost curve** (league-config `facilityCostByLevel`): 5k/10k/20k/35k/60k
  for levels 1→5. Maxing one facility costs 130k, both 260k, against a 100k
  default budget shared with auction spending — investment is a real
  tradeoff, not a checkbox.
- **Investment phases**: open during `regular` AND `transfer_window`
  (facilities are a season-long management lever), closed during `auction`
  — transfer_budget IS the live bidding balance there, and mutating it
  mid-lot would race bid validation — and from `season_end` on. Budget
  headroom = transfer_budget − Σ(auction_win + facility_investment) txns;
  wage_payment rides the wage-cap system, not the transfer budget.
- **Medical curve** (real values; the placeholder-linear hooks now carry
  weight): at level 5 — 30% of match injuries shrugged off entirely
  (`medicalInjuryAvoidPerLevel` 0.06, deterministic per fixture-seed+player
  so retried bookkeeping agrees), injury duration ×0.70
  (`medicalInjuryReductionPerLevel` 0.06, floor 0.5), weekly fatigue
  recovery ×1.25 (`medicalRecoveryBonusPerLevel` 0.05). Neutral at level 0;
  injuries still happen at max medical by design.
- **Training hook contract** (growth is NOT implemented here): the
  training-focus + season-end-growth PR consumes
  `trainingGrowthMul(training_level)` (= 1 + 0.15·level, league-config) as
  the per-player growth multiplier, reading levels via
  `store.getTrainingLevels(seasonId, clubIds)`. Nothing else may interpret
  training_level until that PR lands.

## 2026-07-09 — variable club count: supported N = 2–10, odd N via byes

- **Schedule**: doubleRoundRobin (league-auction.ts) uses the circle method
  with a null pad for odd N — every club byes EXACTLY once per leg, no club
  twice in a round, every pairing twice with venues swapped, each club hosts
  N−1. Regular weeks: 2(N−1) even, 2N odd (`expectedRounds`). Verified pure
  for N ∈ 2..10 and end-to-end (setup → auction completion → schedule) for
  N ∈ 5..10 in league-season.test.ts; odd N is load-bearing, not tolerated.
- **Season setup** is now one N-agnostic entry point (league-setup.ts
  `setupSeason`): matchweek_count is exact from N at INSERT (the schema
  CHECK `0 < transfer_week < matchweek_count` holds from creation, not just
  after auction completion), transfer week defaults to halfway and clamps
  to (0, rounds). The transfer week is an extra numbered bye week —
  matchweek_count stays "regular weeks" per the schema comment.
- **Pool-supply guards fail at setup, never mid-auction**: completability
  floor `pool ≥ (N−1)·squadMax + squadMin` (max hoarding cannot strand the
  last club below squadMin) and per-position floor `supply ≥ N × 4-4-2
  demand` (GK 1 / DF 4 / MF 4 / FW 2 — bestXI's shape). The guard takes the
  same squadMin/squadMax the auction will run, so tuned test auctions and
  the real config validate consistently. At N=10 against the ~2,128-player
  seed both floors clear with room (175 total / 10 GKs needed).
- seed-demo now goes through setupSeason; the old hand-inserted
  (matchweek_count 10, transfer_week 5) placeholder is test-helper-only.

## 2026-07-09 — replay viewer v0 (web) + /replay endpoint

- One Canvas 2D component (web/src/replay/) — no Pixi/Phaser for 23 dots and
  a ball. Pure playback logic (interpolation, score clock, timeline
  filtering) lives in playback.ts and is vitest-covered; the canvas is dumb.
- **Pacing**: frames are 6 sim-seconds apart (450/half). "1x" plays
  SIM_PER_REAL=12 sim-seconds per wall second — a half in ~3¾ min, a match
  in ~7½ (0.5x–4x range). Literal real-time would be 45 unwatchable minutes;
  this is the "real-ish" compromise, one constant to retune.
- Interpolation lerps between surrounding frames; gaps > 30 s snap (missing
  chunks), players present in one frame only snap (HT subs). The 6-second
  HT boundary lerp reads as a quick reset glide — acceptable at v0.
- **Embargo**: /fixture/:id/replay reuses the SAME SQL predicate as
  /result — extracted to EMBARGO_VISIBLE in league-store so the rule exists
  once. Participant post-final, everyone post-reveal, 404 otherwise (the
  results convention; not 403 — no existence leak). Tested alongside the
  result-embargo tests.
- Dot sides come from tactics_submissions (fixtureSides) — end_state does
  not carry team membership. Payload ≈ 200 kB per match (450 frames × 2,
  101 kB JSONB each); replay_frames prune after 4 matchweeks already.
- Deliberately NOT built (post-season-1): sprites/camera/commentary/clip
  export, heatmap overlay.

## 2026-07-08 — score-state equalization balance point (the PR #9 residual)

- The chasing mechanism over-equalized: real dominance converted into
  draws (realism top-8 win share 0.45 at a 1.79:1 goal ratio; synthetic
  draws 0.30 on two seeds). Tempered with three shape changes, no channel
  removed: **gap taper** (each goal of deficit beyond the first adds only
  stateGapTaper=0.3 of urgency — a 2+ goal underdog narrows, not erases),
  **lead caution share** (leaders keep 0.6 of the see-it-out shift —
  dominant sides stay themselves instead of parking and inviting), and
  magnitude trims (stateMax 1.5→1.1, stateRiskTurnoverDiscount 0.45→0.32).
- **Measured balance point** — untempered → tempered:
  synthetic draw share 1/3 seeds (0.25/0.30/0.30) → **3/3 (0.253/0.260/
  0.252)**; realism top-8 vs bottom-8 win share 0.45 → **0.575** at a
  2.0:1 goal ratio; quality↔points r 0.74 → 0.71 (holds ≥0.70); home-win
  2/3 both sides of the change (v1 0.425 misses by 0.005); strength
  q15-vs-q9 0.98.
- **Tradeoff curve finding**: second_half_goal_share barely responds to
  equalization strength (0.477-0.508 → 0.463-0.505, Δ≈−0.01) — its band
  miss (0.52–0.56) PREDATES tempering and is structural: leaders park as
  effectively as chasers push, and the real-world drivers of late-goal
  excess (fresh-legs subs, desperation quality drop) aren't modeled.
  The balance point therefore optimizes draws + dominance and accepts
  2nd-half at ~0.47–0.51; moving it needs in-play subs or a late-game
  execution-fatigue channel — a design decision, not this dial.

## 2026-07-08 — pipeline: attribute-spread fix (the realism-harness finding)

- **Compression audit** (representative attrs, outfield pool): per-metric
  attempt shrinkage costs 0–3% of spread (self-adapting — kept as-is, it is
  the fluke suppressor); minutes shrinkage at M0=900 cost 24–42% (the
  dominant compressor); the squash clamp cost ~0%. Hidden third compressor:
  blended attribute z has σ ≈ 0.4–0.9 (metric averaging cancels scale), so
  elite passing topped out at 16 — the 1–20 range was never used.
- **Fix**: (1) unit-variance normalization of attribute z per cohort
  (MAPPING rule 2c) with gain capped at 1.8 so proxy-heavy attributes
  (jumping σ 0.39, strength 0.43, pace 0.52) don't inflate imputation noise
  into fake discrimination; (2) SHRINK_M0 900 → 450 — rule 2b now owns
  small-sample suppression, so the minutes prior only bites genuinely
  low-minute players (2700' keeps 86%).
- **Acceptance (realism harness)**: XI-mean spread 1.08 → 1.69 pts;
  quality↔points r 0.34 → **0.74**; market-value anchor 0.40 → 0.49; elite
  STs 1.00 vs 0.60 goals/match; GK check 0.73 vs 3.80 conceded. Top-20
  stability ≥14/20 overlap on every attribute (no fluke invasion); marquee
  absolutes land right (Ødegaard passing 20, Kimmich vision/longPassing 20,
  Mbappé finishing 19, Van Dijk heading 20, Salah offTheBall 18).
- **Remaining red**: top-8 vs bottom-8 win share 0.45 vs the 0.60 target,
  with goal ratio 1.79:1 (Poisson-equivalent ≈ 0.55 wins). The gap is the
  ENGINE's score-state draw equalization (synthetic draws also run 0.30) —
  an engine calibration question, not seed spread. Documented, not chased
  here (pipeline-only PR).

## 2026-07-08 — agent-engine mechanism pass + realism harness

- **Score-state behavior** (the design behind two resisted bands):
  scoreState = −goalDiff × (base + timeGain·matchFrac), clamped ±stateMax,
  computed from the FULL match score. Chasing discounts turnover fear,
  biases shots, penalizes holding, slides the block up (statePushShiftM)
  and pushes off-ball runs; leading does the reverse. Decision + geometry
  only — execution noise stays attribute-driven. second_half_goal_share
  entered band on first measure (0.542 quick).
- **Home advantage after score-state**: still evaluated on full runs; the
  2b decision-level home term stays UNIMPLEMENTED until the full-run
  read-out demands it (score-state compounds leads, which is the indirect
  channel).
- **Keepers read gk attributes** (engine half of the PR #7 MAPPING flag):
  pass-family skill uses gkDistribution for GK actors (execution noise,
  technical logit, decision estimates); aerial contests score keepers on
  (gkReflexes+gkPositioning)/2 command + a hands bonus. Without this,
  flat-3 seeded keepers passed like statues and lost every cross.
- **Offsides: diagnosed, then fixed as behavior.** Event-meta study: 109
  flags/match at MEDIAN 5.4 m beyond the line — turnover anchor-jumps
  collapse the line ~20 m and forwards lag the retreating clamp; the
  decision model passed to them anyway. Fix: passers skip receivers beyond
  line + passerLineJudgementM (they wait); attackers hover
  lineHoldBufferM INSIDE the line; linesman tolerance 0.5 m. Volume 66 →
  ~13 per team with 0.5–1.5 m margins; lineHeight→offsides sweep intact.
- **press→fatigue/ppda investigation** (question answered, not tuned):
  fatigue DOES read commitment; the press's geometric footprint was too
  small. Chase range now scales with pressTrigger and the counterPress
  window adds a body + wider net (gegenpressing). ppda entered band
  (10.6) for the first time. The fatigue sweep stays red with a measured
  structural ceiling: 3-4 pressers × ~40% of ticks bounds the TEAM-MEAN
  delta at ~0.013 vs the 0.02 band; pressers individually show 3-4× that.
  press→ppda sweep also stays red: pressed teams attempt MORE short
  passes per possession-second, inflating the numerator as fast as
  defActions grow.
- **risk→passAcc investigation**: the risky ground pool was 2 through
  balls; added "ambitious" candidates (most-advanced onside mates in
  ground range). Completion still barely moves — risk expresses through
  option mix and xg/shot, not ground accuracy. Documented as a metric-
  structure limit (accuracy is ground-only by the longPassing split).
- **possession σ regression (13 vs 6–9), traded for offside realism**:
  pre-fix, forward-ball wastage capped dominant teams' possession runs.
  Four levers failed to compress it (raceSteepness, stateHoldBias,
  judgement band, control/skill slopes). Hypothesis: quality compounds
  multiplicatively across completion × races × control; restoring σ needs
  a stylistic possession-preference dimension in squad generation or a
  defensive-density completion penalty — design, not knobs.
- **Realism harness** (engine/realism-harness.ts, tag realism): rebuilds
  all 96 Big-5 XIs from the seeded pool (fbref_id→Squad join) and asserts
  coarse ordering. Football-shaped: elite-finishing STs outscore filler
  (0.97 vs 0.74 goals/match), keeper quality moves goals conceded, no
  single-attribute dominance. BUT outcome ordering is weak (top-8 beats
  bottom-8 0.40; quality↔points r=0.34; market-value anchor r=0.40):
  XI-mean quality spans only 1.1 attribute points across the entire Big 5
  (Liverpool 11.13 … Alavés 10.05) — the pipeline's triple shrinkage
  compresses squad-level differences ~3-4× below what outcome separation
  needs. PIPELINE DESIGN QUESTION: widen SQUASH_SCALE / relax shrinkage,
  or accept flat leagues.

## 2026-07-08 — agent-engine calibration: final full-run state

Full ENGINE=agent harness (600 matches × 3 seeds): **66 pass / 16 fail,
plumbing 0 fails on every seed.** Green on all three seeds: goals, 0-0
share, shots, SoT, xG/shot, possession spread, pass completion, PPDA,
fouls, yellows, reds, set-piece share, headed share, injuries, aerial
duels, lineHeight→offsides, crossBias→aerials, and both sent-off
emergents. Aggregate gate 82/0 unchanged.

Still red — all pre-documented below, stopping per the budget rule:
scoreline shares (draws 0.20–0.22, home/away split lacks the home edge),
second-half goal share, and the press→ppda/fatigue + risk→passAcc/xg
sweeps (risk→xg/shot is marginal: it passed on several quick batches and
misses the full threshold by 0.003). These need the design decisions
described under "Resisted bands", not more knob passes.

## 2026-07-04 — agent-engine calibration (AGENT_CAL + behavior refinements)

Non-obvious knob/mechanism choices (quick-batch n=60/seed; the full 600/seed
run is the gate):

- **softmaxBaseTemperature 0.55** — at 1.0 choices were near-uniform: shot
  spam, random risk. Sharpness is the single biggest sanity lever.
- **shotBaseScore −0.65** — volume gate. Cutting shotValueWeight instead
  flattened the xG gradient (xg/shot went UP as range shrank); a negative
  base suppresses marginal shots while the xg term keeps good ones.
- **loftedSkillExtraLogit** — the drop-point receiver race forgives scatter
  (someone runs onto anything), so longPassing barely moved lofted
  completion; the extra technical term restores the attribute signal the
  plumbing sweep asserts.
- **Two-man pressure** (pressureSecondWeight) — nearest-opponent-only
  pressure couldn't feel presser COUNT, so pressTrigger had no ppda channel.
- **Urgency speed** (cruiseSpeedShare/urgencyDistM) — everyone sprinting
  everywhere buried the press→fatigue differential; jog-vs-chase splits it.
- **Interception vs technical miss** — every failed pass used to hand the
  ball to the nearest opponent and count a defensive action; ppda sat at ~2.
  Only lost races are interceptions now; technical misses are loose balls.
  PPDA's numerator counts all pass attempts (lofted included), per the
  metric's definition.
- **bookedCautionFactor / boxFoulFactor** — reds were dominated by second
  yellows (fouls concentrate on the nearest tackler) and pens by box
  dribbles; carefulness when booked / in the box is real behavior, not a
  fudge.
- **Resisted bands (documented per the stop rule, not ground out):**
  - *second_half_goal_share* (sits ~0.44–0.51 vs 0.52–0.56): pure fatigue
    asymmetry is too weak — it slows attackers and defenders symmetrically.
    Hypothesis: the missing mechanisms are score-state risk-taking (trailing
    teams push) and fresh-legs substitutions, both absent by design (the
    engine has no score-state instruction modulation and subs are HT-only).
    Needs a design decision, not a knob.
  - *home/away win shares*: the one home mechanism (homePressureRelief)
    saturates near +0.05 win-share edge on identical-club A/B tests; the
    band needs ~+0.14. A stronger home term (temperature or attribute
    effectiveness) grazes the "execution noise is attribute-driven only"
    invariant — user call. Venue asymmetry bugs were ruled out with
    identical-club and strength-swap diagnostics (engine is symmetric;
    relief off ⇒ 0.388/0.362 home/away at n=80).
  - *risk↑ → passAcc↓ sweep*: risk reshuffles the option MIX (more lofted,
    through balls) but ground-pass completion barely drops because the
    generator only offers nearest-mate + two through candidates — the risky
    ground pass pool is too small. Hypothesis: generation needs
    distance-diverse ground candidates before this sweep can emerge.
    (Also: riskTurnoverDiscount 1.0 made risk SELF-DEFEATING — cost hit zero
    and risky teams spammed junk that inverted the xg/shot sweep; 0.8 keeps
    both directions sane.)
  - *press↑ → fatigue↑ sweep* (Δ≈0.015 vs required 0.02 after urgency-speed
    and presser-count scaling — 6 attempts): presser run volume is bounded
    by the pressMaxDistM catchment and by how fast possession turns over, so
    chase episodes stay short. The clean wiring fix (scaling fatigue accrual
    by pressingIntensity) is exactly the plumbing the emergent tag forbids.
    Hypothesis: needs longer chase episodes (ball retention already close to
    band) or a chase-specific movement mode; revisit after replay review.

## 2026-07-04 — agent-engine behavior (parts b–d: decision, execution, events)

- **Option scoring** (agent-decision.ts): every ball-moving option scores
  `P(complete)·V(target) − turnoverCost·(1−P)·V_opp(target)`. V = xT-style
  `positionValue` (power curve toward goal, touchline-damped) + pitch-control
  share; P = logistic over distance, lane exposure (nearest opponent
  projected onto the lane), control at target, and the relevant technical
  attribute. Shots score from the shared `xgProxy`. `positionValue`/`xgProxy`
  live in agent-model so decision and resolution can never disagree.
- **Success resolution** (agent-execution.ts): pass family = technical
  logistic × interception race (defender arrival times, anticipation-shaved,
  vs ball travel along the real noised path; lofted balls race only at the
  drop point and fall through to the aerial duel). Shots: on-target logistic
  then an xG-conditioned keeper beat (gkReflexes/gkPositioning). Execution
  reads context (control closure, opponents, receiver, GK) — the ExecContext
  keeps the no-sideways-imports rule.
- **passAccuracy counts GROUND passes only** (engine tallies): the
  passing/longPassing split means lofted completion moves with longPassing —
  folding it into passAccuracy made the "ground accuracy unmoved" plumbing
  row unpassable. Long-ball metrics read the typed lofted/high pass events.
- **Event models live in the engine loop**, not sub-models: foul + card
  ladder off failed-carry challenges and aerial losers (aggression-scaled;
  second yellow sends off mid-half — clock stops, player leaves every
  lookup via active()); injuries as one aggregate per-tick hazard draw
  (keyed rng stays insertion-safe); offsides from the second-last defender
  at the moment of the kick; corners/attacking-third free kicks resolved as
  parameterized deliveries through the aerial-duel model (headed goal prob
  IS the header-discounted xgProxy); penalties as a flat outcome table.
  HT subs consumption: XI players without a half-1 record increment
  subsUsed; subbed-out players' records carry through endState untouched.
- **Home advantage is ONE mechanism**: the home carrier feels
  `homePressureRelief` less pressure (context, not execution noise, not an
  instruction) — it propagates to decision temperature and execution
  logistics through the same pressure input everything else uses.
- Real stats: sot from on-target outcomes, xg from the shared proxy
  (+0.76/penalty), ppda = opponent build-up passes per own defensive action
  (tackles/interceptions/fouls inside `ppdaZoneOwnRelXM`), fieldTilt from
  attacking-third ball ticks.

## 2026-07-04 — agent-engine architecture (SCAFFOLD — no behavior yet)

- `AgentEngine` (engine/agent-engine.ts) implements the same frozen
  `SimEngine` interface as `AggregateEngine` — same signature, same
  HalfResult, same frame cadence (one frame per 6 s), same v2 resume
  semantics (throws on non-v2, sent-off players frozen). Swappable today;
  `ENGINE=agent` points the harness at it.
- **Three-model split**, each a separate module with a constructor-injected
  interface (clean seams for Wednesday's calibration):
  1. `PositioningModel` (agent-positioning.ts) — per-phase anchors deformed
     by attractors/repulsors; owns the Spearman-style pitch-control field
     (coarse grid) both teams' decisions read;
  2. `DecisionModel` (agent-decision.ts) — geometric option generation,
     attribute-weighted scoring, softmax choice with temperature from
     decisions/composure. Instructions bias SCORING ONLY (frozen invariant);
  3. `ExecutionModel` (agent-execution.ts) — attribute-scaled directional/
     velocity noise after the decision; the ball-flight enum routes lofted/
     high arrivals through aerial-duel resolution (jumping/heading/height).
  Sub-models never import each other; shared world-state types + AGENT_CAL
  live below them in agent-model.ts. Dependency-cruiser's engine isolation
  covers the package; the intra-module direction is enforced by review.
- **Keyed randomness from birth** (agent-rng.ts): every draw is addressed by
  (namespace, tick, playerId, purpose) instead of stream order. Rationale:
  the aggregate engine's sequential stream made all outcomes sensitive to
  draw order — adding one attribute (longPassing) reshuffled every harness
  stream and forced a recalibration. Keyed draws make inserting a consumer
  a no-op for existing ones. Corollary: HalfTimeState.rngState carries the
  NAMESPACE token, not a serialized stream — half 2 derives a child
  namespace.
- Tick loop (0.5 s): perceive → position → decide (carrier, every 2nd tick)
  → execute → resolve ball → phase transitions. `PhaseTracker` drives the
  six phases from possession turnovers (counterPress/counterAttack windows)
  plus ball x (buildUp/progression/finalThird vs defensiveBlock).
- **Stubbed vs real** — real: tick loop, phase machine, keyed rng, movement,
  emission contracts (frames/events/stats/heatmaps/endState), sent-off and
  resume handling, execution-noise plumbing, softmax choice, and
  **pitch control** (2026-07-04: Spearman-style arrival-time race on the
  AGENT_CAL grid — reaction window carried at current velocity, then an
  accelerate-to-vmax run scaled by pace/acceleration/fatigue; home share is
  a logistic on the best-arrival differential; the grid buffer is allocated
  once per model and refilled in place, and the returned field aliases it
  until the next tick. Full match ≈ 1.5 s. Harness plumbing rows verify
  sum-to-1 via side-swap mirroring, pace pull, numerical-advantage majority,
  and byte-identical determinism), and **positioning deformation**
  (2026-07-04: anchors shaped by lineHeight/width team instructions, a
  pressers set chasing the ball, marking pickups within radius, compactness
  squeeze toward the block centroid, offTheBall forward runs in possession,
  teammate space repulsion — all weighted attractor pulls from AGENT_CAL;
  fatigue now accrues proportional to distance actually run via
  fatigueWorkShare, so press intensity costs legs). The remaining stubs —
  option scoring, success resolution, xG, event models, real stats — were
  replaced the same day; see the "agent-engine behavior" entry above.
  Bands await calibration.
- Every tunable is in `AGENT_CAL` (agent-model.ts) with placeholder values —
  same one-object discipline as the aggregate engine's CAL.

## 2026-07-03 — data pipeline (pipeline/, Python, standalone)

- Not a pnpm package: runs locally, outputs `seeds/players.sql` + review
  reports. `MAPPING.md` is the derivation contract (attribute → metrics →
  transform) and `config.py` the single tuning surface. Deterministic from
  `cache/`.
- **CSV-first (2026-07-03 revision)**: fbref's provider change gutted the
  passing/defense/possession tables AT THE SOURCE — current and historical
  pages render empty, so HTML cache repair is impossible. The primary source
  is now a human-downloaded 2024-25 Big-5 season dump (worldfootballR_data /
  Kaggle) in `cache/csv/`; the HTML parser is demoted to a fallback for stat
  types the dump lacks. One coherent vintage (all 2024-25); per-player source
  provenance is recorded in `source_meta.sources` only when CSV and HTML
  types actually mix in a run. The dump restores aerials and npxG, which the
  gutted pages never had — heading/strength/jumping and finishing use them
  when present. The join's club tiebreaker is now preference-only
  (uniqueness within birth year suffices) because TM clubs are a season
  newer than the 2024-25 fbref clubs.
- **The pipeline has NO fetch code — populating `cache/` is a human step.**
  Rationale, learned the hard way: fbref's CDN blocks automated clients
  outright, and the archive.org record proved unreliable after fbref's
  late-2025 data-provider change RETROACTIVELY emptied advanced columns
  (possession, defense, passing splits) on many snapshots — several
  league×page combinations have no populated capture at all. A person saves
  the 40 per-league pages (5 leagues × 8 tables) from a browser into
  `cache/fbref_{League}_{page}.html` plus the transfermarkt dump as
  `cache/tm_players.csv`; mixed provenance is fine (the parser handles
  fbref tables inside HTML comments and in the live DOM). `run.py` preflights
  the cache and reports gaps; missing/empty tables degrade to position-group
  imputation with per-player low-confidence flags rather than blocking.
- **transfermarkt-datasets** open dump (HF mirror) for DOB/height/foot/market
  value. It has **no injuries table** (checked) → `injuryProneness` uses the
  age + minutes-load prior from data-sources.md, flagged low-confidence.
- **Join**: fbref aggregate rows carry birth YEAR only (full DOB would need
  the per-player crawl we ruled out) → key is unidecoded name + birth year,
  club tiebreaker via `clubs_match` (TM uses long legal club names), then
  token-sort / token-subset / surname+club passes, then difflib fuzzy ≥ 0.87,
  then `manual-matches.csv`. **Auto-match 98.2%** (target ≥95%); the TM pool
  deliberately includes recently-active non-Big-5 players because the fbref
  season contains since-departed ones.
- **Normalization deviation from the PR spec, on purpose**: attribute
  z-scores are LEAGUE-WIDE, not within position group — the engine reads
  attributes absolutely, and within-group z handed defenders striker-grade
  finishing (caught by the distribution report's top-20 eyeball). Positional
  identity comes from the shrinkage target instead: low-minutes players
  shrink toward their position-group mean (`w = m/(m+900)`, hard floor 270').
  GK-only attributes stay within-GK-cohort; outfielders get flat 3s.
- Missing xG/aerials in the pinned snapshots → finishing uses conversion
  rates, heading/jumping lean on TM height; all proxy-based attributes are
  listed per player in `source_meta.low_confidence`.
- CI runs `pytest pipeline/tests` only (fixtures, no network).

## 2026-07-03 — monorepo (pnpm workspaces) + CI as the merge gate

- Three packages: `@fm/engine` (engine/), `@fm/server` (server/), `@fm/web`
  (web/). The pure league domain modules (eligibility, league-config, season
  state machine) live in **@fm/engine**: the workspace has exactly three
  packages and web must import them without dragging server's runtime deps.
  @fm/engine has ZERO runtime dependencies and packs standalone (`pnpm pack`).
- **Source-first packages**: exports maps point straight at `.ts` files — no
  build step. Node's type stripping applies because pnpm symlinks resolve to
  real paths outside node_modules; TS (nodenext) and Vite resolve the same
  exports. The `@shared` vite alias is gone; web imports `@fm/engine/*`.
- **Import-boundary enforcement — two layers** (picked dependency-cruiser over
  an eslint rule: no eslint in this repo, and depcruise also catches cycles):
  1. pnpm's isolated node_modules makes UNDECLARED package imports fail to
     resolve at all (engine cannot see pg/fastify/@fm/server);
  2. `pnpm boundaries` (dependency-cruiser, `.dependency-cruiser.cjs`) forbids
     relative-path escapes: engine → server|web|node_modules, web → server,
     plus any import cycle. Runs in `pnpm test` and the CI typecheck job.
- **CI is the gate**: `.github/workflows/ci.yml` — six parallel jobs
  (typecheck+boundaries, engine unit, server suites on a postgres:16 service,
  web tests+build, 3-seed harness failing on any band miss, smoke.sql guards).
  Rule: **no commit lands on main without a green workflow** — work on
  branches, merge via PR. `pnpm test` at the root runs the same set locally
  (sequentially; DB suites share the docker Postgres from `pnpm db:test:up`).

## 2026-07-03 — attribute split: longPassing out of passing (pre-pipeline)

- `Attributes.longPassing` added to the technical block. Semantics:
  **passing** = execution noise on ground/driven flights; **longPassing** =
  lofted/high NON-CROSS deliveries (switches, over-the-top balls);
  **crossing** keeps wide deliveries into the box.
- AggregateEngine: long-ball attempts and completion read a `longPass` team
  rating (longPassing 0.85 + vision 0.15) and are emitted as coarse `pass`
  events with lofted/high flight — observable by the harness independently of
  `stats.passAccuracy`, which stays on the ground game (`passing` via the
  control composite). Plumbing sweep enforces the split: squad longPassing
  up ⇒ long-ball completion up, ground pass accuracy unmoved.
- bestXI: longPassing joins the DF (0.10) and MF (0.05) composites — CB
  switches and deep-lying passers; the coarse position groups have no DM
  subtype, so it is folded into both rather than a DM-only weight.
- Engine and bestXI read `longPassing ?? passing` so pre-split attribute
  blobs degrade gracefully until the pipeline re-derives everyone.
- **Pipeline derivation note (the import PR inherits this)**: from FBref
  passing tables, short+medium completion% → `passing`; long completion%
  (and long attempt volume as a propensity prior) → `longPassing`; crosses
  stay on `crossing` from the shooting/misc tables. Do not blend long
  completion into `passing` anymore.

## 2026-07-03 — season-start auction + HT server enforcement

- **HT enforcement is server-side now** (league-eligibility.validateHtResubmission,
  pure, mirrored client-side later): the half-2 XI may differ from the half-1
  XI by at most LEAGUE_CFG.htSubsMax; a player substituted off by an earlier
  half-2 submission never re-enters; players sent off in half 1 (end_state
  cards) are ineligible. All three are 422s with typed issues.
- **Auction shape**: open ascending, one lot live league-wide. Nomination is a
  snake over reverse seed order; **seed v1 = club name ascending** (no
  rankings exist yet — swap in real seeding when standings history exists).
  Lots run LEAGUE_CFG.auctionLotSeconds with a soft close: any bid landing
  inside auctionSoftCloseSeconds extends the close to now + that window.
  Timers ride pg-boss; an extended lot's stale timer no-ops on a closes_at
  re-check. Bids serialize on the lot row lock; a losing race is a 409 with
  the current high bid. Nominations serialize on the seasons row lock.
- **Squad bounds**: squadMin 13 (an XI plus cover — matches the seeded-club
  size the sim suite runs on), squadMax 18 (bench depth without hoarding in
  an 8-club league; 8×18 = 144 keeps the pool from draining). The auction
  cannot complete until every club reaches squadMin; a club at squadMax
  cannot win another lot. **No pass mechanism in v1**: the auction runs until
  the last club reaches squadMin and auto-completes (no live lot). Completion
  generates the double round-robin, inserts the transfer week after
  seasons.transfer_week (clamped to the generated round count), updates the
  season row, transitions auction → regular through the SQL state machine,
  and arms week-close timers.
- **Wage-cap breach at close ⇒ forfeit + re-lot** (not forced-minimum-duration:
  duration does not change the weekly wage in our model, so it cannot cure a
  breach — forfeit is the only rule that keeps the cap hard). No contract, no
  payment; the player returns to the pool. Bid-time checks (budget, wage
  headroom, squadMax) make forfeits rare; the close-time check is the
  invariant of last resort.
- **Re-lotting without new schema**: auction_lots is UNIQUE(season, player),
  so an unsold/forfeited player is re-nominated by RE-OPENING the same row
  (fresh opens_at/closes_at); only bids with placed_at ≥ opens_at count, so a
  dead opening's bids never resurrect. Re-nominations do not advance the
  snake (the turn consumed a *new* nomination only).
- **Contract duration**: auction_bids has no duration slot and adding a column
  needs sign-off, so v1 signs at LEAGUE_CFG.auctionDefaultContractDuration (2)
  and the winner adjusts 1–4 via PUT /api/auction/contract-duration while the
  season is still in the auction phase. If bid-time duration matters later, a
  `duration` column on auction_bids is the one-line schema change.

### Manual smoke path (auction era)

`scripts/seed-demo.ts` now starts at the auction: two bare clubs
(`alice@demo.io` / `bob@demo.io`) and a pool of 2·squadMin+8 players. Two
browsers → /auction: Beta United nominates first (reverse seed), bid, watch
the soft close, alternate turns until both clubs hit squadMin — completion
flips the season to regular, generates the schedule, and Home shows matchweek
1 with the normal lineup → HT → result → reveal flow from the client-v0
smoke path below.

## 2026-07-02 — client v0: React + Vite PWA in web/, shared modules by import

- Stack: React + Vite in `web/` (own package, own node_modules). Shared types
  AND logic are imported straight from the repo root via the `@shared` alias
  (vite alias + tsconfig paths) — `engine-types.ts`, `league-config.ts`,
  `league-eligibility.ts`. No type duplication; the client-side eligibility
  mirror IS the server's validator (it's pure). The imported graph must never
  reach pg/fastify/pg-boss — enforced by review, noted in vite.config.ts.
- Serving: all API routes moved under `/api`; Vite dev-proxies `/api` to
  :8080; production Fastify serves `web/dist` with an index.html fallback for
  SPA routes (league-server.ts). `/auth/redeem` 302s to `/` so the magic link
  lands in the app with the cookie set.
- Two-anchor pitch input DEFERRED: v0 submits anchors from the shared 4-4-2
  slot template (`formationSlots()` in league-eligibility — the same map
  bestXI uses), assigned to starters by position group. The pitch canvas PR
  replaces this with real per-player anchor editing.
- Polling, not websockets: the home screen refetches /matchweek/current every
  30 s while the fixture is in a waiting state (scheduled / awaiting_ht /
  final-but-embargoed). At 8 managers, websockets are complexity with no
  payoff; revisit only if polling ever hurts.
- HT bench swaps are capped client-side at LEAGUE_CFG.htSubsMax; the server
  accepts any eligible XI (engine has no sub model yet) — server-side
  enforcement lands with the engine's sub support.
- PWA: installable (vite-plugin-pwa manifest + SW), NO push subscription —
  blocked on the iOS device test (data-sources.md open task).

### Manual smoke path (client v0)

1. `npm run db:test:up` (Docker) then
   `DATABASE_URL=postgres://postgres:fm@localhost:54329/fm_test node scripts/seed-demo.ts`
2. `SESSION_SECRET=dev DATABASE_URL=postgres://postgres:fm@localhost:54329/fm_test npm run serve`
   (serves the API and, after `npm --prefix web run build`, the client at
   `http://127.0.0.1:8080`; for hot reload use `npm --prefix web run dev` → `:5173`)
3. Two browsers (or one normal + one private window):
   `alice@demo.io` and `bob@demo.io` → "Send login link" → open the printed
   console link in the matching window.
4. Both: Home → Submit lineup → pick 11 (+bench), tweak sliders, submit.
   When the second lineup lands the sim fires within a few seconds.
5. Home flips to awaiting_ht (30 s poll or refresh) → Half-time decisions:
   check stats/events/ratings, make bench swaps (≤ htSubsMax), submit.
   When both HT submissions land, the second half sims → final.
6. Results stay embargoed: each manager can open their own result; standings
   show played 0. Close the week (deadline passes, or in psql:
   `UPDATE matchweeks SET deadline_at = now() - interval '1 minute';` then
   wait for week-close, or run it via the orchestrator) → revealed_at set →
   standings show the result and both managers see the full result page.

## 2026-07-02 — HTTP API: Fastify; magic-link sessions; embargo lives in SQL

- Framework: **Fastify** (over Hono). Deciding factors: `app.inject()` gives
  supertest-style integration tests against real Postgres without binding a
  port, @fastify/cookie handles the session cookie, and we're Node-native
  anyway — Hono's edge portability buys nothing here. Single process runs the
  API and the pg-boss worker (league-server.ts); split later if ever needed.
- Session design: magic link = HMAC-signed token `{managerId, exp, jti}`
  (15 min TTL, console-log delivery behind the LinkDelivery interface until
  the email PR). Redeeming derives the session id as `HMAC(secret, jti)` and
  INSERTs it — **single-use falls out of the sessions PK** (second redeem
  conflicts), no token table, and a leaked already-used link cannot be turned
  into the session id without the server secret. Cookie: httpOnly, sameSite
  lax, 30-day session expiry. No registration endpoint — managers are seeded.
  request-link is rate-limited per email in-process (fine while single-process).
- **Embargo is enforced in SQL, never JS post-filtering**: results visibility
  (`store.embargoedResult`) and standings (`store.standings`) join on
  `matchweeks.revealed_at` inside the query, so a forgotten filter cannot leak
  a row. Participants see their own fixture once `final`; everyone else waits
  for reveal. Opponent submission status is exposed as booleans from a query
  that never selects payloads (`store.submissionFlags`).
- Eligibility is validated in the API BEFORE the insert (422 + issues array);
  the previous notify-time insert-then-delete pattern is gone —
  notifyTacticsSubmitted only enqueues now. State-machine violations are 409.

## 2026-07-02 — suspension ordering: served vs issued derived from match events

- Week close stays in the mandated order force-complete → bookkeep → tick →
  reveal, so when the tick runs, `suspended_next` holds BOTH suspensions being
  served this week and ones bookkeeping just issued from this week's reds.
- Mechanism: no snapshot, no reorder. "Issued this week" is recomputed from
  the immutable red-card events in this matchweek's `half_results`
  (`league-store.redCardedPlayerIds`); the tick clears every flagged player
  NOT in that set. Snapshots die on retry (a crash between bookkeeping and
  tick would re-snapshot the already-updated flags); events cannot.
- The whole tick shares one transaction with `revealMatchweek` under the
  matchweek row lock, so one-way `revealed_at` doubles as the tick's
  exactly-once marker — no double fatigue recovery or double decrement on a
  retried week-close.
- Transfer weeks (kind='transfer') tick recovery and injury healing but do NOT
  clear suspensions: a one-match ban is consumed by a played matchweek, not by
  a bye.

## 2026-07-02 — league-config namespace split from engine CAL

- League-layer tunables live in `league-config.ts` (`LEAGUE_CFG`): HT windows,
  familiarity increment, injury-week clamps, weekly fatigue recovery, medical
  facility multipliers, squad-size rules. Engine tunables stay in
  `engine-aggregate.ts` (`CAL`). They must not share a namespace: CAL is gated
  by the stat harness (match realism), LEAGUE_CFG by the integration suite
  (league bookkeeping) — a knob's home tells you which gate must stay green
  when you touch it.
- Medical facility hooks are wired (recovery ×(1 + bonus·level), injury draw
  ×(1 − reduction·level)) with placeholder-linear values, neutral at level 0;
  the facility economy PR owns real numbers.

## 2026-07-02 — eligibility: reject fresh, never block the sim path

- `league-eligibility.ts` validates lineups (11 starters, bench ≤ 9, no dupes,
  contracted, not injured/suspended, GK present). notifyTacticsSubmitted
  REJECTS invalid fresh submissions (typed TacticsRejectedError, row removed —
  as if never submitted). The sim path never rejects: missing or stale
  defaults fall back to `bestXI()` — deterministic, seeded by the fixture
  seed, availability-tiered (fit → injured by fewest weeks → suspended last)
  so a wrecked squad still fields 11. The used auto-lineup is persisted back
  to tactics_submissions (is_default = true) for audit.

## 2026-07-02 — HalfTimeState v2: structured cards + version field

- `playerState.cards` is `{ yellows: 0 | 1; sentOff: boolean }` (was `0 | 1`,
  which could not represent send-offs, so red cards silently vanished at HT).
- `HalfTimeState.v = 2`. Engines **throw** on any other version — no coercion,
  no migration path (no v1 blobs exist outside tests). Bump `v` on any future
  shape change to this blob.
- AggregateEngine: straight red or second yellow (including H1 yellow + H2
  yellow) → `sentOff`. Sent-off players are excluded from half 2 entirely — no
  minutes, no fatigue delta, hence no familiarity accrual (bookkeeping derives
  it from co-played minutes). The shorthanded team takes `CAL.sentOffPenalty`
  per missing player on attack AND defense ratios. Exact 10-men calibration is
  deferred to the agent engine.

## 2026-07-02 — Dixon-Coles low-score adjustment in AggregateEngine

- Generative DC-style dependence, `CAL.dixonColesTau`: the opener at 0-0 is
  damped ×(1−τ) and the 0-1 → 1-1 equalizer boosted ×(1+τ), evaluated on the
  cross-half match score. xG is left untouched — τ shapes realized scorelines,
  not chance quality.
- Why: independent shots×xG Bernoulli scorelines under-produce draws; the
  harness draw/home/away shares sat exactly on band boundaries. τ is tuned so
  all three sit inside bands on all 3 harness master seeds.

## 2026-07-02 — fixtures.bookkept_at is the bookkeeping idempotency marker

- The per-fixture bookkeeping transaction sets `bookkept_at` as its FIRST
  write and short-circuits when it is already non-null (read under the
  `FOR UPDATE` row lock). Replaces the previous wage-txn-memo marker, which
  depended on every club having a positive wage bill.
- Wage transactions keep `memo = 'fixture:<id>'` for traceability only.
- No smoke.sql guard: nullable column, no state transitions attached.

## Earlier decisions already recorded in code (context)

- SQL triggers are the state-machine source of truth; the TS mirror
  (season-state-machine.ts) is ergonomic only. Trigger exceptions are
  assertion failures — reported, never retried (league-orchestrator.ts).
- Replay frames pruned after 4 matchweeks; events/stats kept forever
  (schema.sql).
- Harness contract: JSON rows `{metric, seed, kind, sim_value, target_band,
  status}`; `kind` = `plumbing` (structural invariants) | `emergent`
  (distributions); 3 fixed master seeds, all bands must pass on every seed
  (stat-harness.ts, calibration-reference.md).
