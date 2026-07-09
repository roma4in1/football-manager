# Feature 6b — pre-auction budget split + reserve growth

A season-strategy lever, queued as a feature PR with its own calibration gate.
NOT a design-pass detail — it changes club_seasons, the auction, and needs the
compounding harness. Build after season rollover (#6).

## The mechanic
Before the draft, each club splits its total pot:
- **Bring-to-auction:** spent on bids. FIXED once the draft starts — this is
  the bidding balance, which keeps the auction's budget checks race-free (and
  resolves the earlier "facilities in the auction, A vs B" question cleanly:
  facilities are NOT bought during the draft; the split pre-commits the
  bidding balance, facilities come after from the reserve).
- **Reserve:** held back, GROWS by X% (the incentive to not just bring
  everything), spendable ONLY on facilities + the mid-season transfer window
  — never re-entered into auction bidding (that would be delayed spending with
  free interest = pure exploit).

## Why it needs an incentive (the design insight)
Without reserve growth, the rational manager brings everything every time and
the split screen is dead UI. The growth rate is the reason to reserve. But the
rate is a knife-edge:
- Too low (~5%): nobody reserves, mechanic is inert.
- Too high (~50%): everybody hoards, drafts skeleton squads, banks, and the
  hoarder snowballs into a next-season war chest — the compounding failure mode.
- Sweet spot: reserving is a LIVE choice against a purpose (facilities /
  mid-season reinforcement), never always-correct.

## The strategic fork it creates
- Bring it all → strong squad NOW, contend this season, nothing banked.
- Reserve some → weaker draft, but a war chest for a mid-season signing (when
  you know your squad's holes) + facility investment that compounds next season.
Squad-now vs war-chest-later. A legible strategy declaration at the most
dramatic moment (right before the draft), and clubs arrive at the auction with
DIFFERENT spending power by choice → richer, more varied bidding.

## Constraints that prevent the exploit
- Reserve cannot re-enter auction bidding (else it's free-interest delayed
  spending).
- Reserve spendable only on facilities + mid-season window.
- Split BINDS — lean toward hard-ish (a real commitment; leftover auction
  money has limited use / converts to reserve at a fixed rate), not soft
  (free flow back = the decision is theater).

## Calibration gate (the hard part — like the training PR)
X (reserve growth rate) is CALIBRATED against the growth-compounding harness,
not guessed. The harness already tests facility snowball; reserve → facilities
→ growth feeds the same path. Model before shipping: does rate X make
"draft lean, hoard, bank" a dominant cross-season strategy that breaks league
competitiveness? If +15% makes "draft 11, bank everything, win season 3 by a
mile" optimal, the harness catches it and X gets cut. Report the multi-season
trajectory at min/max reserve strategies, same as the training PR reported
facility min/max.

## Rough scope
- club_seasons: a split field (bring vs reserve) + reserve balance.
- Pre-auction split screen (the UI) — but functional-first; styling in the
  design pass.
- Enforce the fixed bidding balance in the auction (bidding-balance = brought,
  not total).
- Reserve growth applied at the right tick (per season? per the mid-season
  window?) — decide and document.
- Facility + mid-season-window budget checks read the reserve, not the total.
- Harness: reserve-strategy compounding run, gated in CI like growth.

## Acceptance
Budget split live and binding; reserve growth rate calibrated with the
multi-season competitiveness trajectory reported; "hoard and snowball" proven
NOT dominant; auction bidding balance fixed (race-free); CI green including the
reserve-compounding gate; DECISIONS.md records the split bindingness, the
reserve-spend constraints, the growth rate + its calibration, and the
now-vs-later design rationale.
