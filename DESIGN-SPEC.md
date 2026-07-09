# Design spec — season 1 UI

Complete, bounded spec for the design pass. Built on DESIGN-BRIEF.md (visual
identity, always-landscape, two-pane idiom, pitch-editor gravity language).
This spec fixes the nav model and every screen's contents. The design pass
EXECUTES this — it does not invent scope. New ideas surfacing during the pass
go to SEASON-2-PARKING.md, not into these screens.

## Visual identity (from DESIGN-BRIEF.md)
Clean, light, modern — NOT dark/broadcast. Always landscape. Two-pane
master-detail. Persistent left-rail nav. Flat surfaces, restrained color,
color encodes meaning. Density check: landscape phones ~375px tall — the hero
element of each screen never scrolls; secondary columns scroll within their box.

## Navigation — 5 sections, left rail
Organizing principle: triage / manage / deploy / invest / compete.

- **home** — triage: this week, attention, last results
- **squad** — manage: player hub + training focus dial
- **tactics** — deploy: pitch editor, lineups, presets, team instructions
- **market** — invest: auction, transfer window, facilities, budget split
- **season** — compete: results/replay, standings, bracket

Market is contextual: quiet most weeks (browse pool, tweak facilities), LOUD
when a window opens (auction / mid-season) — unmissable rail badge so no window
is missed.

## Screens

### home (3 states: action-needed / waiting / reveal-day)
Two-column. HERO (never scrolls): current fixture card — opponent, home/away,
deadline countdown (warning color as it nears), opponent submission status,
primary "set your lineup" button, secondary "scout opponent" (basic: their last
results + table position; full tactic-scouting is season-2). Secondary column
(scrollable boxes): "needs attention" — surfaces EXISTING state only
(suspensions, affordable facility, training-set confirmation) — NO generated
advice. Below: "last week revealed" — your result + table movement, embargo-
respecting. Waiting state: fixture card flips to "submitted, waiting" + button
changes. Reveal-day: results digest prominent.

### squad — player hub
Two-pane. List left: name, position, fitness + sharpness bars, injury/
suspension badges. Detail right: 26 attributes (grouped technical/physical/
mental), contract (wage, duration remaining), fitness/sharpness/injury status,
season stats (apps, goals, assists, avg rating), growth trajectory (attribute
changes over seasons from attribute_audit — a multi-season delight, in-scope as
a view). Training focus dial lives here (direct development; buying the facility
level is in market).
NOTE: single-player stats here = in-scope. Cross-player ranked leaderboards =
season-2.

### tactics
- Pitch editor (SKETCHED): 6-phase tabs; selected player shows gravity-halo
  anchor (attractor not command) + zones (runTarget/operating/pressing, drawn,
  weighted) + per-player sliders (risk/hold/press/shoot/dribble/cross). The
  OTHER 10 players render as PLAIN FADED DOTS at their current-phase anchor
  only — no halos, no zones. Tap a faded dot to promote it to selected (its
  detail appears, prior selection fades to a dot). Exactly one detailed player
  at a time. Player-to-role slots, inherit-on-swap.
- Lineup/bench: assign players to 11 role-slots + ≤9 bench, two-bar fitness
  per player, live eligibility mirror.
- Presets: phase presets + full-tactic presets (save/load).
- Team instructions: the 6 team-wide sliders (lineHeight, width, compactness,
  pressTrigger, counterPressDuration, tempo) — SEPARATE surface within tactics,
  NOT folded into the editor.

### market (contextual)
- Auction (SKETCHED): three-pane — center live lot (player stats, high bid,
  bid/raise, soft-close timer); left squad progress (toward squadMin, position
  thin-warnings); right budget (fixed bidding balance — no facility buttons
  here, per the pre-committed split). Bid-time stats = position-aware summary,
  full profile on tap.
- Transfer window: browse other clubs' squads + free-agent pool, make/respond
  to offers, first-come pool signings at market value.
- Facilities investment: training + medical levels, cost-per-level, benefit
  shown (+growth / −injuries). This is the BUY-THE-LEVEL action.
- Budget split (pre-auction): bring/reserve slider, reserve-growth rate shown,
  constraint stated, locks on first bid.

### season
- Results: matchweek list, scores (post-reveal only), tap → match detail.
- Match detail (SKETCHED): score header always visible; 3 tabs —
  timeline (lands first: event rows with minute/icon/readable line, "watch"
  jump-buttons on goals), replay (the canvas viewer, scrub-bar with the same
  moments as jump markers — tap a goal to cue playback 6s before), stats
  (team-level: possession/shots/xG/ratings). Embargo-gated: replay/detail only
  where allowed (participant post-final, others post-reveal). Individual player
  stats are NOT here — they're in the squad player hub.
- Standings: league table (pos, P, W/D/L, GD, pts), your row highlighted,
  revealed weeks only.
- Bracket: playoff structure — seeds, semi legs + aggregate, neutral final,
  shootout result if any, champion banner. Revealed-only.

## Replay lives in match detail, reached from:
1. season → results → tap match → replay tab
2. home → last week revealed → your match shortcut
Same match-detail screen both routes. Embargo-gated wherever it appears.

## Palette (color = meaning)
- Position groups: assign 4 distinct hues (GK/DF/MF/FW) — used on dots, list
  rows, slots.
- Status: fit (neutral/green), injured (red), suspended (amber), unsharp
  (muted). Consistent everywhere a player appears.
- Selection/accent: the purple used in sketches (#534AB7 family).
Design pass proposes exact stops; keep to ≤ the identity's restraint.

## Explicitly SEASON-2 (do NOT build in the design pass)
Stat leaderboards / cross-player rankings, player-of-week/season awards,
shareable result-card image export, full opponent tactic-scouting, any
"generated advice" on home, formation/role preset LIBRARIES (beyond user-saved
presets). See SEASON-2-PARKING.md.

## What the design pass delivers
Styles + makes-usable these screens in the clean/light always-landscape
two-pane language. Functional screens already exist (built through PRs
1–21); this is the visual + interaction polish pass, screen by screen, to one
coherent identity. Not new capabilities.
