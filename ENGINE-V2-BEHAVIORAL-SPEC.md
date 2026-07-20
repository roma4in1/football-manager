# Engine V2 — Behavioral Football Engine (Design Spec)

Status: design locked at draft-1. This is the foundation document for the
ground-up behavioral engine. Every build session reads this first (the Phase-0
rule), plus DECISIONS.md for accumulated findings. One layer per PR. The
builder's eye is the primary acceptance instrument; the v1 statistical harness
is the guardrail, not the target.

---

## 1. Mission & philosophy

Build a football engine where **realistic play emerges from footballer-like
behavior**, rather than being fitted to aggregate statistics. The founding
insight (Romain's, and it is correct): real-football statistics are the
*result* of real football, not its cause. V1 optimized toward the statistics;
V2 models the behavior and validates that the statistics emerge.

Consequences of this inversion:
- The primary development signal is **watching the sim** (does this read as
  football?), supported by repeatable scenario tests.
- The v1 statistical harness survives as a **guardrail**: once full matches
  run, emergent stats must land in real-football bands. Out-of-band stats
  indicate a behavior bug — they are diagnostic, never a fitting target.
- Mechanisms over knobs remains law. It was v1's best discipline and it is
  V2's native mode: everything is a mechanism.

## 2. Relationship to V1

- **New package** (`@fm/engine2`), clean core. V1 stays intact, calibrated,
  and playable — it is the statistical reference implementation and the
  fallback sim for the management game whenever wanted.
- **Ports (concepts, re-implemented for continuous time):**
  - EV-grounded decision values (#40): shots worth their xG; passes/carries
    worth `P·ΔPV − κ(1−P)·PV_opp`. The *philosophy* ports; the evaluation
    runs continuously against real space.
  - Ball-flight honesty (feat/agent-ball-flight): travel time, arrival races,
    receivers running onto balls. V2 generalizes this to full continuous
    physics.
  - The player pool + attribute pipeline (2,128 players, 0–20 attributes,
    MAPPING.md derivations). Same inputs, consumed behaviorally.
  - Keyed RNG determinism: every draw keyed `(tick, entityId, purpose)`.
    Non-negotiable; it is what makes behavior debuggable and replays exact.
  - Tactics concepts (phase anchors, zones, instruction biases) — re-expressed
    as behavioral parameters (§8).
- **Does NOT port:** the 6-second decision keyframe, interpolation-as-motion,
  statistical-target calibration, and any constant that exists only to hit a
  band.
- **In-flight v1 branches:** merge or park cleanly per their own gates. The
  EA-signature compactness iteration on v1 is **superseded** — chasing
  behavioral realism on the keyframe architecture is exactly what V2 replaces.

## 3. Core architecture

**Time.** Fixed simulation tick, target **10 Hz** (100 ms). Rationale: fine
enough for momentum, pressing, and arrival contests to be continuous; coarse
enough that a 90-minute match is 54,000 ticks and sims in seconds-to-minutes.
Tick rate is a constant, revisitable after Layer 1 profiling.

**Player state (kinematic body).** Position, velocity, facing, plus derived
stance (settled / moving / turning). Movement obeys limits derived from
attributes: top speed (pace), acceleration (acceleration), turning radius as
a function of speed (agility), deceleration. No instantaneous direction
changes. Stamina couples to sustained output (energy model, Layer 1-lite,
deepened later).

**Ball state.** Position (3D: x, y, height), velocity, and phase
(carried / rolling / airborne / dead). Rolling friction, bounce with
restitution, flight under gravity. Spin/curve is explicitly **deferred** —
it earns a layer only if scenario evidence shows its absence matters.

**Per-player loop (each tick): perceive → decide → act.**
- *Perceive:* local world model — ball, nearby players, space, passing lanes,
  own role/instructions. Perception can be imperfect later (awareness
  attribute); v2.0 uses true state.
- *Decide:* utility-based selection among currently-available actions
  (Layer 4/5). Decisions are re-evaluated continuously but commitment has
  inertia (you don't abandon a sprint every 100 ms; decisions carry a
  re-consideration cost).
- *Act:* execution with attribute-driven noise — the v1 invariant carried
  forward: **instructions and situation bias the choice; attributes govern
  the execution quality.**

**Authored behavior, not learned.** Behaviors are hand-authored utility
systems, steering behaviors, and role logic — deterministic, debuggable,
tunable, judgeable. **No RL/ML agents.** Rationale: reinforcement-learned
football is a research program with training infrastructure, reward-shaping
pathologies, and non-deterministic outputs; authored behavior is how a solo
builder ships believable football and how classic sports AI actually works.
Revisit only if authored Layer 5 provably plateaus.

**Determinism & replay.** Keyed RNG throughout. The sim emits frames at full
tick rate internally; replays store a decimated stream (target 4–5 Hz,
delta-compressed, budget ≈ a few MB/match) that the viewer interpolates. No
interpolation *inside* the sim — only in presentation.

## 4. Layer 0 — the Viewer/Workbench (built FIRST)

The failure mode of v1 development was judging behavior through a replay that
distorted it. V2 inverts this: the viewer is the first deliverable and the
primary instrument.

Requirements:
- Renders the continuous sim (live or from frames): pitch, players as
  oriented bodies (position + facing), ball with height cue, carrier
  highlight.
- **Debug overlays, toggleable:** velocity vectors, intended movement
  targets, current action label per player, passing-lane geometry, pressing
  assignments, the defensive line, zone/space ownership. These are how
  behavior is *seen* and debugged.
- Scrub, pause, slow-motion (0.25×), frame-step. Behavioral judging happens
  at slow speed.
- Scenario loader: start the viewer from any scenario file (§6), not only
  full matches.
- Clarity bar: the EA FC 26 2D tactical view is the *presentation* reference
  — clean pitch, legible markers, obvious possession. That view is
  achievable and is the standard for legibility (not for art).

## 5. The layer stack (build order = dependency order)

**L1 — Movement kinematics.** Bodies with momentum: accel/decel curves, speed-
dependent turning, arrival behavior (decelerate to arrive, don't overshoot),
walk/jog/run/sprint as distinct regimes with an effort model. *Acceptance:*
watch a player run a route in the workbench — starts, turns, arrivals read as
human. Scenario: shuttle runs, curved runs, chase-downs.

**L2 — Ball physics & possession coupling.** Rolling, bounce, flight;
carried-ball coupling (the ball sits at the carrier's feet, pushed ahead by
touches at speed — touch distance scales with dribbling/close-control and
speed); loose-ball contests as arrival races. *Acceptance:* a carried ball
looks dribbled; a struck ball rolls/flies/bounces believably; two players
racing to a loose ball resolves by physics.

**L3 — Individual technique.** First touch (control quality vs ball speed/
height/pressure — a bouncing or driven ball is harder), kick execution
(pass/shot power & accuracy with attribute noise), tackles/challenges as
physical contests, shielding. *Acceptance:* scenario tests — a poor first
touch under pressure pops loose; a great one kills a driven ball dead.

**L4 — On-ball decisions (continuous EV).** The carrier continuously
evaluates: carry directions, pass options (each weighted by lane geometry,
receiver context, ΔPV, interception risk from *actual* defender positions),
shoot (xG from real geometry), hold/shield, clear. Commitment inertia; the
striker-shoots-by-construction property must hold here natively.
*Acceptance:* rondo and 3v2 scenarios — choices look like footballers'
choices; no backward passes from clear chances; risk instruction visibly
shifts choice distribution.

**L5 — Off-ball behavior (THE core, largest layer — sub-phased).** This is
80% of what reads as "real football."
  - *L5a Support & structure:* teammates offer angles, maintain spacing,
    provide outlets; role-based home positions that deform with the ball.
  - *L5b Runs:* timed attacking runs — into channels, in-behind (onside-aware
    — port the v1 line-riding insight), overlaps/underlaps, near/far-post
    crosses runs. Run triggers from carrier context.
  - *L5c Defensive shape:* the line as a coordinated unit (step/drop/hold),
    compactness between lines, horizontal shift with the ball, cover shadows.
  - *L5d Pressing:* trigger conditions (back-pass, poor touch, sideline
    trap), coordinated press vs contain, press resistance interplay with L3.
  - *L5e Marking & duels:* assignments (zonal/man hybrids), tracking runners,
    recovery runs on transition — the transition-defense reformation v1
    lacked lives here natively.
*Acceptance per sub-phase:* scenario library (§6) + small-sided games. This
layer is the multi-year frontier; it ships incrementally and is judged
sub-phase by sub-phase.

**L6 — Team shape, phases & tactics.** Formations as dynamic shape targets;
phase transitions (build-up → progression → final third → defensive block →
counter-press/transition); the v1 tactics surface (anchors, zones, sliders,
instructions) re-expressed as parameters of L5 behaviors so the *management
game's tactical controls drive the behavioral sim*. *Acceptance:* changing
line height / width / pressing visibly and correctly changes how the team
plays in an 11v11.

**L7 — Goalkeepers.** Positioning (angle play, depth), shot-stopping as
reaction+dive physics, claims/punches on crosses, distribution, sweeping.
A specialized behavior domain; deliberately after outfield play works.

**L8 — Restarts & set pieces.** Throw-ins, goal kicks, corners (delivery +
box behavior riding on L5b/L5e), free kicks, penalties, kickoffs. Dead-ball
states are a large share of real match time; until L8, scenarios and
small-sided games use simplified restarts.

**L9 — Match officiation.** Fouls emerging from L3/L5e contests (not rolled
abstractly), advantage, cards, offside adjudicated against the continuous
line (v1's timing-trap insight, now geometric).

**L10 — Emergent validation & the full match.** 11v11, 90 minutes. The v1
statistical harness runs as guardrail: goals, shots, xG/shot, possession
distribution, ppda, fouls, offsides, aerials must land in real-football
bands *as emergent properties*. Deviations are behavior bugs to diagnose in
the workbench — never constants to fit. Plus new *behavioral* metrics that
v1 couldn't have: distance covered/sprints per player (real ranges exist),
line-height and compactness distributions, pass-network shapes.

## 6. Methodology — small-sided first, scenarios always

Do not develop against full 11v11. Behavior is built and judged at the
smallest scale that exhibits it:

1v0 (movement, technique) → 1v1 (duels, carry vs press) → rondo 4v2 (passing,
support, press) → 3v3 / 5v5 small-sided (all core behaviors, tiny pitch) →
7v7 (shape emerges) → 11v11 (full integration).

**Scenario library** (versioned files, loadable in the workbench): each
scenario = initial positions + roles + a situation ("overlap on the right",
"counter 3v2", "low block vs probing", "press trigger on back-pass",
"corner"). Scenarios serve three uses: (a) visual judging in the workbench,
(b) assertive tests where crisp expectations exist ("the onside runner is
found", "the line steps as a unit within N ticks"), (c) regression — a
behavior that once looked right must not silently rot. The scenario library
is V2's equivalent of v1's harness and grows continuously.

**Acceptance protocol per layer:** builder watches the named scenarios in
the workbench (slow-mo, overlays on) and judges against the layer's
acceptance line; scenario assertions green; prior layers' scenarios still
green. The builder's eye is the instrument the whole project exists to
satisfy — it is the gate at every layer, not only at the end.

## 7. Performance envelope

10 Hz × 90 min = 54,000 ticks; 22 bodies + ball per tick. Budget: full match
sims in **≤ 3 minutes** on the dev machine (M-series) and within async-worker
tolerance on shared-cpu-1x for the eventual product integration (matches sim
in background; nobody watches a spinner). Profile at L1/L2 before the stack
deepens; if 10 Hz can't hold the budget with headroom, drop to 8 or 5 Hz
*then*, not speculatively. Replay storage decimated to 4–5 Hz,
delta-compressed, ≈ few MB/match.

## 8. Product integration (later, unhurried)

V2 slots behind the existing SimEngine interface when — and only when — it
passes L10. The management game (auction, tactics, seasons, the lobby arc)
is engine-agnostic and continues to work on v1 meanwhile. The tactics UI's
controls map to L6 parameters, which is what finally makes "strategy beats
raw quality" *visible* on the pitch, not only in the numbers. No product
work blocks V2; no V2 milestone blocks the product.

## 9. Honest expectations — the graduated bar

"EA-quality" is a direction, not a finish line; EA's on-pitch behavior is a
thousand-person, decades-deep asset. V2 therefore defines **graduated bars**,
each independently valuable:

- **Bar 1 — Physical:** motion reads as bodies with momentum; no teleports,
  no yoyo, no gliding. (L1–L2)
- **Bar 2 — Technical:** individual actions read as football skills;
  touches, passes, duels look intentional. (L3–L4)
- **Bar 3 — Collective, small-sided:** a 5v5 in the workbench reads as real
  small-sided football to a knowledgeable watcher. (L5 partial)
- **Bar 4 — The match test:** a full 11v11 in the 2D view reads as a real
  football match to a fan watching for five minutes. (L5–L6, L7)
- **Bar 5 — The reference test:** side-by-side with EA FC 26's 2D tactical
  view, a watcher does not immediately prefer EA's motion. (Aspirational;
  the project is a success at Bar 4 even if Bar 5 is never certified.)
- **Guardrail throughout from Bar 3:** emergent statistics in real-football
  bands.

Progress is claimed bar-by-bar, in DECISIONS.md, with the scenario evidence.
No bar is skipped; no bar is declared by feel alone.

## 10. Discipline (carried from v1 — it is why v1 worked)

- One layer (or sub-phase) per PR; diagnose-then-build; stop-and-report on
  scope breach or gate tension — a proven tension is a finding.
- Every fresh session: read this spec + DECISIONS.md before proposing
  anything (Phase-0 rule). Do not relitigate: authored-not-RL, 10 Hz-class
  continuous time, small-sided-first, stats-as-guardrail, keyed RNG.
- The workbench is maintained like a product: if behavior can't be seen, it
  can't be judged; if it can't be judged, it doesn't merge.
- DECISIONS.md accrues every finding, refutation, and accepted residual, so
  stateless sessions inherit the arc.
