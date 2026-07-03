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
SHRINK_M0 = 900  # z_shrunk = z · m/(m+M0): 900' → half-weight to cohort mean
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
