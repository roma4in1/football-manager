"""Cache layout + preflight. THE PIPELINE NEVER TOUCHES THE NETWORK.

Fetching is a human step (DECISIONS.md): fbref's CDN blocks automation and
the wayback record proved unreliable after fbref's late-2025 provider change,
so a person saves the pages from a browser into pipeline/cache/:

  fbref_{League}_{page}.html   for each league × page below
  tm_players.csv               players.csv from the transfermarkt-datasets dump

Files are mixed provenance (curl / wayback / browser "Save Page As") — the
parser handles fbref tables both inside HTML comments and in the live DOM.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

import config
from fbref_parse import TABLE_IDS, parse_players

CACHE = Path(__file__).parent / "cache"

# one marker column per page — used to tell a populated table from an empty
# shell (fbref's provider change left some pages rendering blank columns)
PAGE_MARKERS = {
    "stats": "minutes", "shooting": "shots", "passing": "passes_pct_long",
    "defense": "tackles", "possession": "carries", "misc": "fouls",
    "playingtime": "minutes_pct", "keepers": "gk_saves",
}


def fbref_page_path(league: str, page: str) -> Path:
    return CACHE / f"fbref_{league}_{page}.html"


def tm_players_path() -> Path:
    return CACHE / "tm_players.csv"


def verify_cache() -> Tuple[List[str], List[str]]:
    """Returns (missing, empty) league/page identifiers; prints a summary.

    Missing or empty pages don't block the run — derivation imputes the
    position-group mean for affected metrics and flags them low-confidence —
    but coverage gaps should be filled by re-saving the page from a browser.
    """
    missing: List[str] = []
    empty: List[str] = []
    for _, league in config.FBREF_LEAGUES:
        for page in config.FBREF_PAGES:
            path = fbref_page_path(league, page)
            if not path.exists():
                missing.append(f"{league}/{page}")
                continue
            try:
                rows = parse_players(path.read_text(), TABLE_IDS[page])
            except ValueError:
                empty.append(f"{league}/{page}")
                continue
            populated = sum(1 for r in rows if (r.get(PAGE_MARKERS[page]) or "").strip())
            if populated < max(1, len(rows) // 2):
                empty.append(f"{league}/{page}")
    if not tm_players_path().exists():
        missing.append("tm_players.csv")
    if missing:
        print(f"CACHE GAPS — missing: {', '.join(missing)}")
    if empty:
        print(f"CACHE GAPS — empty tables (affected metrics will be imputed): {', '.join(empty)}")
    return missing, empty
