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
  lone jockey — same machine, same counter. The knock-and-go sideways-past a
  spread keeper (who cannot use hands outside the ball's line and is
  backpedal-slow laterally) is the striker's remaining 1v1 conversion. No
  special case: if the knock-and-go reads "isolated defender + space behind"
  it fires vs the keeper for free. Acceptance: the keeper-1v1 scenario's
  save-rate drops from 12/12 to a realistic mix.

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
