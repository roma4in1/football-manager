# Attribute derivation mapping

The reviewable contract: attribute → source metrics → transform. `derive.py`
implements exactly this table; constants live in `config.py`. Source keys are
FBref `data-stat` names from the Big-5 combined pages (cached snapshots) and
transfermarkt-datasets `players.csv` columns.

## Transform rules (applied in this order)

1. **Rates**: volume metrics are per-90 (`x / minutes_90s` of the row's own
   table); "per touch" metrics divide by `touches`. True possession-adjustment
   needs team possession, which the Big-5 player pages don't carry — noted
   as a future refinement, NOT silently approximated.
2. **Minutes floor**: players under 270 league minutes are dropped. Everyone
   else is **shrunk toward their position-group mean** (empirical Bayes):
   `z_final = w·z_player + (1−w)·z̄_group` with `w = m/(m + 900)` — at 900'
   you keep half your own signal, at 2700' three quarters.
3. **Normalization**: metric z-scores are computed **league-wide**, because
   the engine reads attribute values absolutely (a 16 finishes like a 16
   regardless of position) — within-group z would hand defenders striker-grade
   finishing. Positional identity comes from real usage differences plus the
   group-mean shrinkage target. Exceptions: GK-only attributes are z-scored
   within the GK cohort; outfield players get flat gk attributes (3).
4. **Squash to 1–20**: clamp z at ±2.5 (≈ 0.6th/99.4th percentile tails),
   then `attr = round(10.5 + z · 9.5/2.5)`, clamped to [1, 20].
5. **Confidence**: attributes derived from proxies (no direct measurement in
   the sources) are listed per player in `source_meta.low_confidence`.

## Cache caveats

The cache is human-populated (see README/DECISIONS.md) with mixed provenance.
The available captures carry **no xG/npxG columns and no aerial-duel
columns** — finishing uses conversion rates instead of np(G−xG), and
heading/jumping/strength lean on TM height + defensive volume, all flagged
low-confidence. A league page whose table is missing or empty doesn't block
the run: each affected metric is treated as missing (never zero), z-stats are
computed over players who have data, and affected players get the
position-group mean imputed + a per-player `low_confidence` flag. If richer
captures land later, only this table and `derive.py` change.

## Technical

| Attribute | Sources (weight) | Notes |
| --- | --- | --- |
| passing | `passes_pct_short`, `passes_pct_medium`, weighted by attempt volumes | **short+medium completion only** (DECISIONS.md split) |
| longPassing | `passes_pct_long` (0.7) + z(`passes_long`/90) (0.3) | completion + attempt-volume prior; never blended into `passing` |
| crossing | `crosses_into_penalty_area`/90 (0.6) + `crosses`/90 (0.4) | wide deliveries stay separate |
| vision | `assisted_shots`/90 (0.4) + `passes_into_penalty_area`/90 (0.3) + `passes_into_final_third`/90 (0.3) | |
| firstTouch | −`miscontrols`/touch (0.7) + `passes_pct` (0.3) | |
| dribbling | `take_ons_won_pct` (0.5) + `take_ons_won`/90 (0.3) + `progressive_carries`/90 (0.2) | |
| finishing | `goals_per_shot_on_target` (0.4) + `shots_on_target_pct` (0.3) + `goals_pens`/90 (0.3) | non-penalty goals; np(G−xG) once xG returns |
| heading | height z (0.6) + `clearances`/90 (0.2) + `goals_pens`/90 (0.2) | LOW confidence — no aerial columns in snapshot |
| tackling | `challenge_tackles_pct` (0.5) + `tackles_won`/90 (0.5) | |
| marking | `blocks`/90 (0.4) + `clearances`/90 (0.3) + `tackles_def_3rd`/90 (0.3) | |
| setPieceDelivery | crossing z (0.5) + vision z (0.5) | LOW confidence — no dead-ball split in Big-5 pages |

## Physical

| Attribute | Sources (weight) | Notes |
| --- | --- | --- |
| pace | `carries_progressive_distance`/carry (0.4) + `take_ons_won`/90 (0.2) + age curve peak 24 (0.4) | LOW confidence — proxy |
| acceleration | `take_ons_won`/90 (0.4) + `progressive_carries`/90 (0.2) + age curve peak 24 (0.4) | LOW confidence — proxy |
| stamina | `minutes_pct` (0.6) + age curve peak 27 (0.4) | LOW confidence — availability proxy |
| strength | height z (0.5) + −`dispossessed`/touch (0.3) + `fouls`/90 (0.2) | LOW confidence |
| jumping | height z (0.7) + `clearances`/90 (0.3) | LOW confidence — no aerials |
| agility | `take_ons_won_pct` (0.5) + −`miscontrols`/touch (0.5) | LOW confidence |
| heightCm | TM `height_in_cm`, fallback 181 + flag | factual |
| weightKg | height − 105 | estimate — TM dump has no weight; flagged |
| preferredFoot | TM `foot` (left→L, right→R, both→B), missing → R + flag | factual |
| injuryProneness | **fallback prior** (dump has NO injuries table): `10 + 0.35·(age−24) − 1.2·z(minutes_pct)`, clamp 1–20 | LOW confidence; TM injury histories were checked and absent |

## Mental

| Attribute | Sources (weight) | Notes |
| --- | --- | --- |
| decisions | `passes_pct` (0.4) + −`dispossessed`/touch (0.4) + −`errors`/90 (0.2) | |
| composure | −`errors`/90 (0.5) + −`miscontrols`/touch (0.5) | LOW confidence |
| positioning | `interceptions`/90 (0.5) + `blocked_shots`/90 (0.25) + `clearances`/90 (0.25) | |
| offTheBall | `touches_att_pen_area`/90 (0.5) + `progressive_passes_received`/90 (0.5) | |
| anticipation | `interceptions`/90 (0.6) + `blocked_passes`/90 (0.4) | |
| workRate | (`tackles`+`interceptions`)/90 (0.5) + `touches`/90 (0.3) + `minutes_pct` (0.2) | LOW confidence |
| aggression | `fouls`/90 (0.5) + `cards_yellow`/90 (0.3) + `challenges`/90 (0.2) | |

## Goalkeeping (z within GK cohort)

| Attribute | Sources (weight) |
| --- | --- |
| gkReflexes | `gk_save_pct` (0.7) + `gk_pens_save_pct` (0.3) |
| gkPositioning | `gk_clean_sheets_pct` (0.5) + −`gk_goals_against_per90` (0.5) |
| gkDistribution | GK's own `passes_pct_long` (0.6) + `passes_pct` (0.4) |

Outfield players: all three = 3 (flat).

## Join & identity

FBref Big-5 rows carry birth **year** only (full DOB would require the
per-player crawl that data-sources.md rules out), so the join key is
`unidecode(name) + birth_year`, club as tiebreaker, then a difflib fuzzy pass
(ratio ≥ 0.87) within the same birth year, then `manual-matches.csv`.
`players.birth_date` in the seed uses the TM full DOB.
`source_meta` records `{fbref_id, tm_id, join, low_confidence[], minutes}`.
