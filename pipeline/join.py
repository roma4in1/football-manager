"""FBref ↔ transfermarkt join.

Key: normalized name + birth YEAR (Big-5 rows carry no full DOB), club as
tiebreaker, difflib fuzzy fallback within the same birth year, then the
hand-maintained manual-matches.csv. Emits an unmatched report.
"""

from __future__ import annotations

import csv
import difflib
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import config
from names import clubs_match


def load_manual_matches(path: Path) -> Dict[str, str]:
    """fbref_id → tm_id overrides, maintained by hand."""
    if not path.exists():
        return {}
    with open(path, newline="", encoding="utf-8") as fh:
        return {r["fbref_id"]: r["tm_id"] for r in csv.DictReader(fh) if r.get("fbref_id") and r.get("tm_id")}


def _tokens(norm_name: str) -> frozenset:
    return frozenset(norm_name.split())


def join_players(
    fbref_players: List[Dict],  # needs: fbref_id, norm_name, birth_year, norm_club, name
    tm_players: List[Dict],
    manual: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, Dict], List[Dict]]:
    """Returns (fbref_id → {tm row + join kind}, unmatched fbref rows).

    Ordered passes, birth year required throughout; club required where the
    signal is weak (subset/surname passes). Kinds: manual, exact, token_sort,
    subset, surname_club, fuzzy.
    """
    manual = manual or {}
    tm_by_id = {t["tm_id"]: t for t in tm_players}
    by_name_year: Dict[Tuple[str, str], List[Dict]] = defaultdict(list)
    by_sorted_year: Dict[Tuple[str, str], List[Dict]] = defaultdict(list)
    by_year: Dict[str, List[Dict]] = defaultdict(list)
    for t in tm_players:
        by_name_year[(t["norm_name"], t["birth_year"])].append(t)
        by_sorted_year[(" ".join(sorted(t["norm_name"].split())), t["birth_year"])].append(t)
        by_year[t["birth_year"]].append(t)

    def pick_by_club(candidates: List[Dict], norm_club: str) -> Dict:
        same_club = [t for t in candidates if clubs_match(t["norm_club"], norm_club)]
        return same_club[0] if same_club else candidates[0]

    matched: Dict[str, Dict] = {}
    unmatched: List[Dict] = []

    for p in fbref_players:
        # 0. manual override wins
        override = manual.get(p["fbref_id"])
        if override and override in tm_by_id:
            matched[p["fbref_id"]] = {**tm_by_id[override], "join": "manual"}
            continue

        # 1. exact name + birth year (club tiebreaker on collision)
        candidates = by_name_year.get((p["norm_name"], p["birth_year"]), [])
        if candidates:
            matched[p["fbref_id"]] = {**pick_by_club(candidates, p["norm_club"]), "join": "exact"}
            continue

        # 2. token-reordered exact ("Castrop Jens" ↔ "Jens Castrop")
        sorted_key = " ".join(sorted(p["norm_name"].split()))
        candidates = by_sorted_year.get((sorted_key, p["birth_year"]), [])
        if candidates:
            matched[p["fbref_id"]] = {**pick_by_club(candidates, p["norm_club"]), "join": "token_sort"}
            continue

        year_pool = by_year.get(p["birth_year"], [])
        ptok = _tokens(p["norm_name"])

        # 3. token subset ("Caio Henrique Oliveira Silva" ⊇ "Caio Henrique");
        #    multi-token overlap may match on uniqueness, single-token needs the club
        subset = [t for t in year_pool if _tokens(t["norm_name"]) <= ptok or ptok <= _tokens(t["norm_name"])]
        strong = [t for t in subset if len(_tokens(t["norm_name"]) & ptok) >= 2]
        club_backed = [t for t in subset if clubs_match(t["norm_club"], p["norm_club"])]
        if len(strong) == 1:
            matched[p["fbref_id"]] = {**strong[0], "join": "subset"}
            continue
        if len(club_backed) == 1:
            matched[p["fbref_id"]] = {**club_backed[0], "join": "subset"}
            continue

        # 4. surname + club + year ("Babis Lykogiannis" ↔ "Charalampos Lykogiannis")
        surname = p["norm_name"].split()[-1] if p["norm_name"] else ""
        sur = [
            t for t in year_pool
            if t["norm_name"].split() and t["norm_name"].split()[-1] == surname
            and clubs_match(t["norm_club"], p["norm_club"])
        ]
        if len(sur) == 1:
            matched[p["fbref_id"]] = {**sur[0], "join": "surname_club"}
            continue

        # 5. fuzzy within the same birth year (plain + token-sorted), club tiebreaker
        best, best_ratio = None, 0.0
        for t in year_pool:
            tm_sorted = " ".join(sorted(t["norm_name"].split()))
            ratio = max(
                difflib.SequenceMatcher(None, p["norm_name"], t["norm_name"]).ratio(),
                difflib.SequenceMatcher(None, sorted_key, tm_sorted).ratio(),
            )
            if ratio > best_ratio or (ratio == best_ratio and best is not None and clubs_match(t["norm_club"], p["norm_club"])):
                best, best_ratio = t, ratio
        if best and best_ratio >= config.FUZZY_MIN_RATIO:
            matched[p["fbref_id"]] = {**best, "join": "fuzzy"}
            continue

        unmatched.append({**p, "best_guess": best["name"] if best else "", "best_ratio": round(best_ratio, 3)})

    return matched, unmatched


def write_unmatched_report(path: Path, unmatched: List[Dict], total: int) -> None:
    lines = [
        "# Unmatched FBref players",
        "",
        f"{len(unmatched)} of {total} FBref players ({len(unmatched) / max(1, total):.1%}) "
        f"had no TM match (target ≤ {1 - config.AUTO_MATCH_TARGET:.0%}).",
        "Add fixes to manual-matches.csv as `fbref_id,tm_id` rows and re-run.",
        "",
        "| fbref_id | name | year | club | best fuzzy guess | ratio |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for u in sorted(unmatched, key=lambda x: x["name"]):
        lines.append(
            f"| {u['fbref_id']} | {u['name']} | {u['birth_year']} | {u.get('club', '')} "
            f"| {u['best_guess']} | {u['best_ratio']} |"
        )
    path.write_text("\n".join(lines) + "\n")
