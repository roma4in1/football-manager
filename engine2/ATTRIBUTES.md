# Engine V2 — attribute → behavior map

The standing reference for which attributes drive which movements/actions in
`@fm/engine2`, maintained per layer (update this when a layer starts consuming
a new attribute). All attributes are 0–20 on the v1 pool scale; formulas live
in `kinematics.ts`.

## L1 — movement kinematics (current)

| attribute | channel | formula / effect |
| --- | --- | --- |
| pace | top speed only | vmax = 5.0 + 0.26·pace (p1 5.3, p10 7.6, p20 10.2 m/s); regime caps jog/run/sprint = 50/78/100% of vmax (walk absolute ~1.6). Indirect: accel fades toward *your own* ceiling (×(1−v/vmax)), so a higher ceiling keeps more push at any speed. **Deliberately absent from turning** (Bar-1 judgment note, pinned by test). |
| acceleration | speed change, both directions | peak 3.2 + 0.24·a m/s² (force–velocity fade); braking 1.3× peak. Owns the first 5–15 m burst, shed-into/relaunch-out of corners, decelerate-to-arrive. |
| agility + balance | one channel: lateral grip = 3.5 + 0.28·mean | turn rate ω = grip/v while running; gentle-carve radius v²/grip (grows with speed — momentum, not stats); **cornering speed** v_corner = grip·0.55/angle (stats-only — pace-independent by construction); low-speed pivot rate. `balance` is engine2-native — pipeline derivation pending (one session, together with the L5 mappings below). |
| stamina | reserved | regime structure (walk/jog/run/sprint effort state) exists for the later stamina model to bill against; no depletion yet. |

## L2 — ball + possession coupling (current)

| attribute | channel | formula / effect |
| --- | --- | --- |
| dribbling | touch length while carrying + carry speed | touch push = carrier speed × (1.04 + 0.18·(v/vmax) + 0.22·(1 − dribbling/20)) — SPEED is the dominant trend (L2 judgment) — capped by dribble-to-arrive on stop-legs; carry speed = regime cap × (0.84 + 0.04·dribbling/20), so carrying is ~12–16% slower than running free. Touches alternate feet (±0.12 rad) and are AIMED AT THE ROUTE. Mid-touch balls are pinchable via the touch arrival race (stealer in reach, nearer than the carrier, AND with a clear line — the carrier's body shields within 0.5m). Claims are swept-path (no tunneling) and trap the ball at the man. PRESSURE shortens the touch: a defender set ahead (inside 4.5m, front cone) caps the roll-out to (0.55 − 0.15·dribbling/20)·gap — better feet keep it closer under pressure; heavy feet still serve the head-on pinch. |

Ball constants (ball.ts BALL): roll decel 1.7 m/s², restitution 0.55, bounce
ground friction 0.75, control/claim radius 0.9 m, kicker refractory 0.8 s.
Kicks are scenario-exact — execution noise arrives at L3 (with firstTouch
owning receive quality).

Attribute-free constants (candidates to ride stats later if the eye demands):
facing rotation 7 rad/s, step-turn threshold 2.6 m/s and pivot rate 5.0 rad/s,
arrival tolerance 0.35 m, turn time budget 0.55 s.

## L3 — individual technique (current)

| attribute | channel | formula / effect |
| --- | --- | --- |
| firstTouch | trap quality | pop probability = (0.02 + 0.055·(closingSpeed−8) + 0.25·height + 0.025·receiverSpeed + 0.22·pressured) × (1 − 0.85·firstTouch/20); pressure adds 0.52·(1 − 0.65·firstTouch/20) — pressure vulnerability is itself a skill: a closing body barely troubles silk feet and ruins heavy ones. CLOSING speed = ball relative to receiver (in-stride cushions are easy, charges are hard); the receiver's own gait adds difficulty (walk +0.04, sprint +0.20). A MOVING receiver's successful touch is DIRECTIONAL — controlled to the boot AHEAD and redirected into his route; a RUNNER'S (>3.5 m/s) continuation touch is weighted like a carry touch (a proper stride ahead — cushion weight died at his feet and checked the run); a stepping receiver cushions at ~speed × 1.07; standing receivers kill it dead. Heavy feet under pressure spill (~2–4.5 m/s squirt, fumbler claim-locked 0.8s). |
| passing | kick fidelity | direction σ = 0.13·(0.15 + 0.85·slack) rad, power σ = 0.12·(0.2 + 0.8·slack); elite ≈ 1m lateral at 40m, poor ≈ 4m. Kicks are reach-gated (≤1.1m). |
| tackling + strength | winning glued-ball contests | winP = clamp(0.42 + 0.055·edge), edge = (tackling+0.5·strength) − (dribbling+0.5·balance); ÷(1 + 0.2·carrierSpeed) — lunging at a sprinter is much harder. Win knocks the ball loose; loser claim-locked. Lunges cooldown 1.2s. |
| strength + balance | shield width | shield radius 0.3 + 0.25·composite/40 (0.3–0.55m): the carrier's body blocks the stealer→ball line. Far-foot dribbling: touches bias away from a marker inside 2.4m. |

IN-STRIDE RECEIVES: a RUNNER (>3.5 m/s) whose continued run meets a
flighted pass (>4 m/s) takes it at full pace — no timed brake (checking the
run left through balls rolling on behind the receiver). Static and dying
balls are still braked into; crossing receives that need timing still get
the receive machine (self-selecting by geometry).

RECEIVE REACH: a ball is claimable within 0.9 m of the body and below knee
height (0.5 m), tested against the ball's swept path IN THE RECEIVER'S FRAME
(both motions subtracted — two fast movers crossing cannot tunnel through
each other's reach). Bodies are SOLID (radius 0.35m): soft pairwise
separation at ≤2.5 m/s with inelastic closing-velocity resolution. Carriers ride their dying touch
(speed caps to the dribble-to-arrive profile) — a probe showed sprinters
overrunning their own slowing ball into a trailing defender's lap.

## L4 — on-ball decisions (current)

The decision layer consumes attributes rather than adding movement effects:
the situation and INSTRUCTIONS bias the choice; attributes govern execution
(the §3 contract). Choices are pure EV over posValue/xG/lane models.

| input | affects | mechanism |
|---|---|---|
| passing (+ receiver's firstTouch) | execution + WEIGHT choice + the ELITE DECISION | every decided kick goes through L3's noisyKick. Pass weight is receiver-aware: the hot-arrival tax relaxes with the receiver's firstTouch (comfortable ≈ 5.5 + 0.35·ft m/s), so good feet get zipped balls and heavy feet get them soft. ELITE PASSING changes the DECISION, not just the noise: precision buys interception margin ((passing−14)·0.02 s — the De Bruyne term: he attempts the ball because HIS version completes), and the LINES-BROKEN bonus (bypassed defenders × 0.016 × risk × passing/20) values the ball that eliminates six men. Fast balls are harder to CUT (+0.01 s reaction per m/s over 8 — the second half of 'driven passes are harder to intercept'). BACKHEEL penalty (decided kicks only): strikes off facing multiply noise ×(1+1.6·(misalign/π)²) and lose power beyond 90° (×0.55 at 180°); the EV discounts completion to match. Scripted kicks stay facing-blind (the script IS the intent). |
| pace + acceleration (opponents') | lane risk | passCompletion runs an accel-honest intercept model (ramp sqrt(2d/a), then cruise) against every defender, projected along his velocity to ball-arrival time |
| pace (own) | carry urgency | heel pressure within 4m switches the carry regime to sprint |
| instructions.risk | choice distribution | scales the turnover penalty (passes AND carries near defenders), the completion floor a pass must clear, the payoff weight of progressive balls, AND the carry-pressure horizon (a cautious player's danger radius is wider — he releases before engaging the 1v1) — judged semantics: low plays the safe outlet early, high hits the through ball |
| instructions.objective | the value field | 'score' = posValue (goal-seeking); 'keep' = keepValue (space minus station-tether) — the rondo's truth |

## L5a — support & structure (opened)

Off-ball brains whose team has the ball move to OFFER AN ANGLE: the same
lane model the carrier uses, pointed the other way — spot utility =
lane-openness ×0.6 + value ×1.2 − crowding, tethered to a home that
deforms toward the ball (30% of the distance, capped 3 m keep / 8 m
score). Engages only for IDLE bodies past their last scripted cue (the
script is the run until L5b); defensive off-ball stays L5c/L5d.

## L5b — runs (opened)

An idle brain ahead of a teammate carrier, with ≥12 m of room behind the
last defender and within ~22 m of the line, RUNS a cycle: approach → RIDE
(reload at a jog, level just short of the line, at the SEAM — between
defenders or off the outside shoulder, never a marker's own channel) →
DART (sprint diagonally across a defender's blind side into the adjacent
seam — pace is built BEFORE the ball is played) → back to ride if no ball
comes. The carrier's release WAITS for the movement (passes to riding/
approaching runners taxed ×0.45; the dart lifts it) and gains the rider's
in-behind candidate + the delayed release. The receive reflex owns the
burst. Run priority beats support; scripts still beat both.

## L5c — defensive shape (opened)

The first DEFENDING layer: an idle brain whose OPPONENT has the ball (and
whose objective isn't 'keep') joins his LINE — shapeSpot computes, per
member but identically (no messages needed): the unit's shared depth
(hold the home line; DROP goal-side of the ball with a 12 m buffer, floor
10 m from goal), the ball-side slide (0.4 × ball offset, capped ±7 m),
the cover-shadow bend (sit in the carrier→deepest-threat lane at line
depth, 0.35 blend), and spacing (ordered, ≥5.5 m). The line SLIDES; it
does not chase — pressing is L5d's, jockeying L5e's.

## Decided for later layers

- **Positioning split (decided 2026-09-07, implemented at L5)**: the pool
  already encodes it under FM-convention names — `offTheBall` IS attacking
  positioning (derived from penalty-area touches + progressive passes
  received), `positioning` IS defensive positioning (interceptions + blocks +
  clearances). No pool rename (pipeline/DB/v1/UI churn for zero behavior).
  Engine2's L5 body-attribute layer maps them to self-describing names:
  `attackingPositioning ← offTheBall` (L5a support angles, L5b run timing),
  `defensivePositioning ← positioning` (L5c shape/line, L5e cover). A finer
  defensive split (reading-danger vs holding-shape) is derivable from the
  differing pipeline signals if L5 workbench evidence ever wants it.

## Expected consumers, by layer (build order)

- ~~L2 ball + possession: dribbling → touch distance at speed~~ (landed above)
- ~~L3 technique: firstTouch, passing noise, tackling, strength~~ (landed above; crossing/finishing arrive with their actions)
- L3 technique: firstTouch, passing/crossing/finishing noise, tackling,
  strength (shielding/duels), jumping+heading (aerials)
- L4 decisions: vision, decisions, composure, anticipation
- L5 off-ball: offTheBall, positioning (as above), marking, workRate
- L7 keepers: the gk* block

Invariant carried from v1: instructions and situation bias CHOICES;
attributes govern EXECUTION quality. At L1 there are no choices — attributes
are pure physics.
