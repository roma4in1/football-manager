"""transfermarkt-datasets players.csv → the factual fields we join and seed."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Dict, List, Optional

import config
from names import normalize_club, normalize_name

FOOT_MAP = {"left": "L", "right": "R", "both": "B"}


def load_tm_players(path: Path) -> List[Dict]:
    out = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            # recent activity anywhere is enough: the fbref season includes
            # players who have since left the Big 5 (transfers, relegation)
            last_season = row.get("last_season") or "0"
            try:
                recent = int(last_season) >= config.TM_MIN_LAST_SEASON
            except ValueError:
                recent = False
            if not recent:
                continue
            dob = (row.get("date_of_birth") or "").split(" ")[0]  # '1998-12-20 00:00:00'
            if not dob:
                continue
            height: Optional[int]
            try:
                height = int(float(row["height_in_cm"])) or None
            except (ValueError, KeyError):
                height = None
            try:
                market_value = int(float(row.get("market_value_in_eur") or 0))
            except ValueError:
                market_value = 0
            out.append({
                "tm_id": row["player_id"],
                "name": row.get("name") or "",
                "norm_name": normalize_name(row.get("name") or ""),
                "birth_date": dob,
                "birth_year": dob[:4],
                "club": row.get("current_club_name") or "",
                "norm_club": normalize_club(row.get("current_club_name") or ""),
                "foot": FOOT_MAP.get((row.get("foot") or "").strip().lower()),
                "height_cm": height,
                "market_value": market_value,
            })
    return out
