# Engine V2 — run taxonomy → engine mapping

Source: `reference/types_runs.md` (the builder's 34-run taxonomy). Status
per run: **live** (built), **emergent** (falls out of existing machinery —
verified or expected), **gated** (meaningless or unbuildable until the
named layer exists). The gating principle: runs that manipulate a
defender's attention (dummy, blindside, double movement…) are semantically
empty until defenders PERCEIVE and REACT (L5c shape / L5d pressing / L5e
marking); building them earlier would be animation, not football.

| # | Run | Status | Where / gate |
|---|---|---|---|
| 1 | In behind | **live** | runPlan trigger + ride/dart cycle (L5b) |
| 2 | Diagonal | **live** | the DART — sprint across a blind side into the adjacent seam |
| 3 | Curved | partial | line-riding is the flat version; the curved arc earns its place with a MOVING line (L5c) + offside timing (L9) |
| 4 | Blindside | gated | L5e marking — no defender tracks the runner yet |
| 5 | Near post | gated | L8 crosses + aerials |
| 6 | Far post | gated | L8 crosses + aerials |
| 7 | Central box attack | gated | L8 crosses |
| 8 | Delayed box run | gated | L8 crosses; the late-arrival TIMING pattern reuses the ride/dart cycle |
| 9 | Third man | **emergent** | C's runPlan triggers while B carries — same machinery, verified by the wall-pass drill family |
| 10 | Dummy | gated | L5c/L5e — pulling a defender needs a defender who follows |
| 11 | Decoy | gated | L5c/L5e — same |
| 12 | Channel | **live** | the seam model (between line defenders / outside shoulder) |
| 13 | Wide stretch | partial | L5a support holds width when the value says so; deliberate stretch-for-others is L6 (team shape) |
| 14 | Inside cut | partial | seam choice can pick the interior gap; the inverted-winger PATTERN (start wide, cut in with the ball) is an L4 carry + L6 role |
| 15 | Overlap | gated | needs a WINGER-carrier context + role structure (L6); mechanically = runPlan with an outside lane |
| 16 | Underlap | gated | same, interior lane |
| 17 | Support run | **live** | L5a supportSpot (5–15 m angles) |
| 18 | Escape run | **live** | L5a keepValue/space term moves supports off pressure |
| 19 | Check run | partial | receivers come to meet balls (receive machine); a deliberate check-to-feet CALL is L5b round-next |
| 20 | Spin run | gated | check + explode = manipulating a marker (L5e); the movement cycle exists (ride/dart) |
| 21 | False nine drop | gated | pulling a CB out needs a CB who follows (L5c/L5e) + role (L6) |
| 22 | Wall pass (one-two) | **emergent** | give → the giver's runPlan triggers → the wall man's EV returns it into the dart; verified in the wall-pass drill |
| 23 | Cross recovery | gated | L8 crosses |
| 24 | Back post drift | gated | L8 + L5e (drift = unmarked movement) |
| 25 | Rebound attack | gated | L7 keeper (rebounds barely exist without one) |
| 26 | Counter sprint | gated | L5d transition awareness (brains don't defend yet, so turnovers lack the trigger moment) |
| 27 | Box crash | gated | L8 crosses + multiple box roles (L6) |
| 28 | Isolation | gated | L6 (deliberate switch-and-wait is a team pattern) |
| 29 | Drift between lines | partial | L5a support drifts by value; the LINES to drift between arrive with L5c |
| 30 | Shadow run | gated | L5e — hiding needs a watcher |
| 31 | Peel-off | gated | L8 + L5e |
| 32 | Double movement | gated | L5e — the hardest run to defend needs a defender |
| 33 | Lateral box run | partial | the DART is the open-play version; box context is L8 |
| 34 | Screen run | gated | L5e/L9 (blocking is a foul-adjacent contact behavior) |

The build order this implies for L5b's remaining rounds: check-run calls
(19) and richer seam/dart variety now; everything cross-related waits for
L8; everything manipulation-related waits for reacting defenders.

## Midfielder support runs (`reference/midfield_runs.md`)

| # | Run | Status | Where / gate |
|---|---|---|---|
| 1 | Simple support | **live** | L5a supportSpot (lane-openness × value) |
| 2 | Forward support | **live** | supportSpot under 'score' (posValue pulls forward) |
| 3 | Backward support | **live** | supportSpot ring includes drop candidates; the EV picks them when lanes ahead are shut |
| 4 | Lateral support | **live** | same candidate space |
| 5 | Triangle support | emergent | two supports + a carrier form it from spacing + lane terms — verify by eye in small-sided |
| 6 | Diamond support | emergent/L6 | four-man structure holds when roles (L6) anchor the shape |
| 7 | Half-space occupation | partial | posValue's central bias approximates it; explicit half-space channels are L6 role geometry |
| 8 | Pocket run | gated | L5c — the pocket is BETWEEN LINES, and lines don't exist yet |
| 9 | Late box arrival | gated | L8 crosses; the timing pattern reuses ride/dart |
| 10 | Deep build-up drop | gated | L6 (role rotation, back-three formation) |
| 11 | Pivot rotation | gated | L6 (paired-role choreography) |
| 12 | Switch support | gated | L6 (weak side implies team shape) |
| 13 | Bounce pass support | **live** | the one-two (wall-pass drill, L5b round 2) |
| 14 | Overload run | gated | L6 (numbers awareness is a team computation) |
| 15 | Escape support | **live** | keepValue's space term |
| 16 | Cover support | gated | L5c (defensive balance behind the attack) |
| 17 | Tempo control position | gated | L6 (deep playmaker role) + tactics instructions |
| 18 | Blindside midfield | gated | L5c/L5d — blind spots need perceiving opponents |
| 19 | Underlapping midfield | gated | L6 role structure (same as overlap #15/16 above) |
| 20 | Third-man midfield | **emergent** | pass → support → run beyond: runPlan + flight-possession already produce it; judge in small-sided |

## Defensive runs (`reference/defender_runs.md`) — the L5c/L5d/L5e pre-spec

None are buildable yet (brains do not defend — the recorded boundary), but
the list maps almost one-to-one onto the spec's defensive sub-phases and
should seed their scenario libraries:

- **L5c (defensive shape)**: cover run (3), channel recovery (5),
  interception run (10), passing lane block (12), goal protection (13),
  box recovery (14), offside line recovery (22 — with L9), ball-side
  shift (24), weak-side compression (25) — the spec's "line as a unit,
  compactness, horizontal shift" list, verbatim.
- **L5d (pressing)**: pressing run (6), curved press (7), shadow press
  (8 — the spec's cover shadows), counterpress (18), delay run (19 —
  with L5e's jockey).
- **L5e (marking & duels)**: recovery run (1), goal-side recovery (2),
  tracking run (4), jockey (9 — the recorded head-on guardrail), cut-off
  (11), wide recovery (15), double team (16), switch tracking (17),
  screening (20), mark switch (23).
- **Later**: cross coverage (21) → L8; emergency goal-line (26) → L7.
