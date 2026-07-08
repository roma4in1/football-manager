"""Pipeline constants — the single tuning surface (DECISIONS.md).

Everything a reviewer might want to nudge lives here; the transform code in
derive.py reads these and MAPPING.md documents how they are applied.
"""

# ── cache layout (fetching is a HUMAN step — see cachefiles.py) ─────────────

FBREF_LEAGUES = [
    (9, "Premier-League"),
    (12, "La-Liga"),
    (11, "Serie-A"),
    (20, "Bundesliga"),
    (13, "Ligue-1"),
]
FBREF_PAGES = ["stats", "shooting", "passing", "defense", "possession", "misc", "playingtime", "keepers"]

# transfermarkt-datasets players.csv filter: keep recently active players from
# anywhere (the fbref season includes since-departed Big-5 players)
TM_MIN_LAST_SEASON = 2024

# ── join ─────────────────────────────────────────────────────────────────────

# fbref Big-5 aggregate rows carry birth YEAR only (full DOB would need the
# per-player crawl data-sources.md rules out) → join key is name+birthyear.
FUZZY_MIN_RATIO = 0.87  # difflib ratio floor for the fuzzy fallback
AUTO_MATCH_TARGET = 0.95

# ── derivation (MAPPING.md documents usage) ─────────────────────────────────

MINUTES_HARD_FLOOR = 270  # below this, drop the player entirely (3 matches)
# Minutes shrinkage prior. Was 900; the compression-budget diagnosis (PR #8
# realism harness → DECISIONS.md) showed this stage removed 24-42% of
# attribute spread — the dominant compressor — while the per-metric attempt
# shrinkage (added later) already suppresses the small-sample flukes this
# constant was originally sized for. 450' → a 2700' starter keeps 86% of his
# signal, a 900' squad player 67%, a 450' fringe player half.
SHRINK_M0 = 450

# Blended attribute z-scores have σ ≈ 0.4–0.9 (multi-metric averaging cancels
# scale), so the 1–20 squash never used its range: elite passing topped out at
# 16. Attribute z is normalized to UNIT variance before shrinkage — the 1–20
# scale then expresses the league distribution of the attribute, with real
# outliers reaching 18–20. Proxy-heavy attributes (jumping σ 0.39, strength
# 0.43, pace 0.52) get the gain CAPPED so imputation noise is not inflated
# into fake discrimination.
ATTR_NORM_MAX_GAIN = 1.8

# GK cohort separation (MAPPING rule 3): GKs get a flat low baseline on every
# outfield attribute and are EXCLUDED from the outfield z-distributions —
# symmetric to outfielders' flat gk attributes (OUTFIELD_GK_ATTR in derive.py).
GK_OUTFIELD_ATTR = 3

# Per-metric attempt-count shrinkage (MAPPING rule 2b — distinct from the
# minutes shrinkage above, which it does NOT replace): each RATE metric is
# shrunk toward its cohort's attempt-weighted mean with weight n/(n+k), where
# n is that metric's own attempt count. k = attempts at which a player keeps
# half their own signal. Reasoning per family:
#   - pass completion %s: high-volume events; a regular takes ~60 short+medium
#     attempts in ~2 matches, so k=60 (overall pass% k=80, slightly stickier;
#     long passes are rarer, k=25 ≈ 4-5 matches of switches).
#   - take-on / aerial / challenge %s: contested-duel rates stabilize slowly
#     and 5/10 samples are common — k=25 means 10 attempts keep only 29%.
#   - shooting rates: shots are scarce (k=25 ≈ 8 matches for a midfielder);
#     goals-per-SoT has the smallest denominators of all, k=12.
SHRINK_PRIORS = {
    "pass_sm_pct": 60,
    "pass_pct": 80,
    "pass_long_pct": 25,
    "takeon_pct": 25,
    "aerials_won_pct": 25,
    "challenge_pct": 25,
    "sot_pct": 25,
    "gpsot": 12,
}

# Possession adjustment (MAPPING rule 1): possession-page VOLUME metrics are
# normalized to a 50%-possession baseline when team possession is available
# (a big5_team possession CSV in cache/csv/ — see load_team_possession).
POSS_ADJUST_BASELINE = 50.0
Z_CLAMP = 2.5  # clamp z at ±2.5 (~0.6/99.4 pctile tails) before squashing
SQUASH_CENTER = 10.5
SQUASH_SCALE = 9.5 / Z_CLAMP  # ±2.5σ maps onto 1..20

# longPassing = completion 0.7 + attempt-volume prior 0.3 (DECISIONS.md split)
LONG_PASS_COMPLETION_W = 0.7
LONG_PASS_VOLUME_W = 0.3

# age curve for the proxied physicals (pace/acceleration/stamina)
PACE_AGE_PEAK = 24
PACE_AGE_SLOPE = 0.09  # z-penalty per year beyond peak
STAMINA_AGE_PEAK = 27
STAMINA_AGE_SLOPE = 0.06

# injuryProneness fallback prior (no injuries table in the TM dump):
# base 10, +0.35 per year over 24, −1.2 · minutes-share z (durable = plays a lot)
INJURY_BASE = 10.0
INJURY_AGE_SLOPE = 0.35
INJURY_MINUTES_WEIGHT = 1.2

DEFAULT_HEIGHT_CM = 181  # TM height missing → flag low confidence
