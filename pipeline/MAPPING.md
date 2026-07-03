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

## Sources & vintage

**CSV-first.** fbref's provider change gutted the passing/defense/possession
HTML tables at the source (current and historical pages render empty), so the
primary source is a human-downloaded **2024-25 Big-5 season dump**
(worldfootballR_data release or Kaggle equivalent) dropped into
`cache/csv/`. One coherent vintage — every stat from the completed 2024-25
season; no season mixing within a player. The HTML parser remains as a
fallback for any stat type the dump lacks; if CSV and HTML types ever mix in
one run, `source_meta.sources` records which stat types came from which
source (otherwise the field is omitted).

### CSV schema (worldfootballR shape; Kaggle variants via aliases)

One file per stat type (auto-detected from headers). Identity columns:
`Player`, `Born` (birth year), `Squad`, `Comp`, `Pos`, `Age`,
`Season_End_Year` (rows filtered to 2025), `Url` (fbref player id). Stat
columns per type — canonical key ← dump column:

| type | canonical ← dump |
| --- | --- |
| stats | minutes ← `Min_Playing_Time`, minutes_90s ← `Mins_Per_90_Playing_Time`, goals_pens ← `G_minus_PK`, npxg ← `npxG_Expected` |
| shooting | shots ← `Sh_Standard`, shots_on_target_pct ← `SoT_percent_Standard`, goals_per_shot_on_target ← `G_per_SoT_Standard` |
| passing | passes[_pct]_{short,medium,long} ← `Att/Cmp_percent_{Short,Medium,Long}`, assisted_shots ← `KP`, passes_into_final_third ← `Final_Third`, passes_into_penalty_area ← `PPA`, crosses_into_penalty_area ← `CrsPA` |
| defense | tackles ← `Tkl_Tackles`, tackles_won ← `TklW_Tackles`, challenge_tackles_pct ← `Tkl_percent_Challenges`, blocks/`Sh`/`Pass` ← `*_Blocks`, interceptions ← `Int`, clearances ← `Clr`, errors ← `Err` |
| possession | touches ← `Touches_Touches`, touches_att_pen_area ← `Att_Pen_Touches`, take_ons_won[_pct] ← `Succ[_percent]_Take_Ons`, carries ← `Carries_Carries`, prog distance/carries ← `PrgDist/PrgC_Carries`, miscontrols/dispossessed ← `Mis/Dis_Carries`, progressive_passes_received ← `PrgR_Receiving` |
| misc | fouls ← `Fls_Performance`, cards_yellow ← `CrdY_Performance`, crosses ← `Crs_Performance`, aerials_won[_pct] ← `Won[_percent]_Aerial_Duels` |
| playingtime | minutes_pct ← `Min_percent_Playing_Time` |
| keepers | gk_saves/save_pct/cs_pct/ga90/pens ← `Saves`, `Save_percent`, `CS_percent`, `GA90`, `Save_percent_Penalty_Kicks` |

Headers are slugged before lookup (`%`→percent, `+`→plus); unmapped columns
are ignored and unpopulated canonical keys are printed by the schema report.

### Missing data (either source)

A metric absent for a player is treated as missing (never zero): z-stats are
computed over players who have data, and affected players get the
position-group mean imputed + a per-player `low_confidence` flag. The CSV
dump carries aerials and npxG (the gutted HTML pages don't) — the blends
below include them; when the source lacks them the weights renormalize.

## Technical

| Attribute | Sources (weight) | Notes |
| --- | --- | --- |
| passing | `passes_pct_short`, `passes_pct_medium`, weighted by attempt volumes | **short+medium completion only** (DECISIONS.md split) |
| longPassing | `passes_pct_long` (0.7) + z(`passes_long`/90) (0.3) | completion + attempt-volume prior; never blended into `passing` |
| crossing | `crosses_into_penalty_area`/90 (0.6) + `crosses`/90 (0.4) | wide deliveries stay separate |
| vision | `assisted_shots`/90 (0.4) + `passes_into_penalty_area`/90 (0.3) + `passes_into_final_third`/90 (0.3) | |
| firstTouch | −`miscontrols`/touch (0.7) + `passes_pct` (0.3) | |
| dribbling | `take_ons_won_pct` (0.5) + `take_ons_won`/90 (0.3) + `progressive_carries`/90 (0.2) | |
| finishing | np(G−xG)/90 (0.3) + `goals_per_shot_on_target` (0.3) + `shots_on_target_pct` (0.2) + `goals_pens`/90 (0.2) | npxG term active with the CSV dump; renormalizes without it |
| heading | `aerials_won_pct` (0.3) + `aerials_won`/90 (0.2) + height z (0.3) + `clearances`/90 (0.1) + `goals_pens`/90 (0.1) | LOW confidence only when aerials absent |
| tackling | `challenge_tackles_pct` (0.5) + `tackles_won`/90 (0.5) | |
| marking | `blocks`/90 (0.4) + `clearances`/90 (0.3) + `tackles_def_3rd`/90 (0.3) | |
| setPieceDelivery | crossing z (0.5) + vision z (0.5) | LOW confidence — no dead-ball split in Big-5 pages |

## Physical

| Attribute | Sources (weight) | Notes |
| --- | --- | --- |
| pace | `carries_progressive_distance`/carry (0.4) + `take_ons_won`/90 (0.2) + age curve peak 24 (0.4) | LOW confidence — proxy |
| acceleration | `take_ons_won`/90 (0.4) + `progressive_carries`/90 (0.2) + age curve peak 24 (0.4) | LOW confidence — proxy |
| stamina | `minutes_pct` (0.6) + age curve peak 27 (0.4) | LOW confidence — availability proxy |
| strength | `aerials_won_pct` (0.25) + height z (0.35) + −`dispossessed`/touch (0.25) + `fouls`/90 (0.15) | LOW confidence |
| jumping | `aerials_won_pct` (0.3) + height z (0.5) + `clearances`/90 (0.2) | LOW confidence |
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
`unidecode(name) + birth_year`. Club agreement is a TIEBREAKER, never a
requirement — the dump's clubs are a season older than TM's current clubs —
so token-sort / subset / surname candidates that are UNIQUE within the birth
year match on their own; then a difflib fuzzy pass (ratio ≥ 0.87) within the
same birth year, then `manual-matches.csv`.
`players.birth_date` in the seed uses the TM full DOB.
`source_meta` records `{fbref_id, tm_id, join, low_confidence[], minutes}`.
