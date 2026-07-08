# DECISIONS

Running log of decisions that aren't obvious from the types or schema alone.
Newest first. Keep entries short: what, why, where enforced.

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
