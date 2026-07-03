# Calibration reference — target bands for the agent engine

Harness compares batch-sim aggregates (n ≥ 500 matches) against these bands.
Confidence: **[V]** verified from published research/data · **[K]** well-established
analytics knowledge, re-verify against current FBref season aggregates when the
pipeline lands · **[D]** definitional.

## Match-level distributions
- Goals per match: 2.6–2.9 (top-5 league averages) [K]
- Scoreline distribution: near-Poisson with slight draw inflation;
  0-0 share 6–9%, draw share 23–27% [K]
- Home advantage: home win 43–46%, away win 28–31% [K]
- Shots per team per match: 11–14; on target 3.5–5 [K]
- xG per shot (mean): 0.09–0.12 [K]
- Possession: 50/50 by construction across the league [D]; within-match spread —
  stddev of possession split ≈ 6–9 pts [K]

## Passing & buildup
- Team pass completion: 78–86% league range (style-dependent; league mean ~82%) [K]
- Passes per match per team: 400–600 [K]
- Progressive passes: ~40–60 per team per match [K] — pull exact band from FBref
- Long-ball share of passes: 8–14% [K]

## Pressing & defense
- PPDA league mean: ~10–13; aggressive pressing sides 7–9, deep blocks 15+ [K]
- Field tilt: correlates with possession, r ≈ 0.7+; use as sanity pair, not
  independent target [K]
- Tackles + interceptions per team per match: 25–40 [K]
- Fouls per team: 10–13; yellows ~1.8–2.2, reds ~0.08–0.12 per team per match [K]

## Aerial / ball-flight (z-axis mechanic)
- Crosses per team per match: 15–20 attempted; completion 20–27% [K]
- Aerial duels per match (both teams): 30–50; win rate 50% by construction [D],
  but distribution across players must skew with height/jumping — check spread
- Headed-goal share of all goals: 15–20% [K]
- Set-piece goal share (incl. pens): 25–33% [K] — the reason set pieces can't
  be skipped even in v1

## Injuries (feeds injury model base rates)
- Match injury incidence: ~21–27 per 1000 match hours (recent seasons ~21) [V]
  → per player per match ≈ 1.5h × 21/1000 ≈ 3.2% baseline before modifiers
- Training incidence ~3.4/1000h [V] — we don't sim training; fold into a small
  between-matchweek background rate if desired, or skip
- Expected injuries: ~2 per player-season; ~50 per 25-man squad-season in real
  football [V] — our season is shorter, scale by matchweeks
- Severity: median layoff ~13 days for hamstrings (most common class) [V];
  model severity as lognormal-ish, median ~10–14 days, long tail
- Re-injury: first match after return carries ~1.9× injury risk [V] — cheap,
  high-flavor modifier; recommend including

## Fatigue (no clean public reference — internal consistency targets)
- Outfield high-intensity output declines measurably in final 15–20 min [K]
- Target: sim players at fatigue >0.8 should show degraded arrival times such
  that late-game goal share rises; real football sees ~52–56% of goals in 2nd
  half [K] — use as the observable proxy

## Per-instruction sanity sweeps (engine-internal, no external reference)
For each slider swept min→max over fixed opponents:
- riskAppetite ↑ → turnovers ↑ AND chance quality ↑ (both, or the slider is broken)
- pressingIntensity ↑ → PPDA ↓ AND fatigue rate ↑ AND space-behind conceded ↑
- lineHeight ↑ → opponent long-ball share ↑, offsides ↑ (needs offside in event set — currently missing from MatchEventType; add)
- crossBias ↑ → aerial duels ↑, headed-goal share ↑, open-play ground xG ↓

## Harness output contract
Per batch: JSON report {metric, sim_value, target_band, pass|fail}, plus flagged
distribution plots for anything outside band. Every engine PR runs the batch.
