# DECISIONS

Running log of decisions that aren't obvious from the types or schema alone.
Newest first. Keep entries short: what, why, where enforced.

## 2026-08-26 — test-only week forcing: sim MW1 now, on the real pipeline

- **POST /api/admin/force-week-close** (TEST_FORCE_WEEK_CLOSE=1 +
  `{"confirm":"SIM NOW"}`): pulls the current matchweek's deadline to now()
  and calls the orchestrator's own `runWeekClose` — real sims with default
  lineups where none were submitted, bookkeeping, the between-week tick,
  reveal, season choreography. NOT a shortcut; it validates the live
  pipeline. Guard is structural: without the env flag the route is never
  registered (404), so it cannot fire in a real season.
- **MATCHWEEK_CADENCE_MINUTES_TEST**: schedule generation (auction
  completion + playoff seeding) reads `matchweekCadenceMs()` from the new
  `league-test-overrides.ts` instead of LEAGUE_CFG inline — real 7 days
  unless the var is set. Affects newly generated weeks only.
- All test overrides now live in ONE module (league-test-overrides.ts),
  warn ⚠️ at boot, and are enumerated in DEPLOY.md's go-live checklist —
  the lesson from the 5s timer that shipped invisibly from an edited tree.
- **OPEN INVESTIGATION (do not forget)**: the live test auction completed
  with Beta United at 11/13 — below squadMin. The completion gate
  (league-auction.ts maybeComplete) reads
  `clubs.every(count >= squadMin)` with squadMin from LEAGUE_CFG (13, no
  production tuning), which LOOKS correct — so either the count query
  (store.squadCounts) diverges from the UI's count, something removed
  squad_players/contracts after completion (forfeit? release?), or the UI
  undercounts (e.g. injured players filtered). Verify against prod:
  `SELECT club_id, count(*) FROM squad_players WHERE season_id=… GROUP BY 1`
  vs contracts, and check auction_lots forfeit history for Beta. Potential
  real-league blocker; investigate before the friends' season.

## 2026-08-25 — tactics editor polish + the live team-shape pitch

- **Zone labels live OUTSIDE the box** (a chip above the bbox, below when the
  zone hugs the top edge) — text can no longer spill out of a small zone at
  any size. **Zones resize** by dragging bbox-corner handles: every vertex
  scales about the OPPOSITE corner (rects resize classically; hand-shaped
  polygons keep their proportions; never flips, min 4×3m, clamped to pitch).
  Engine contract untouched (convex ≤8 verts — scaling preserves both).
- **Save preset from the editor**: the phase-preset shape gained `zones`
  (anchor + sliders + zones is the whole phase); saved from the editor's
  right pane without leaving the screen. Pre-zones presets (no `zones` key)
  apply without touching zones — device-local storage stays back-compatible.
- **The team tab is a live pitch, not bare sliders**: the eleven render
  through the ENGINE's own anchor deformation (AGENT_CAL via the new
  `@fm/engine/agent-model` export — read-only constants, no new dep edges):
  lineHeight shifts the block, width scales spread, compactness squeezes
  toward the centroid; ghost dots mark raw anchors so displacement is
  legible. Out-of-possession block shown (where all three bite);
  press/tempo don't hold shape, so they render as derived facts (N chasers,
  chase range in meters). The viz cannot drift from the sim because it IS
  the sim's formula.
- **Lineup-as-pitch (drag players on/off, bench alongside) SPLIT to its own
  PR** — real drag-and-drop with inherit-on-swap interplay; per the brief's
  own rule, too big to ride along.
- **Auction timer test override is now an ENV VAR, never a tree edit**:
  `AUCTION_LOT_SECONDS_TEST` (loud ⚠️ warning at boot, soft close derived,
  visible in `fly config show`, launch checklist demands it unset). The
  repo's LEAGUE_CFG stays 120s/20s — a 5s value must never be committed or
  invisibly deployed from an edited working tree again.

## 2026-08-24 — the economy reconciled onto the realistic-millions scale

- **The bug** (live test season): market values are real euros (elite ~200M)
  but budgets (100k) and wage caps (10k) were placeholders — one star's wage
  broke the cap and nothing was affordable; the auction was unplayable.
- **The scale** (LEAGUE_CFG): `defaultTransferBudget` 2B, `defaultWageCap`
  150k/wk, `wagePerMarketValue` 0.0001 → **0.000093**, `bidIncrementMin` 1 →
  **1M** (fixed, not a %: the minimum next bid stays head-computable
  mid-timer; 0.5% of an elite lot), `facilityCostByLevel` →
  **[50M, 100M, 200M, 350M, 600M]** (one facility maxes at 1.3B = 65% of a
  budget; both at 2.6B > budget — the PR #14 "can't max everything" rule
  survives the rescale). setupSeason defaults now read LEAGUE_CFG.
- **THE WAGE CAP IS THE PRIMARY BINDER** — and the parity lever to revisit
  after playtest. The formula is derived, not picked: the design basket
  (4×200M elite + 9×90M starters = 1.61B of value) must land just under the
  cap → 150k/1.61B ≈ 9.3e-5. That basket wages to 149,730 (99.8% of cap); a
  5th elite breaks it even trading a starter down; filling to squadMax
  breaks it; and the basket costs 1.61B of a 2B budget (≤85%), so money
  never binds first. All of this is a CI invariant
  (engine/league-economy.test.ts), so a future retune must re-derive.
- **6b re-calibrated on the new scale**: the growth harness's max-hoard
  ALLOTMENT was a hardcoded 100k — a fiction after the rescale (a hoarder
  could never afford a 50M facility and unspent compounding would trip the
  interest gate). It now tracks `defaultTransferBudget`. Re-run: 15/15 on
  fixture AND real pool — hoard-vs-bring gap +0.22/5yr (<0.5), increments
  decelerating, interest share 26.4% (<30%). X=0.10 and leftover→reserve 0.5
  are rate knobs and stayed put.
- Tests keep their toy economies via `AuctionTuning.bidIncrementMin` (the
  same pattern as the timer knobs); the split-lock 409 is scale-free and
  still covered.
- **Auction UI**: the lot now shows the player's WAGE and the cap impact
  ("wages if won 96k/150k", OVER CAP inline warning) — wage was invisible
  until a rejected bid; the money pane shows wage ROOM; `fmtMoney` (2.0B /
  350M / 18.6k) everywhere in the room because ten-digit numbers don't fit
  a 375px pane; bid controls step by the real increment (min / +10M).

## 2026-08-23 — production league setup is script-only, safe by construction

- `scripts/setup-production.ts` creates the league (managers/clubs/season →
  auction) on an EXISTING database — there is no in-app league creation.
  Safety is structural, not procedural: it never drops or seeds anything,
  refuses unless the DB is a virgin league (players > 0, zero seasons, zero
  clubs — half-states abort with "inspect first"), and DRY-RUN IS THE
  DEFAULT (`--apply` to write). One clubs.json shape serves both the 2-club
  test season and the real 5–10 club league.
- It creates the FIRST season only: rollover owns N+1, and replacing a test
  league pre-launch is a deliberate manual teardown (DEPLOY.md §1.4) — the
  script will not paper over an existing season.
- setupSeason now LINKS a pre-existing manager by email
  (`ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`)
  instead of failing on the unique constraint; an existing manager keeps
  their display_name. Managers stay seeded-not-registered.
- seed-demo.ts (destructive: drops schemas) now REFUSES non-localhost hosts
  at runtime — the LOCAL-ONLY rule is enforced, not just documented.
- Tested as an operator would run it: league-setup-production.test.ts spawns
  the actual scripts as child processes and asserts every guard (empty pool,
  dry-run writes nothing, apply creates + links, second apply refuses,
  seed-demo non-local refusal).

## 2026-08-22 — production deployment: Fly + Supabase + Resend, runbook-driven

- **Topology**: one always-on Fly machine (`fly.toml`, shared-cpu-1x/512MB,
  ~$5/mo) runs the existing single process (API + pg-boss worker) and serves
  `web/dist`. ALWAYS-ON IS LOAD-BEARING: pg-boss timers fire deadlines; Fly
  auto-stop would delay them until a request wakes the machine — `auto_stop
  = off`, `min_machines_running = 1` are correctness settings, not cost ones.
- **Supabase = connection string only** (we keep our own magic-link auth; no
  Supabase Auth/Realtime/Storage). Documented connection is the SESSION
  pooler (port 5432) — pg-boss + our explicit BEGIN/COMMIT row-lock
  transactions need session semantics; the transaction pooler (6543) is
  called out as unsuitable.
- **Email**: Resend behind the existing LinkDelivery interface
  (`league-email.ts`) — one HTTPS POST via global fetch, NO new dependency,
  provider swappable in one module. Selected by env (`RESEND_API_KEY` +
  `EMAIL_FROM`); absent → console stub as before, with a warning when
  `BASE_URL` is set (production smell). Failures THROW → request-link 500s;
  a swallowed send would be indistinguishable from the deliberate
  unknown-email 204. Noted as the fallback channel if iOS-push reveals flake.
- **Runtime config via env** (league-server.ts): HOST/PORT/BASE_URL override
  the LEAGUE_CFG dev defaults; BASE_URL drives magic-link URLs and flips the
  session cookie to `Secure`. Secrets (DATABASE_URL, SESSION_SECRET,
  RESEND_API_KEY) live in Fly's secret store, never committed.
- **`/api/health`** (unauthenticated): `SELECT 1` through the shared pool —
  proves HTTP + DB, probed by Fly's checks and CI.
- **The deployable artifact is CI-gated**: the new `deploy-image` job builds
  the repo Dockerfile (Node 24 runs the server TS directly — no server build
  step to drift; Vite builds the PWA; runtime stage installs prod deps only),
  boots it against a service Postgres, and probes /api/health + the SPA
  fallback. Verified locally the same way before shipping.
- **Schema cutover documented, no migration framework built**: pre-launch =
  create-once (`schema.sql` run once via psql); post-launch = hand-written
  ALTER migrations with schema.sql kept canonical (docs/DEPLOY.md §1.3).
- **Backups**: Supabase FREE tier has NO automated backups → nightly
  `pg_dump` workflow (backup.yml) uploads a GitHub artifact, 30-day
  retention. ENCRYPTED (AES-256, `BACKUP_PASSPHRASE` secret) because the
  repo is public and public-repo artifacts are downloadable by any logged-in
  GitHub user — a raw dump leaks manager emails and LIVE SESSION IDS.
  No-ops until the two secrets exist, so it merged ahead of go-live.
- **docs/DEPLOY.md** is the go-live runbook: Supabase → Resend → Fly secrets
  → deploy → Cloudflare DNS (DNS-only records — Fly owns TLS; cert issuance
  is unreliable behind the proxy) → verify → backup rehearsal. Includes ops:
  redeploy, health triage, SESSION_SECRET rotation (invalidates all
  sessions and unredeemed links per the PR #11 design — rotate between
  matchweeks).

## 2026-08-21 — design pass, chunks 2–4: every screen on the one language

- **home** (3 states): the fixture hero never scrolls; the attention column
  surfaces EXISTING state only (suspensions/injuries/affordable facility/
  training confirmation — never advice); scout = table position + last
  revealed results (full tactic-scouting stays season-2).
- **season**: results list via GET /api/results (the standings embargo join,
  tested pre/post-reveal); MATCH DETAIL replaces the separate result/replay
  screens — fixed score header, timeline/replay/stats tabs, goal rows carry
  ▶watch buttons that cue the replay 6 s before (ReplayViewer cueT prop).
- **squad player hub**: two-pane; 26 attributes grouped (gk group only for
  keepers), contract w/ seasons remaining, own season stats (apps/goals/avg
  rating/minutes — ASSISTS don't exist in engine events → parked), growth
  trajectory from attribute_audit. Training dial lives at /squad/training.
- **tactics**: the gravity-halo pitch editor (SVG; halo + dashed ring says
  "tends here, drifts, returns" — the screen's one job), 6 phase tabs
  morphing the team shape, faded-dot context players (tap to promote,
  exactly one detailed), zones with visible weight (add at anchor / drag /
  weight / remove), per-phase player sliders alongside; lineup tab with
  INHERIT-ON-SWAP (the config belongs to the slot); team instructions on a
  separate surface; presets are DEVICE-LOCAL (localStorage — server-side
  named presets need a table → parked; default_tactics stays the one
  server-saved plan, and the editor edits exactly that via the new GET).
- **market**: the auction rebuilt to the three-pane sketch — center live lot
  with position-aware bid stats (6–8 role attributes, full 26 on tap; pool
  payloads now carry attributes) + soft-close timer with a visible
  "+extended" pulse; left squad progress + per-position THIN warnings
  (4-4-2 floors); right money (fixed bidding balance + reserve + the split
  slider until first bid — display, never invest buttons). Transfers
  two-pane (market browse | your window). 375px check: the lot card never
  scrolls (stats grid scrolls within it), side panes 168/188px (148/172
  ≤480px height) scroll in-box.
- New server surface in the pass, all VIEWS over existing data: /results,
  /squad/player/:id, GET /default-tactics, pool attributes. Nothing from
  SEASON-2-PARKING was built; two items were added to it (assist tracking,
  server-side presets).

## 2026-08-20 — design pass, chunk 1: the design-system foundation

- **Palette stops proposed per DESIGN-SPEC** (clean/light, color = meaning):
  ink #1c2030 / muted #667085 on bg #f4f5f7, surfaces white, lines #e4e7ec.
  Selection/accent = the sketches' purple: #534AB7 (deep #423A99, soft
  #ECEAFB). Position hues — GK amber #D97706, DF blue #2F6FED, MF green
  #0E9F6E, FW red #E0475B, each with a soft tint for chips/rows. Status:
  fit green #0E9F6E, injured #D92D20, suspended #D97706, unsharp muted;
  condition bar green, sharpness bar indigo #6172F3.
- **Always-landscape shell**: 100dvh app frame, no page scroll — content
  panes own their scrolling (the ~375px-height rule: heroes never scroll,
  secondary columns scroll in-box; a max-height:480px media tier compacts
  rhythm further). Small-screen PORTRAIT gets the one prompt the app has —
  a hold-sideways card (a web app cannot force orientation; this is the
  minimal honest version of "always landscape").
- **Left rail, 5 sections** (triage/manage/deploy/invest/compete = home /
  squad / tactics / market / season), inline-SVG icons, active = purple
  pill. Market carries a red live-dot whenever phase ∈ {auction,
  transfer_window} (the "unmissable window" rule); the app refreshes /me
  every 60 s so the badge tracks phase without websockets.
- **Section frame + primitives**: Section (title + tab chips + body),
  .screen/.pane/.pane-hero/.pane-scroll two-pane primitives, PosChip (the
  position hue everywhere a player appears). Existing screens are HOSTED in
  their sections now (market → auction/transfers/facilities tabs, season →
  standings/bracket, squad → training) with legacy routes redirecting;
  their full redesigns land in chunks 2–4.
- Note: no frontend-design skill exists in this environment — DESIGN-BRIEF
  and DESIGN-SPEC are the authority for the pass.

## 2026-08-14 — end-of-season playoffs: top-4 knockout crowns the champion

- **Phase machine**: `playoffs` sits between regular and season_end —
  regular → playoffs → season_end (SQL trigger + TS mirror + smoke guards).
  regular → season_end stays legal for the DEGENERATE N<4 case only
  (demo/test leagues can't field a top-4 bracket); leagues of 4+ always
  play the knockout. The rollover trigger MOVED: season_end (growth, expiry,
  next auction) fires when the FINAL resolves, not at the last regular
  reveal — everything PR #19 does is unchanged, just re-gated.
- **Bracket**: top 4 from the FINAL table (points/GD/GF/name — the standings
  ordering is the seeding). Semis 1v4 and 2v3, TWO legs on aggregate, the
  HIGHER seed hosting the decisive second leg (the earned edge). The final
  is ONE match at a NEUTRAL venue: fixtures.neutral_venue zeroes the home
  boost in BOTH engines (aggregate homeShotBoost, agent homePressureRelief)
  — verified by an identical-clubs A/B (home edge present normally,
  symmetric under the flag) and by the realism fixture gate staying
  byte-identical (absent flag = no-op, no recalibration).
- **Ties are a structure over fixtures** (playoff_ties): playoff fixtures
  are REAL fixtures through the existing sim/HT/embargo/bookkeeping paths;
  the tie row carries seeds, leg references, the winner, and the shootout.
  The final tie is created only when both semis resolve.
- **Penalty shootout** (engine/penalty-shootout.ts, pure): triggers on a
  level aggregate (no away-goals rule, no extra time) or a drawn final.
  Best-of-5 alternating (deciding-fixture home side first), early
  termination when unwinnable, sudden-death pairs. Takers = the on-pitch XI
  (half-2 tactics minus sent-off) ordered by finishing, five best then the
  rest cycling; keeper = the on-pitch GK (gloves pass to the best
  gk-rated outfielder if he saw red). Kick model reuses the in-match
  penalty base (0.76) ± taker finishing / keeper (gkReflexes+gkPositioning)
  around 12, clamped 0.55–0.92 — constants live in the shootout module,
  NOT the harness-gated CALs (shootouts never occur in harness play).
  Deterministic: every kick draws Rng.fromSeed(`${fixtureSeed}|shootout|n`).
  The shootout decides the TIE ONLY — the 90-minute scoreline and stats
  stay as played (asserted).
- **Cadence**: leg 1 / leg 2 / final are three consecutive playoff-kind
  matchweeks on the normal weekly cadence — every existing mechanism
  (deadlines, HT windows, embargo, ticks, one-match bans between legs)
  applies untouched; compression would need new deadline plumbing for zero
  gain at human-manager scale. The between-week tick RUNS during playoffs
  (recovery, healing, sharpness — non-qualifiers rest and recover too);
  growth remains strictly a season_end event. Matchweek kind 'playoff'
  keeps playoff weeks out of the regular-season-over count.
- **Champion recorded** on seasons.champion_club_id when the final
  resolves, in the same reveal transaction (no embargo leak — the tie's
  winner/shootout only become non-null as the deciding week reveals).
  Bracket view: GET /api/playoffs (revealed leg scores only) + /playoffs
  screen with seeds, aggregates, shootout kicks and the champion.
- Timers: bracket seeding returns the three new matchweeks from the
  week-close transaction; the orchestrator arms their close timers after
  commit (the auction-completion precedent), injected into the core via
  CoreOptions.scheduleWeekClose.

## 2026-08-08 — pre-auction budget split (6b): bring vs reserve, calibrated

- **The split**: before bidding, a club divides its allotment into
  auction_budget (BROUGHT — the fixed bidding balance for the whole draft;
  NULL = no split set = bring everything, so every pre-6b flow is unchanged)
  and reserve_balance (held back). Set/re-set freely via
  PUT /api/auction/split until the club's FIRST bid (or won lot) — from
  then it binds (409 split_locked). Facilities stay un-buyable during the
  draft and bidding checks stay race-free because the bidding balance is a
  fixed number, not a live account.
- **Reserve is a LIVE balance** on club_seasons, mutated only under the
  club_seasons row lock (the same money lock facilities/transfers already
  take); transactions remain the audit trail. It is spendable ONLY on
  facilities + the mid-season window (buy fees and pool signings debit it,
  sale fees credit it) and NEVER re-enters auction bidding — banked money
  returning to the draft would be free-interest delayed spending. A
  bring-everything club therefore buys no facilities that season: that IS
  the decision weight.
- **Bindingness of leftover**: unspent bring converts to reserve at 0.5 at
  auction completion (runs once — the completing txn holds the seasons row
  lock and leaves the auction phase). At 1.0 the split is theater
  (bring-everything strictly dominates); at 0.0 prudent bidding is punished
  brutally; half-back makes over-bringing a real forecasting cost.
- **Growth tick: ONCE per season, at rollover** (reserve carries
  ×(1 + reserveGrowthRate) into season N+1). Interest is earned by HOLDING
  across the season boundary — bank-at-auction, spend-at-window earns
  nothing, killing the free intra-season interest play; and one compounding
  event per season maps 1:1 onto the harness. The new draft starts unsplit.
- **X = 0.10, CALIBRATED not guessed** (growth-harness scenario 4, CI
  fixture gate): max-hoard (bank the full 100k allotment every season, buy
  training facilities greedily) vs bring-everything (facility 0 forever) —
  the worst-case strategy gap. Measured: XI-mean gap grows +0.21 over 5
  seasons, DECELERATING (increments 0.041 → 0.029) — hoarding buys the
  already-bounded facility ceiling faster, not more; interest is 20.2% of
  principal banked (reserve ends ~471k of 500k). Honest finding: the gap
  gate is X-INSENSITIVE (facilities max by season ~1 at any X — the channel
  saturates), so the binding gate is the interest share (< 30%, "banking
  not investing") as the proxy for un-modeled window buying power. At
  X=0.5 that gate trips at 154.6% — the tripwire works. Verdict: "draft
  lean, hoard, bank, snowball" is NOT dominant at 0.10.
- Now-vs-later: the reserve system lands after rollover (#19) because the
  growth tick needs a season boundary to ride, and before any richer
  economy (prize money, gate receipts) so those can pay INTO an
  already-bounded reserve rather than inventing a second pot.

## 2026-08-02 — season rollover: the multi-season loop (season_end → complete → N+1)

- **The rollover rides the final week-close transaction**, immediately after
  season-end growth: growth → contract expiry → complete → season N+1 in the
  auction phase (league-rollover.ts). revealed_at stays the single
  exactly-once marker, so a crashed rollover replays from the reveal.
  season_end and complete flash by unobserved — nothing needs the pause
  until a renegotiation feature exists. Zero admin: the game repeats.
- **ORDER IS THE INVARIANT**: growth applies to contracted players FIRST, so
  an expiring player departs at his GROWN state and re-freezes in the pool
  by the locked rule (nothing ever touches uncontracted attributes). A
  re-draft picks him up exactly where the audit left him — verified both
  directions (audit.after == current state; never re-applied, never lost).
- **Retention scope v1: expiry only.** A contract signed season S with
  duration d covers seasons S…S+d−1 and expires when S+d−1 completes. NO
  renegotiation and NO manual release window: duration IS the retention
  mechanism (picked 1–4 at signing, wage flat by model — the forfeit-rule
  argument again: renegotiating wage would need a negotiation model we
  don't have), and the next auction re-acquires leavers on an open market.
  released_at remains the admin escape hatch.
- **Cross-season familiarity** (the transfer-PR open question, closed):
  pairs whose contracts BOTH carry at the same club keep
  familiarityCarryOver (0.5) of their end-of-season chemistry; any broken
  contract comes back cold — even re-drafted by the same club next week.
  Rationale: retention investment pays on the chemistry axis (duration > 1
  would be pointless there under a full reset), while the break still costs
  (full carry would ignore the off-season).
- **Money fresh, buildings carried**: season N+1 club_seasons copy the
  configured transfer_budget/wage_cap VALUES (spend resets automatically —
  transactions are per-season) until the reserve-growth economy exists;
  facility levels and the training dial carry (they're buildings/habits,
  and the growth harness already modeled persistent facility advantage as
  bounded). Carried players get fresh squad rows: the off-season heals —
  fatigue 0, injuries cleared, bans not carried (within-season sanctions,
  v1), sharpness back to the 0.3 cold start (pre-season rust for everyone).
- matchweek_count/transfer_week copy the old values at INSERT (schema CHECK)
  and are recomputed at auction completion, as always.
- **Proven repeatable**: league-rollover.test.ts plays TWO full seasons end
  to end through the production paths (real auction lots, real sims, real
  week-closes) and season 3 opens at the end — auction → weeks → window →
  weeks → growth+expiry+rollover → auction → … with every invariant above
  asserted, in ~2 s.

## 2026-07-27 — sharpness: the second fitness axis (condition/sharpness split)

- **Model**: condition = acute fatigue (existing `fatigue`); sharpness =
  match fitness on squad_players (REAL 0–1, schema DEFAULT 0.3 = the cold
  start). Built by minutes, decayed by the bench, tick-maintained. No smoke
  guard — a value column with no transition semantics (fatigue precedent).
- **Curves** (LEAGUE_CFG): gain 0.3/full match pro-rated by minutes/90;
  decay 0.06/week benched, 0.12/week injured (the treatment room can't train
  match-rhythm — this IS the "returnees come back LOW" rule, no extra clamp);
  floor 0.25. Calibration targets hit: a weekly starter saturates at 1.0, a
  4–6-week benching → 0.76–0.64 (noticeable, not crippling), a returnee is
  match-sharp after 2–3 games (0.3 → 0.6 → 0.9 → 1.0).
- **Cold arrivals — "not integrated" has two axes**: new rows (auction wins,
  pool signings) start at the 0.3 schema default; mid-season transfers clamp
  LEAST(current, 0.3) — like the familiarity wipe, and never a boost for an
  already-rustier mover.
- **just_returned GENERALIZED but the two costs stay DISTINCT**: the flag
  keeps exactly its re-injury-modifier meaning (consumed by one match);
  match-rust is a separate number with separate dynamics (decays while out,
  rebuilds over 2–3 games). One event (returning) moves both; nothing shares
  a number.
- **Effect is MEDIUM, decision + fatigue layers only** (execution noise
  stays attribute-driven — invariant intact): (a) fatigue accrual
  ×(1 + 0.5·(1−s)) — the visible cost, a rusty legs-drain; (b) decision
  temperature +0.06·(1−s), the SAME channel decisions relieve at 0.03/point
  → full-unsharp ≈ −2 decisions points. An unsharp star still beats a sharp
  filler; a marginal call flips. MEASURED into place: the first fit (0.09,
  −3 pts) dragged the real-pool mixed-distribution realism run to the 0.55
  win-share boundary with r 0.69 — too heavy per the medium rule, trimmed
  and re-measured.
- **Facility-INDEPENDENT by design**: sharpness SQL never touches
  club_seasons — play-rhythm is not health (medical) or development
  (training), and it would otherwise stack a third rich-club vector onto
  facilities. Tested (level 5 ≡ level 0).
- **Acceptance, both proven on the PR #17 fixture gates**: (1) full-sharp is
  a NO-OP — the default fixture realism run is BYTE-IDENTICAL to the
  pre-sharpness baseline (diff on --json output; keyed rng makes added reads
  free), so nothing leaks into the quality axis at s=1; (2) a realistic
  mixed mid-season distribution over the simmed XIs (deterministic
  name-hash: ~70% sharp 0.88–1, ~25% rotation 0.6–0.85, ~5% rusty
  0.35–0.55 — the XI is the most-played cohort, which a real mid-season
  keeps sharp; a 60/30/10 blanket was harsher than any realistic first
  team) passes 7/7 on BOTH pools: fixture win share 0.650 / r 0.818, real
  pool 0.675 / r 0.735. The mixed fixture run is a CI step
  (realism:ci:sharp): it trips if the penalty ever grows past medium.
  Stat harness untouched: 82/0 on all three seeds (synthetic squads carry
  no sharpness → 1 → no-op).
- UI: the two-bar condition+sharpness split on the lineup picker
  (FitnessBars), plus the training screen deferred from PR #16 (focus
  radio and intensity slider on GET/PUT /api/training).

## 2026-07-21 — harness CI fixtures: realism + growth tripwires in the merge gate

- **Problem closed**: the realism and growth harnesses were local-only (the
  fbref→squad join needs the human-populated, uncommitted cache CSV), so CI
  could not catch a squad-realism regression or a growth-compounding
  runaway — the guard only fired if a human remembered to run it. Proof it
  was real: the realism harness had been silently failing 2/7 since PR #10's
  tempering (top-8 win share gate 0.60 vs the ACCEPTED 0.575 balance point;
  market-value anchor 0.40 vs post-tempering ~0.31) and nobody saw.
- **Committed fixture pool** (engine/harness-fixture.json, ~330 kB): 24 real
  clubs / 411 players, generated by make-harness-fixture.ts (local, cache
  present; `pnpm harness-fixture` — regenerate when players.sql changes
  materially). Band-sampled, ends dense: the REAL top-8 and bottom-8 clubs
  plus 8 spread through the middle, so the top-vs-bottom check exercises the
  same extremes as the acceptance run (fixture win share replicates the real
  pool's 0.575 exactly — XIs are minutes-picked and seeds fixed). The clubs
  owning the pool's best and weakest eligible GK are always included so the
  keeper check keeps a real gk-attribute spread. Per club: most-played
  2 GK / 6 DF / 6 MF / 4 FW (XI-viable by construction).
- **Two modes, one loader** (harness-pool.ts): default = real pool, the
  AUTHORITATIVE acceptance gate, still run locally before an engine/growth
  PR merges; `--fixture` = the committed pool, run by the CI harness job
  (`pnpm realism:ci` / `pnpm growth:ci`) as a REGRESSION TRIPWIRE — it
  catches behavior drift, not absolute realism. Everything is deterministic
  (keyed rng, fixed seeds), so fixture results are stable until engine or
  growth code changes.
- **Gate re-alignments while wiring** (the drift this PR exists to prevent):
  realism top-8 win share gate 0.60 → 0.55 (PR #10 accepted 0.575);
  market-value anchor 0.40 → 0.25 (external sanity anchor, flattened by
  in-band draws); growth baseline σ bound 1.4× → 1.5× (tripwire margin —
  real pool sits at 1.34×, fixture at 1.42× from fixed-roster age mix). The
  realism round-robin sample is now evenly spaced across the FULL quality
  range (the old stride never reached the bottom clubs; real-pool r
  strengthened 0.71 → 0.82, anchor 0.31 → 0.58).
- **Tripwire proven to trip**: re-introducing the pre-brake growth config
  (facility slope 0.15, intensity gain ×2.0) makes `growth:ci` exit 1 —
  gap trajectory 1.04 → 1.96 (+0.92 vs the +0.5 bound) and the σ backstop
  at 2.0×. Reverted after the demonstration; both modes 7/7 and 12/12 at
  the tuned config.

## 2026-07-15 — training focus + season-end growth (ONE system), balance-gated

- **Architecture**: all math is pure in @fm/engine/growth (league-growth.ts);
  the server (league-training.ts) only moves rows. Weekly training accrues
  into squad_players.training_progress inside the week-close tick (revealed_at
  = exactly-once marker); the live attribute NEVER mutates mid-season.
  Season end applies accumulated training + the age curve in one pass for
  CONTRACTED players only (frozen-pool players never age or grow), writing
  attribute_audit ('season_growth') BEFORE each attribute update — the audit
  PK is the per-player applied-marker, so a retried pass skips cleanly.
  Attributes are fractional (2 dp) from the first growth on; 1–20 stays the
  scale.
- **Season-end trigger**: revealing the LAST regular matchweek (count of
  revealed kind='regular' weeks == seasons.matchweek_count — byes don't
  count) transitions regular → season_end through the SQL state machine,
  atomic with the reveal, and applies growth in the same transaction.
- **Weekly accrual** = (0.12 budget ÷ focus-group size) × intensity ×
  facility × age × minutes. Focus presets: balanced / possession / attacking
  / defending / physical — the budget SPLITS across the group, so narrow
  focus trains fewer attributes faster and no preset out-earns another in
  total. Keepers always train gk* whatever the club focus (a 'goalkeeping'
  preset would be dead weight for ten outfielders). Minutes: 90' = full
  rate, benchwarmers floor at 0.3 — development ties to the rotation
  economy. Age: ×1.6 at ≤20 → ×1 at 24–27 → ×0.25 at 33+.
- **Intensity is a real trade-off, one dial, both sides in the same tick**:
  accrual ×0 (full rest) → ×1 (0.5 default) → ×1.3 flat out (DIMINISHING
  returns past the default), while fatigue recovery scales ×1.25 (rest) →
  ×1 → ×0.75 (grind). Neutral at the default so pre-existing recovery
  behavior is unchanged.
- **Age curve at season end**: decline starts at 30, 0.2 raw pts/season per
  year past it, capped at 1.0, weighted per attribute — physical ×1,
  technical ×0.4, gk ×0.3, mental ×0.1 (legs go first, the brain stays).
  Young net-grow, peak plateau, veterans net-decline (harness: +0.176 /
  +0.112 / −0.273 composite per season for U21 / 24–27 / 31+ starters).
- **THE COMPOUNDING GATE (growth-harness.ts, tag growth — local/reported,
  like the realism harness: the fbref→squad join needs the human-populated
  cache CSV, which is deliberately uncommitted, so CI can't run it)**:
  5 simulated seasons on the real 2,128-player pool in its real 96 squads,
  same math as production. First fit (budget 0.12, facility ×1.75, intensity
  ×2 linear) RAN AWAY: rich-vs-poor XI-mean gap 1.02 → 2.23. Three
  structural brakes fixed it: intensity capped at ×1.3 (overtraining),
  facility slope 0.15 → 0.10 (×1.5 at level 5 — retunes the PR #14
  placeholder, same contract), and **headroom scaling** on gains
  (((20−v)/9)^1.2, clamp [0.1, 1.2]) so elite attributes crawl — the brake
  that binds ever harder as a club pulls ahead.
- **Measured verdict — the league stays competitive**: baseline (level
  field) σ 0.28 → 0.37 over 5 seasons, mean stable at ~11.2 (no inflation).
  Maximal bimodal stress (strong half: facility 5 + intensity 1.0 for five
  straight seasons, free of the fatigue bill; weak half: nothing) buys the
  rich cohort +0.45 XI-mean over 5 seasons with LINEAR-DECELERATING
  increments (0.09 → 0.05 by season 10, gap asymptoting ~+0.8) — headroom
  drag catches the leaders. That is ~1–2 table places for a maxed 130k
  facility + permanent grind: meaningful, not trivializing, not compounding.
  Gate design note: under a bimodal split, league σ mechanically restates
  the gap, so the pass/fail is the gap bound (+0.5/5yr) plus increment
  NON-ACCELERATION (the actual runaway signature), with σ < 2× as backstop.
  Caveat: fixed rosters — no churn — so late seasons decline league-wide;
  the divergence read is an upper bound on the rich edge.
- API: GET/PUT /api/training (focus + intensity), same phase rule as
  facilities (open regular + transfer_window). Client screen deferred — the
  dial is API-set this PR.

## 2026-07-09 — mid-season transfer window (the second market + the bye)

- **Two markets only**: the season-start auction and this one fixed week.
  The window is NOT a second auction — inter-club offers + fixed-price pool
  signings (league-transfers.ts), open only while phase='transfer_window'.
- **Window boundaries ride week-close** (league-orchestrator): closing the
  last pre-transfer regular week transitions regular → transfer_window;
  closing the transfer bye week itself IS the deadline — pending offers
  expire and transfer_window → regular resumes the second half. Both flips
  happen inside the tick+reveal transaction (revealed_at stays the
  exactly-once marker) and go through the SQL season state machine. The
  entry flip is skipped if the transfer week already revealed (late-retry
  backstop). The bye tick was already right: recovery + healing run, a
  one-match ban is NOT consumed by a bye.
- **Transfer wage rule: the contract rides along unchanged** (wage AND
  duration; the fee is the only new money). Rationale: duration never
  changes the weekly wage in our model, so there is nothing to renegotiate
  (same argument as the auction forfeit rule); re-deriving from market value
  would silently rewrite a contract the seller signed; and the buyer
  absorbing the existing wage is exactly what makes the wage-cap check at
  accept time meaningful. Mechanically a move is two UPDATEs — contracts
  .club_id and squad_players.club_id (PK is (season, player), so fatigue/
  injury/suspension/minutes ride along) — plus the fee txn (kind
  transfer_fee, club_id=buyer debited, to_club_id=seller credited).
- **Contested pool players: FIRST-COME under the players row lock**, not
  sealed bids. With the price fixed at market value there is no dimension
  left to bid on — a sealed fee bid would reintroduce the auction this
  window explicitly is not. First-come resolves instantly (the loser's txn
  sees the new contract and 409s), keeps squads knowable mid-window, and
  needs no deadline-resolution job or encumbrance of budget across pending
  bids. Wage = wageFromMarketValue, duration = transferContractDuration (2,
  no duration picker in the window).
- **Budget is bidirectional now** (store.budgetRemaining): transfer_budget
  minus all debits (auction_win, pool_signing, transfer_fee,
  facility_investment) plus transfer_fee credits — a sale funds new
  signings AND facilities (the
  facilities endpoints switched to the same function; one budget, one rule).
- **Offers**: one pending offer per (buyer, player) — re-offering replaces
  the fee (partial unique index); resolved offers are immutable (SQL
  trigger + smoke.sql guard). Offer-time checks are advisory; accept
  re-validates everything under locks (offer row → contract row → both
  club_seasons rows in club-id order — the club_seasons row lock is the
  club's money lock, the same one facilities investment takes). A stale
  accept (player already moved) expires the offer and 409s — the expiry
  commits even though the accept fails. Accepting also expires every other
  pending offer on that player.
- **Familiarity-cold on ANY club change**: a transfer wipes the player's
  dyads at the selling club and creates none at the buyer, so accrual
  restarts from zero co-played minutes — same integration cost as an
  auction signing (pool signings are cold by construction).

## 2026-07-09 — facilities economy: training + medical (youth DEFERRED)

- **Youth academy is explicitly deferred** — no schema column, no hook; it
  arrives with a youth-intake design, not as a third level counter.
- **Cost curve** (league-config `facilityCostByLevel`): 5k/10k/20k/35k/60k
  for levels 1→5. Maxing one facility costs 130k, both 260k, against a 100k
  default budget shared with auction spending — investment is a real
  tradeoff, not a checkbox.
- **Investment phases**: open during `regular` AND `transfer_window`
  (facilities are a season-long management lever), closed during `auction`
  — transfer_budget IS the live bidding balance there, and mutating it
  mid-lot would race bid validation — and from `season_end` on. Budget
  headroom = transfer_budget − Σ(auction_win + facility_investment) txns;
  wage_payment rides the wage-cap system, not the transfer budget.
- **Medical curve** (real values; the placeholder-linear hooks now carry
  weight): at level 5 — 30% of match injuries shrugged off entirely
  (`medicalInjuryAvoidPerLevel` 0.06, deterministic per fixture-seed+player
  so retried bookkeeping agrees), injury duration ×0.70
  (`medicalInjuryReductionPerLevel` 0.06, floor 0.5), weekly fatigue
  recovery ×1.25 (`medicalRecoveryBonusPerLevel` 0.05). Neutral at level 0;
  injuries still happen at max medical by design.
- **Training hook contract** (growth is NOT implemented here): the
  training-focus + season-end-growth PR consumes
  `trainingGrowthMul(training_level)` (= 1 + 0.15·level, league-config) as
  the per-player growth multiplier, reading levels via
  `store.getTrainingLevels(seasonId, clubIds)`. Nothing else may interpret
  training_level until that PR lands.

## 2026-07-09 — variable club count: supported N = 2–10, odd N via byes

- **Schedule**: doubleRoundRobin (league-auction.ts) uses the circle method
  with a null pad for odd N — every club byes EXACTLY once per leg, no club
  twice in a round, every pairing twice with venues swapped, each club hosts
  N−1. Regular weeks: 2(N−1) even, 2N odd (`expectedRounds`). Verified pure
  for N ∈ 2..10 and end-to-end (setup → auction completion → schedule) for
  N ∈ 5..10 in league-season.test.ts; odd N is load-bearing, not tolerated.
- **Season setup** is now one N-agnostic entry point (league-setup.ts
  `setupSeason`): matchweek_count is exact from N at INSERT (the schema
  CHECK `0 < transfer_week < matchweek_count` holds from creation, not just
  after auction completion), transfer week defaults to halfway and clamps
  to (0, rounds). The transfer week is an extra numbered bye week —
  matchweek_count stays "regular weeks" per the schema comment.
- **Pool-supply guards fail at setup, never mid-auction**: completability
  floor `pool ≥ (N−1)·squadMax + squadMin` (max hoarding cannot strand the
  last club below squadMin) and per-position floor `supply ≥ N × 4-4-2
  demand` (GK 1 / DF 4 / MF 4 / FW 2 — bestXI's shape). The guard takes the
  same squadMin/squadMax the auction will run, so tuned test auctions and
  the real config validate consistently. At N=10 against the ~2,128-player
  seed both floors clear with room (175 total / 10 GKs needed).
- seed-demo now goes through setupSeason; the old hand-inserted
  (matchweek_count 10, transfer_week 5) placeholder is test-helper-only.

## 2026-07-09 — replay viewer v0 (web) + /replay endpoint

- One Canvas 2D component (web/src/replay/) — no Pixi/Phaser for 23 dots and
  a ball. Pure playback logic (interpolation, score clock, timeline
  filtering) lives in playback.ts and is vitest-covered; the canvas is dumb.
- **Pacing**: frames are 6 sim-seconds apart (450/half). "1x" plays
  SIM_PER_REAL=12 sim-seconds per wall second — a half in ~3¾ min, a match
  in ~7½ (0.5x–4x range). Literal real-time would be 45 unwatchable minutes;
  this is the "real-ish" compromise, one constant to retune.
- Interpolation lerps between surrounding frames; gaps > 30 s snap (missing
  chunks), players present in one frame only snap (HT subs). The 6-second
  HT boundary lerp reads as a quick reset glide — acceptable at v0.
- **Embargo**: /fixture/:id/replay reuses the SAME SQL predicate as
  /result — extracted to EMBARGO_VISIBLE in league-store so the rule exists
  once. Participant post-final, everyone post-reveal, 404 otherwise (the
  results convention; not 403 — no existence leak). Tested alongside the
  result-embargo tests.
- Dot sides come from tactics_submissions (fixtureSides) — end_state does
  not carry team membership. Payload ≈ 200 kB per match (450 frames × 2,
  101 kB JSONB each); replay_frames prune after 4 matchweeks already.
- Deliberately NOT built (post-season-1): sprites/camera/commentary/clip
  export, heatmap overlay.

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
