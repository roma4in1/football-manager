# Season 2 parking list

Good ideas that are NOT season 1. Captured so they're not lost and not built
early. Each is a real feature (new backend / calibration / capability), not UI
polish — which is why it's parked. Revisit AFTER a real season is played, when
feedback says which of these the game actually wants.

## Surfaced during the build / design conversation
- **Stat leaderboards / cross-player rankings** — top scorers, assists, ratings,
  clean sheets across the season. Data exists but needs season-long aggregation,
  ranking, embargo-aware. Single-player stats (in the squad hub) are already in
  season 1; RANKED cross-player lists are this.
- **Player-of-the-week / player-of-the-season awards** — small aggregation over
  sim ratings. Good group-chat flavor. Weekly results digest (in season 1) can
  grow this later.
- **Shareable result-card image export** — canvas capture / image gen of the
  match-detail screen for frictionless group-chat sharing. Season 1 = manual
  screenshot of the (screenshot-friendly) match screen.
- **Full opponent tactic-scouting** — seeing a rival's recent tactics/tendencies,
  not just their results/table position. New analysis view. Season 1 "scout"
  button shows basic results + position only.
- **Generated advice on home** — "your defense is thin, consider…". Analysis,
  not display. Season 1 home surfaces existing state flags only.
- **Youth academy** — the one facility deferred from the start. Needs a regen
  generator + roster-churn logic. Self-contained; add without disturbing the
  rest. Genuinely needs play-feedback to justify.
- **In-play substitutions** — currently HT-only. A documented engine gap; the
  2nd-half goal-share band is slightly low partly because of it. Would need
  live/mid-half sub logic.
- **FM-style morale / social groups / cliques** — the deeper chemistry layer
  beyond dyadic familiarity. A whole simulation surface with weak engine
  integration. Considered and deferred early.
- **Player traits / PPMs** ("cuts inside", "shoots from distance") — big tuning
  surface, marginal gain over attributes + sliders. Deferred.
- **Weather in the injury model** — near-zero gameplay signal, added
  calibration dimension. Cut early.
- **Penalty-shootout flourishes** beyond the season-1 mechanic (e.g. keeper
  mind-games, sudden-death drama presentation).
- **Mid-season dropout handling** — if a manager quits mid-season. Setup-time
  N=5–10 is handled; mid-season attrition (forfeit / auto-manage / replace) is
  a separate policy, undecided, deferred.

- **Assist tracking** — surfaced by the design pass: the player hub's season
  stats can't show assists because goal events don't carry an assister — an
  ENGINE event change (+ harness ripple), not a view. Hub ships apps/goals/
  rating/minutes.
- **Server-side named tactic presets** — the design pass ships device-local
  (localStorage) presets; named cross-device presets need a presets table.
  default_tactics remains the one server-saved plan.

- **Attribute-based pool search/filter/sort (auction + transfer market)** —
  filter the nominatable/signable pool by attribute (e.g. finishing > 15) or
  sort by one, not just name/value. Surfaced by the live-auction pool fix:
  scrolling 2k players works, but squad-building really wants attribute
  queries. Needs attribute-indexed querying over the pool (JSONB expression
  indexes or extracted columns) — a query-layer feature, not a view.

## Queued season-1 follow-ups (NOT parked — just sequenced)
- **Lineup-as-pitch** (split from the tactics-polish PR): the lineup tab
  becomes a FIFA-style visual pitch — 11 positioned players, bench beneath,
  drag on/off to sub (inherit-on-swap already exists), with formation/tactic
  PRESETS offered first as a starting point. Its own PR, after the live MW1
  match test.

## Rule for adding to this list
During the design pass (or any future work), if an idea needs a new table,
new engine behavior, or a calibration gate → it's a feature → it lands HERE,
not in the current work. If it's a new VIEW/sort/filter over data that already
exists → it's in-scope UI. That line is what keeps season 1 shipping.
