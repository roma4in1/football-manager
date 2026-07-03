"""Pipeline constants — the single tuning surface (DECISIONS.md).

Everything a reviewer might want to nudge lives here; the transform code in
derive.py reads these and MAPPING.md documents how they are applied.
"""

# ── sources ──────────────────────────────────────────────────────────────────

# pinned to the last COMPLETED season (immutable → reproducible), fetched
# PER LEAGUE: the Big-5 combined pages lost their provider columns in the
# late-2025 fbref data-provider change, while per-league season pages have
# intact archived copies from before the cutoff (see FBREF_SNAPSHOT_BEFORE).
FBREF_SEASON = "2024-2025"
FBREF_LEAGUES = [
    (9, "Premier-League"),
    (12, "La-Liga"),
    (11, "Serie-A"),
    (20, "Bundesliga"),
    (13, "Ligue-1"),
]
FBREF_BASE = (
    "https://fbref.com/en/comps/{comp_id}/" + FBREF_SEASON + "/{page}/" + FBREF_SEASON + "-{league}-Stats"
)
FBREF_PAGES = ["stats", "shooting", "passing", "defense", "possession", "misc", "playingtime", "keepers"]
# snapshot preference window: the provider change emptied advanced columns on
# snapshots taken from ~Jan 2026; data is intact through late Dec 2025. The
# fetcher VALIDATES content and walks older snapshots when a capture is empty.
FBREF_SNAPSHOT_BEFORE = "20260101"
# when a 2024-25 league page has NO populated archive at all, fall back to the
# same league's in-season 2025-26 page (Nov/Dec 2025 captures are intact and
# carry ~15 matchweeks of per-90 sample). Season-mix noise is accepted and
# noted in MAPPING.md.
FBREF_FALLBACK_SEASON = "2025-2026"

# fbref publishes a 10 req/min bot budget; stay under it with headroom
FBREF_SECONDS_BETWEEN_REQUESTS = 6.5
FBREF_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# 'live' hits fbref.com directly (residential IPs pass their Cloudflare);
# 'wayback' primes the cache from web.archive.org snapshots when live is
# blocked (datacenter IPs commonly are). Cached HTML is identical either way.
FBREF_MODE = "live"  # overridden by env FBREF_MODE

# transfermarkt-datasets open dump (player-scores file set), mirrored on
# Hugging Face — no scraping, no auth. NOTE: the dump has NO injuries table,
# so injuryProneness uses the age + minutes-load prior (see MAPPING.md).
TM_PLAYERS_URL = "https://huggingface.co/datasets/ngeorgea/transfermarkt-player-scores/resolve/main/players.csv"

# Big-5 domestic competitions in the TM dump
TM_BIG5_COMPETITIONS = {"GB1", "ES1", "IT1", "L1", "FR1"}
TM_MIN_LAST_SEASON = 2024  # keep recently active players only

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
