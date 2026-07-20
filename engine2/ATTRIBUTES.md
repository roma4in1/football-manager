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
| dribbling | touch length while carrying + carry speed | touch push = carrier speed × (1.04 + 0.18·(v/vmax) + 0.22·(1 − dribbling/20)) — SPEED is the dominant trend (L2 judgment) — capped by dribble-to-arrive on stop-legs; carry speed = regime cap × (0.84 + 0.04·dribbling/20), so carrying is ~12–16% slower than running free. Touches alternate feet (±0.12 rad) and are AIMED AT THE ROUTE. Mid-touch balls are pinchable via the touch arrival race (stealer in reach, nearer than the carrier, AND with a clear line — the carrier's body shields within 0.5m). Claims are swept-path (no tunneling) and trap the ball at the man. |

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
| firstTouch | trap quality | pop probability = (0.02 + 0.055·(ballSpeed−4) + 0.25·height + 0.22·pressured) × (1 − 0.75·firstTouch/20). A silk touch kills a driven ball; heavy feet under pressure spill (~2–4.5 m/s squirt, fumbler claim-locked 0.8s). |
| passing | kick fidelity | direction σ = 0.13·(0.15 + 0.85·slack) rad, power σ = 0.12·(0.2 + 0.8·slack); elite ≈ 1m lateral at 40m, poor ≈ 4m. Kicks are reach-gated (≤1.1m). |
| tackling + strength | winning glued-ball contests | winP = clamp(0.42 + 0.055·edge), edge = (tackling+0.5·strength) − (dribbling+0.5·balance); ÷(1 + 0.2·carrierSpeed) — lunging at a sprinter is much harder. Win knocks the ball loose; loser claim-locked. Lunges cooldown 1.2s. |
| strength + balance | shield width | shield radius 0.3 + 0.25·composite/40 (0.3–0.55m): the carrier's body blocks the stealer→ball line. Far-foot dribbling: touches bias away from a marker inside 2.4m. |

Bodies are SOLID (radius 0.35m): soft pairwise separation at ≤2.5 m/s with
inelastic closing-velocity resolution. Carriers ride their dying touch
(speed caps to the dribble-to-arrive profile) — a probe showed sprinters
overrunning their own slowing ball into a trailing defender's lap.

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
