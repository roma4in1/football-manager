# Design brief — visual + interaction direction

Captured from design conversation. To be applied in the design pass AFTER the
feature set freezes (post season-rollover). Not built yet.

## Visual identity
- **Clean, light, modern** — NOT the dark/saturated broadcast-sim look
  (FIFA/FM). Lighter, calmer, more modern-app feel. Reads native, not
  console-imitation.
- Flat surfaces, restrained color, generous whitespace. Color encodes meaning
  (position groups, status), not decoration.

## Orientation & layout
- **Always landscape.** Phone held sideways for every screen — one consistent
  orientation, no rotation prompts, "console game" feel.
- **Two-pane / master-detail** is the core landscape idiom: list/browse on one
  side, detail/action on the other. Suits a management game (browse a list,
  act on a detail) and uses the width as a strength.
- **Persistent side-nav** (left rail of section icons) instead of a bottom tab
  bar — the wide format has room for always-visible nav.
- **Density risk to verify early:** landscape phones are SHORT (~375px tall).
  The densest screens (tactics editor, auction) must fit without vertical-
  scroll fighting the layout. Check the auction specifically — list + detail +
  budget + timer in ~375px height is the tightest fit in the app.

## Pitch editor (the load-bearing screen)
The one screen where visual design and functional design are the same problem —
it must COMMUNICATE probabilistic spatial influence, not just collect input.
- **Anchor = center of gravity, not a fixed pin.** Render as a dot inside a
  soft radius/halo that says "tends here, drifts toward ball and space,
  returns here." A hard crisp marker would imply obedience and make managers
  rage when players drift. This is the single most important thing the editor
  must get across, because instructions INFLUENCE (~60-80% adherence, attribute-
  gated) — they never fully control. Setting that expectation visually is the
  design's main job.
- **6 phase tabs** (buildUp, progression, finalThird, defensiveBlock,
  counterPress, counterAttack) — switching phases morphs the whole team's
  shape. Phase-switching is the primary interaction; the 6-phase dynamism is
  the tactical differentiator and must be visible/scrubable.
- **Selected player prominent, others faded** (~0.3 opacity dots), tappable to
  promote. Gives single-player detail + team-shape context in one screen.
- **Per-phase sliders alongside** the pitch (risk, hold, press, shoot, dribble,
  cross) — spatial + behavioral tuning together for the phase being edited.
- **Zones drawn with visible weight** (e.g. "run target · 0.7") — strength of
  influence legible, not just direction.

## Player-to-role model (editor UX)
- The manager places a SPECIFIC player into a spot and tunes how he plays.
  Under the hood the tactical config (6-phase anchors + sliders + zones)
  attaches to the ROLE/slot, and a player is assigned to it. Manager thinks
  "I put Bennacer here"; the data lets the config outlive Bennacer being there.
- **Inherit-on-swap:** when player B replaces player A in a slot (sub, injury
  replacement, rotation), B inherits A's tactical config by default, then can
  be tweaked. Makes rotation non-tedious. Matches the engine's already-player-
  keyed PlayerTactic.

## Presets (schema addition when built)
- **Phase presets:** save a single phase's anchor+slider config, reusable
  across players/seasons — speeds up BUILDING a tactic.
- **Full-tactic presets:** the whole 6-phase × 11-player plan, named, swappable
  per fixture — speeds up SWITCHING tactics matchday to matchday. Half-exists
  as default_tactics.

## Auction screen (three-pane landscape)
- **Center:** the live lot — auctioning player's stats, current high bid,
  bid/raise buttons, soft-close timer counting down (visible extension on bid).
  Focal point, biggest/center — urgency lives here.
- **Left:** squad progress toward squadMin, position breakdown with "thin"
  warnings so a manager doesn't overspend while short a position.
- **Right:** budget + wage room. Facility-buying does NOT happen here (see
  6b decision) — with the pre-auction budget split, bidding balance is FIXED
  during the draft (clean, no mid-lot budget race), and facilities are bought
  post-auction from the reserved pot. Right pane is budget display, not invest
  buttons.
- **Bid-time stats:** position-aware summary (6-8 attributes that matter for
  the player's role), full ~26-attribute profile on tap. 26 stats don't fit a
  bid-timer screen.

## Still to sketch (future design conversation)
squad/lineup, results/match, standings, transfers, facilities, the training
screen (shipped functional in #18, needs the design-pass styling). All in the
same clean/light, always-landscape, two-pane language.

## Sequencing note
None of this is built until the feature set freezes (after season rollover +
budget-split 6b). The design pass styles final screens in ONE coherent go —
not screen-by-screen bolted onto feature PRs — so the identity reads
intentional, not patchwork.
