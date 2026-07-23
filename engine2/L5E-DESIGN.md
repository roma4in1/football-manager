# L5E — The Duel State Machine (design before code)

The July 21 exploratory build died to ten iterations of whack-a-mole because
jockey / track / engage / stagger / knock-and-go are **one coupled machine**.
This document designs it as a unit — states, transitions with hysteresis, and
the distance bands solved **jointly** — per the stop-rule brief (727cf1e5),
plus one new tenant from the keeper arc: **round-the-keeper**.

## 1. The defender's machine (per defender, vs the carrier he presses)

```
            wrong side                    carrier at pace (>4.5 m/s)
  ┌──────┐ ─────────────► ┌─────────┐ ◄─────────────────────┐
  │ANY   │                │ RECOVER │                        │
  └──────┘                └────┬────┘                   ┌────┴────┐
                    goal-side  │  regained              │  TRACK  │
                               ▼                        └────┬────┘
                          ┌─────────┐   carrier slows        │
                          │ JOCKEY  │ ◄──────────────────────┘
                          └────┬────┘
              pressure trigger │ (patience spent / stopped carrier / support arrived)
                               ▼
                          ┌─────────┐  tackle resolves (win → ball; lose ↓)
                          │ ENGAGE  │
                          └────┬────┘
                        failed │
                               ▼
                          ┌───────────┐  0.8 s planted
                          │ STAGGERED │ ────────────► RECOVER
                          └───────────┘
```

### States

- **RECOVER** — not goal-side of the carrier: sprint to a cut-off point ON the
  carrier→goal line ahead of him (never a trailing chase; a trailing body can
  never pinch — the ball is always ahead of the carrier).
- **JOCKEY** — goal-side, carrier slow (< `vTrackEnter`): hold `dHold` on the
  carrier→goal line, backpedal-capped (`vJockeyMax` 4.5), facing the ball
  (the face-lock/shuffle L1 capability the keeper added — reuse it).
- **TRACK** — goal-side, carrier at pace: full-speed goal-side escort (no
  backpedal cap — the cap alone donated a permanent 4 m escort trail). Drop
  back to JOCKEY when the carrier slows below `vTrackExit` (hysteresis:
  `vTrackEnter` 4.5 / `vTrackExit` 3.5 — a single threshold flapped).
- **ENGAGE** — commit to the tackle: step in, resolveTackles does the contact.
  Entry conditions (ALL): goal-side or alongside; carrier within `dEngage`;
  pressure ≥ threshold. Never from RECOVER.
- **STAGGERED** — the failed lunge: planted `tStagger` 0.8 s (stand, no
  steering), then RECOVER. Without this, repeated 27% tackles compound to
  inevitability over any crawl (16/16 vs elite close control — measured).

### Pressure (the patience meter, per duel)

```
pressure += DT · (base                       // patience drains slowly
                  + stoppedBonus·(carrier.speed < 0.8)   // a stopped carrier invites the lunge
                  + supportBonus·(a covering mate within dCover))
pressure  = 0 on state exit / possession change
ENGAGE when pressure ≥ 1 AND geometry allows
```

Waiting = hoping for support; support may never come — `base` alone must
eventually trigger (≈ 3.5 s of pure jockey).

### The bands — solved together (the no-man's-band killer)

The July failure: jockey hold 2.0, engage range 2.6, attacker's arc 2.2–2.7
were tuned separately and nothing ever engaged. The joint constraint is:

```
dHold (2.0)  <  attacker arc low (2.2)  <  dEngage (2.6)  ≤  arc high (2.7)
```

so the ENGAGE window `[2.2, 2.6]` overlaps the attacker's working arc and is
reachable FROM the jockey hold in one step. These four numbers move together
or not at all.

## 2. The attacker's half (decide.ts additions)

- **Knock-and-go**: jockeyed (a defender holding `dHold`-ish) + open space
  behind him → self-pass past the shoulder + race. Clearance is
  DEFENDER-relative (the knock-past drill's lesson), and it requires the
  isolation principle below or it never fires.
- **Isolation discount**: carry pressure from a defender with **no cover
  within 12 m** is discounted ×0.45 — one lone jockey was repelling a carrier
  from half the pitch (a 16 s orbit, measured).
- **ROUND-THE-KEEPER** (new, from the keeper arc): the delaying keeper IS a
  lone jockey — same machine, same counter. **Session finding (calibration):**
  the knock is the WRONG tool at range against a keeper — a knock past hands,
  dive and sweep rolled straight into his gloves 16/16 (the reclaim space is
  HIS space). The knock is now KEEPER-AWARE (DecideInput.keepers; the berth
  requirement roughly doubles), which suppresses the suicidal version. The
  honest remaining conversion is the DRIBBLE-AROUND — a carry move past the
  keeper's side (tight touches, not a self-pass), which belongs to the carry
  vocabulary, not the knock. Until it exists, the pinned 1v1 equilibrium
  stands: a proper keeper (delay, spread, pounce) deals with the 1v1; a
  stranded one is punished by placement/chip. Deferred with evidence.

### Session finding: the front-on duel needs the attacker's BEAT vocabulary

With the machine riding properly (momentum-aware activation, give-ground at a
concede rate, engage-gated tackle AND pinch), the front-on attacker loses by
COLLISION-STRIP — he drives into the riding body, the dribble coupling breaks,
and the loose ball is claimed. Zero tackles needed; touch skill irrelevant
(close 1/16, heavy 0/16). The pinch/tackle/touch-shorten knobs were each
tried and measured — none is the answer, because the missing half is the
ATTACKER'S BEAT: the arc around the arc-band, the angle-change at the hold
boundary, the feint (this was always "L4's move" per the original drill). The
old 12/16 through-pin encoded the pre-machine static defense and is retired;
the head-on test pins engagement + the defensive win until the beat lands.
Design the beat as a unit with the knock-and-go (they share the arc bands).

**Second exploration (Jul 23), six measured probes, all reverted — the map for
the micro-session:**

1. Touch-shorten under a rider: broke the chase-escape drill (shortening must
   be RIDDEN-only, not near-any-opponent), didn't move the front-on rate.
2. Pinch gated on ENGAGE (kept in the judged build): principled, didn't move
   the rate — the strip is NOT the pinch.
3. Beat bonus (skill-scaled cut EV) + collision tax (a carry path through a
   body ×0.25): the cuts ARE chosen (measured in the options dump) but the
   rate did not move — and the pair destabilized striker-breakaway and
   wall-pass (the collision tax reshapes carry EV everywhere). Needs
   RIDDEN-scoped application.
4. Defender reaction lag (smoothed ~0.4 s read of the carrier's velocity —
   the per-tick 0.4 s FUTURE projection anticipates every cut, which is
   superhuman and no feint can move): principled, kept-worthy, but alone did
   not move the rate.
5. Ball-anchored ride (the bands are carrier-relative but the ball rides
   1-1.4 m ahead — a 2.0 hold sits INSIDE every touch): made it worse (0/16);
   the standoff helps the defender too.
6. The MICROTRACE truth: the strip is the COLLISION — the attacker's speed
   dies on the body clip while his momentum touch spills forward, and any
   forward spill favors the goal-side man BY GEOMETRY. The attacker needs
   approach CRAFT: slow INTO the arc (never drive full-pace into a set
   rider), cut on the smoothed-read lag, THEN burst (knock) through the
   opened lane — a sequenced move, i.e. a real feint state on the attacker,
   not an EV bonus. Build it as a small attacker-side state (APPROACH →
   FEINT → BURST) in its own session, judged in the workbench per step.

**Third exploration (Jul 23) — the beat scaffold built, findings, reverted to
a patch (patches/beat-scaffold.patch has the full working code: the beat
intent, the approach→feint→burst executor, the free-run pricing, the
live-rider knock discount). What it established:**

- **THE DRILL WAS A SCRIPT**: the front-duel attacker had no brain — every
  attacker-side EV lever ever probed (knock, beat, collision tax, isolation)
  was DEAD CODE in the drill built to show it. "Both duel sides must be
  brains" was the brief's ground rule §6, unapplied. With a brain, the knock
  fires 8/8 immediately.
- **KICK-AND-RUSH IS REAL**: a brained HEAVY-feet attacker knocks past the
  backpedaling rider 16/16 — the knock needs no touch skill and the
  give-ground machine cannot turn fast enough to catch the race. Real
  football agrees (route one works vs a lone retreating man); the missing
  counter is defensive: cover/angling, and a concede that STOPS (a defender
  who won't backpedal forever), not more attacker nerfs.
- **PRICING IS GLOBAL**: the free-run bonus made wall-pass carriers knock
  past their wall — every duel-pricing term reshapes ALL open play. The
  micro-session must run the full suite per dial, and the beat/knock pricing
  needs a context gate (a genuine LAST-man/free-run situation, not any
  frontman).
- **The beat itself never outranked** carry/knock in any probe — its EV story
  (the manufactured knock) needs the knock's live-rider discount AND the
  free-run context to be top — i.e., the three pieces only work as a set,
  with the defensive concede-stop landing alongside. One coupled unit, again.
- The pinch's engage-gate INVERTED the skill split (heavy's long touches
  became safe) and never helped close control — the pinch stays ungated; the
  close-control deficit is the COLLISION, whose true fix is the beat's
  APPROACH phase (slow into the arc).

### The COVERED DUEL (builder-chosen acceptance) — the next defensive work item

The builder chose COVER over walls for the head-on drill (real football forces
duels with cover, not corridors). Building it exposed the real hole, bigger
than any drill: **the defense cannot contain a brained attacker even 2v1.**
Trace evidence (Jul 23): the press election parks the presser in moveTo
(pressApproach) so the duel machine (chaseBall-gated) never rides him; force-
assigning chaseBall inside duel range did not change outcomes — the presser
TRAILS every lateral cut and both skill levels sail through 16/16. The
press-election ↔ duel-machine integration versus a MOVING, deciding carrier is
one coupled work item with the covered drill as its acceptance:
  - the elected presser belongs to the MACHINE from election (not from
    chaseBall range) — approach, ride, and engage as one continuum;
  - the ride must hold a CUTTING carrier (the lateral trail is the beat's
    free win today — fix the defense first, then measure the beat honestly);
  - cover positioning (the second man) must close the outflank lane, which
    pressCoverSpots may already express — verify.
Do this dial-by-dial with the workbench open (wb seeds, builder judging live) —
three probe-only blocks have now bounced off it.

### THE DEFENSIVE BRAIN (builder direction, Jul 23) — the real shape of the fix

The asymmetry, named by the builder: the attacker has an EV brain (decide.ts);
the defender has hardcoded machinery. Audited: `pressScore` uses ZERO
attributes (distance + the team pressing dial only); every DUEL dial is a
constant (all defenders jockey at 4.5, fill patience in 3.5 s, engage at 2.6);
attributes enter defense only at contact (`tackleWinProbability`); roles.md
sits unwired. `brain: 'onBall'` says it out loud — only on-ball decisions were
ever designed.

**decideDefense — symmetry with decide:**
- Per defender per reconsider tick, choose a defensive INTENT: `press` (first
  man) / `contain` (the machine executes the ride) / `cover` (second-man
  spot) / `mark` (a runner) / `interceptLane` / `drop` (recover) /
  `holdShape`. Team coordination (one presser, cover assignment) stays an
  election — but scored, not hardcoded.
- **Attributes drive the dials** (per-player, not constants):
  tackling → pressure fill rate (a strong tackler engages sooner);
  agility/balance → jockey cap + engage range (nimble rides tighter);
  pace → track confidence + concede rate (a SLOW defender drops earlier —
  real football). Schema candidates recorded: `positioning`, `aggression`
  (defensive IQ has no attribute today), alongside finishing/shotPower.
- **Tactics drive the weights** (the instructions surface): pressing +
  lineHeight (exist), plus marking scheme, engagement line, compactness —
  the L6 story: management controls driving the behavioral sim.
- **Roles weight the intents** (BodyInit.role, from roles.md): a CB weights
  cover/drop/mark; a FB contains wide and tracks; a DM screens lanes. A role
  is a weight vector over intents, not a position.
- **The machine becomes the executor** of press/contain intents — the exact
  decide→executor split the attacker has. This dissolves the chaseBall-gating
  hole structurally: the brain owns the defender, the machine runs his state.

Acceptance: the covered duel (above) defends honestly; the beat is then
measured against a competent defense; pressScore retires into decideDefense.

### The principles pass (reference/defensive_principles.md, Jul 23)

The builder's reference doc gives the brain its spine. What it settles:

**Part III's decision hierarchy IS the scorer.** decideDefense evaluates the
nine questions in order — goal threat? goal side? teammate pressing? cover?
mark? intercept? delay? tackle? recover shape — as TIERED scores, not if-else:
a live higher tier dominates, attributes/tactics/roles modulate within a tier.
The intent set, mapped to the doc:

| intent | principle | today's machinery (what it absorbs) |
|---|---|---|
| `recover` | I.1, I.12 (goal side; if beaten, sprint) | machine RECOVER state |
| `press` | IV first defender: pressure, slow, FORCE direction | election + pressApproach |
| `contain` | I.2/I.3, II.13 (delay > diving in; control distance) | machine JOCKEY/TRACK |
| `cover` | IV second defender + **II.7 protect BEHIND the press** | pressCoverSpots (lane-only — see hole below) |
| `balance` | IV third defender: dangerous space, watch runners | nothing (new) |
| `mark` | I.8 (ball AND man) | the deferred dart hand-off lands here |
| `interceptLane` | I.9, I.13 | shadowSpot |
| `holdShape` | II.10 (shape > chasing) | shapeSpot |

**FORCE DIRECTION is an output, not an intent** (I.4, II.2, II.8): press and
contain emit a steer — toward touchline, toward the cover man, away from
center. The contain bearing and the give-ground line take the bias. This is
the named missing counter from the kick-and-rush finding ("cover/angling"),
and it turns the covered duel from two independent defenders into a TRAP:
the ride forces the cut into the second man.

**The cover hole, named by II.7**: pressCoverSpots stands men ON pass lanes at
t=0.45 — nobody protects the space behind a beaten presser. "Single pass →
defensive line broken" is exactly the covered-duel outflank (16/16 through).
The cover spot becomes a blend: deny the best lane AND sit goal-side behind
the presser at the depth that closes the carry-around.

**Attributes → dials, per principle**: I.3 control distance (agility/balance →
holdM/engage tighter); I.2+I.10 delay-vs-dive (tackling, and the `aggression`
schema candidate → pressure fill + engage threshold); I.12 recover (pace →
concede rate; a slow defender drops earlier). Part V's role priorities are
roles.md's weight vectors verbatim (CB cover/aerial/organize, FB wide/delay,
DM screen/intercept, W track/double, ST initiate/block).

**Part VI is the regression anti-checklist** — each mistake is an engine
failure we have already met: diving in = the pre-machine charge; chasing the
ball = the chaseBall gate; pressing without support = the 2v1 sail-through;
ball watching = trailing the lateral cut. New pins should quote it.

**Philosophy line for the scorer**: "reduce the opponent's options until they
are forced into a low-quality decision" — the defender's EV is the negative
of the attacker's best option. Tier scores approximate this; when a tie needs
breaking, break it toward whichever intent most degrades the carrier's top
`evaluateOptions` entry.

**Execution order (one measured change at a time):**
1. decideDefense skeleton + machine OWNERSHIP: the elected presser belongs to
   the machine from election (not from chaseBall range) — behavior-preserving
   refactor first, full suite green.
2. Cover-behind-the-press spot (II.7) — the covered duel's outflank closes.
3. Force-direction steer in the ride (I.4/II.2).
4. Attribute dials.
5. Roles as weight vectors (Part V ↔ roles.md).

## 3. Loose-ball pursuit arbitration + separation

Two stacked teammates run the same loose ball, end 0.7 m apart, then each
intercepts the other's pass to a third man (the corner flap's residual).

- **One CLAIMANT per loose ball per team**: elected by earliest arrival
  (interceptPoint tMeet); re-elected only on a 0.3 s hysteresis margin.
- **Everyone else = SUPPORT**: offset spots (the existing support machinery),
  and a support body inside `dStack` 1.5 m of the claimant separates along
  the perpendicular of the claimant→ball line.

## 4. Dart-tracking hand-off

Naive goal-side man-tracking dragged line members out (goal-side integrity
75% → 27%). A runner crossing zones is HANDED OFF along the line (the
mark-switch from defender_runs): the tracker releases at his zone edge, the
neighbor picks up — part of this machine because trackers in RECOVER/TRACK
must know when the runner is no longer theirs.

## 5. The through-ball release gate (run-coordination)

The overhit tail comes from releasing before the runner is up to speed — no
weight constant fixes it (measured: softening breaks the contested lane and
the risk dial). The passer's thread option is HELD (ridingWait-style) until
the runner's projected speed at the breach ≥ `vRunRelease` (≈ 5 m/s), using
his run state — the L5b run cycle coupled to the pass release.

## 6. Ground rules carried in from the brief

- Both duel sides are brains in every scenario.
- `shieldUtility` re-lands at ≈ 0.014 (0.03 froze carriers at kickoff).
- Carried-ball bounds: dribbling over a grid/pitch line goes dead; bodies
  clamp to the playing area.
- The pinch refractory lock + teammate-can't-pinch are already landed; a
  level-pinch scenario stress-pins them here.

## 7. Implementation order (one measured change at a time)

1. Machine core: RECOVER/JOCKEY/TRACK + hysteresis (replaces the contain
   bearing logic for the elected presser; measure front/dial/runs pinned).
2. Pressure meter + ENGAGE + the joint bands.
3. STAGGER.
4. Knock-and-go + isolation discount (attacker EV).
5. Round-the-keeper acceptance (no new code expected).
6. Claimant arbitration + separation.
7. Dart hand-off.
8. Through-ball release gate.
9. Bounds.

Scenarios: `duel-jockey` (hold vs slow carrier), `duel-track` (escort at
pace), `duel-engage` (pressure spike on a stopped carrier), `duel-stagger`
(beaten → planted → recover), `knock-and-go`, `isolated-carry`,
`loose-arbitration`, `dart-handoff`, `through-ball-timed`, plus the existing
keeper-1v1 as the round-the-keeper acceptance. Every prior pinned rate holds
at each step or the step reverts.
