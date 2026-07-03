# DECISIONS

Running log of decisions that aren't obvious from the types or schema alone.
Newest first. Keep entries short: what, why, where enforced.

## 2026-07-03 — data pipeline (pipeline/, Python, standalone)

- Not a pnpm package: runs locally, outputs `seeds/players.sql` + review
  reports. `MAPPING.md` is the derivation contract (attribute → metrics →
  transform) and `config.py` the single tuning surface. Deterministic from
  `cache/`.
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
