# Engine V2 — builder reference index

The builder's reference documents (`reference/*.md`), mapped to owning
layers. Each is treated the way `defender_runs.md` was for L5c/d/e: a
pre-spec that seeds the layer's mechanisms and scenario library when it
opens — never a build order in itself.

## `types_runs.md`, `midfield_runs.md`, `defender_runs.md`
Mapped run-by-run in `RUNS.md` (attacker/midfield: live/emergent/gated;
defensive: the L5c/L5d/L5e pre-spec).

## `roles.md` — the L6 pre-spec
Roles as parameter bundles over L5 behaviors — exactly the spec's L6
("the tactics surface re-expressed as parameters of L5 behaviors"). The
existing instruction surface (risk, objective) is the embryo: a role =
a named preset over {risk, run frequency/type biases, support bias
(forward/backward/wide), pressing intensity, positional home + width}.
Notable hooks already live: target man ≈ check runs + layoffs (the
wall-pass pivot); advanced forward ≈ runPlan's in-behind bias; regista ≈
deep support + tempo (delay-release bias); role SWITCHING (fullback→
midfield) is L6 dynamic shape. Personality-modulated roles (aggressive
vs conservative regista) map to per-body instruction offsets.

## `spatial.md` — the perception pass pre-spec
Spec §3 explicitly: "Perception can be imperfect later (awareness
attribute); v2.0 uses true state." This document is the design for that
later pass. What already exists as TRUE-STATE analogues: space
evaluation (posValue/keepValue/supportSpot), passing-lane awareness
(passCompletion), ball prediction (predictBall), threat-ish carry
pressure (the risk-scaled horizon). What the pass adds when it opens:
vision cones + scan cadence + reaction delay (replacing the flat 0.35 s
lane reaction), confidence-weighted decisions, memory of tendencies,
zone semantics (half-spaces, zone 14 — shared with L6 geometry).
Gate: after L5 sub-phases stabilize — imperfect perception multiplies
every behavior's failure modes and should land on a judged-solid base.

## `communication.md` — gated WITH the perception pass
Today coordination flows through shared true state (runningLine,
waitingRunners, intendedReceiver ARE the messages "I'm making a run" /
"one-two" / "I'm free", delivered losslessly). Explicit messaging with
range, urgency, chemistry, and MIS-communication only becomes meaningful
once perception is imperfect — a message is information transfer, and
information transfer needs missing information. Build the two together;
the reference's message taxonomy (intent/support/defensive/tactical)
then becomes the channel between imperfect perceivers, and chemistry/
leadership modulate its reliability.
