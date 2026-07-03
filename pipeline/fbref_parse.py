"""FBref Big-5 table parser.

fbref cells carry data-stat attributes and the player cell carries
data-append-csv (the fbref player id), so we parse with lxml directly —
no column-order assumptions, and works identically on wayback snapshots.
Some fbref pages wrap tables in HTML comments; we unwrap before parsing.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

from lxml import html as lxml_html

TABLE_IDS = {
    "stats": "stats_standard",
    "shooting": "stats_shooting",
    "passing": "stats_passing",
    "defense": "stats_defense",
    "possession": "stats_possession",
    "misc": "stats_misc",
    "playingtime": "stats_playing_time",
    "keepers": "stats_keeper",
}

_COMMENT_TABLE = re.compile(r"<!--(?=[\s\S]*?<table)", re.I)


def _uncomment(page_html: str) -> str:
    """fbref hides some tables inside comments — expose them for the parser."""
    return _COMMENT_TABLE.sub("", page_html).replace("-->", "")


def parse_players(page_html: str, table_id: str) -> List[Dict[str, str]]:
    """One dict per player row: {data-stat: text, 'fbref_id': …}."""
    doc = lxml_html.fromstring(_uncomment(page_html))
    tables = doc.xpath(f'//table[@id="{table_id}"]')
    if not tables:
        raise ValueError(f"table #{table_id} not found")
    rows = []
    for tr in tables[0].xpath(".//tbody/tr"):
        if "thead" in (tr.get("class") or ""):
            continue  # repeated header rows
        row: Dict[str, str] = {}
        fbref_id: Optional[str] = None
        for cell in tr.xpath("./th|./td"):
            stat = cell.get("data-stat")
            if not stat:
                continue
            row[stat] = cell.text_content().strip()
            if cell.get("data-append-csv"):
                fbref_id = cell.get("data-append-csv")
            elif stat == "player" and fbref_id is None:
                href = cell.xpath(".//a/@href")
                if href:
                    m = re.search(r"/players/([0-9a-f]{8})/", href[0])
                    if m:
                        fbref_id = m.group(1)
        if fbref_id and row.get("player"):
            row["fbref_id"] = fbref_id
            rows.append(row)
    return rows


def num(row: Dict[str, str], key: str, default: float = 0.0) -> float:
    raw = row.get(key, "")
    if raw in ("", None):
        return default
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return default
