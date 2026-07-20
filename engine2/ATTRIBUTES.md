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
| dribbling | touch length while carrying | touch push = carrier speed × (1.06 + 0.10·(v/vmax) + 0.25·(1 − dribbling/20)), capped by dribble-to-arrive (√(1² + 2·roll·distToOwnTarget)). Close control at a jog is glued (~1m ball gap); heavy feet at sprint push ~3m touches. Possession is physics: the coupling breaks past a 4m gap. |

Ball constants (ball.ts BALL): roll decel 1.7 m/s², restitution 0.55, bounce
ground friction 0.75, control/claim radius 0.9 m, kicker refractory 0.8 s.
Kicks are scenario-exact — execution noise arrives at L3 (with firstTouch
owning receive quality).

Attribute-free constants (candidates to ride stats later if the eye demands):
facing rotation 7 rad/s, step-turn threshold 2.6 m/s and pivot rate 5.0 rad/s,
arrival tolerance 0.35 m, turn time budget 0.55 s.

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
- L3 technique: firstTouch, passing/crossing/finishing noise, tackling,
  strength (shielding/duels), jumping+heading (aerials)
- L4 decisions: vision, decisions, composure, anticipation
- L5 off-ball: offTheBall, positioning (as above), marking, workRate
- L7 keepers: the gk* block

Invariant carried from v1: instructions and situation bias CHOICES;
attributes govern EXECUTION quality. At L1 there are no choices — attributes
are pure physics.
