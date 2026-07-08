"""CSV-first FBref ingestion — the primary source since fbref's provider
change gutted the HTML tables at source (DECISIONS.md).

Reads every *.csv under cache/csv/ (a human-downloaded 2024-25 Big-5 season
dump: worldfootballR_data release or a Kaggle equivalent), detects which stat
type(s) each file carries, and normalizes columns to the SAME canonical
data-stat keys the HTML parser emits — derive.py doesn't know or care which
source fed it.

Column-name tolerance: headers are slugged (lowercase, %→percent, +→plus,
non-alnum→_) and looked up in per-type alias tables. Anything unmapped is
ignored; anything expected-but-missing is reported by schema_report() so a
differently-shaped dump is a five-minute alias fix, not a rewrite.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

CSV_DIR = Path(__file__).parent / "cache" / "csv"

_FBREF_ID = re.compile(r"/players/([0-9a-f]{8})")
_SLUG = re.compile(r"[^a-z0-9]+")


def slug(header: str) -> str:
    s = header.strip().lower().replace("%", " percent ").replace("+", " plus ")
    return _SLUG.sub("_", s).strip("_")


# canonical key → accepted slugged header aliases (worldfootballR first,
# fbref-share-CSV and common Kaggle spellings after)
ALIASES: Dict[str, Dict[str, List[str]]] = {
    "stats": {
        "player": ["player"],
        "team": ["squad"],
        "comp_level": ["comp"],
        "position": ["pos"],
        "age": ["age"],
        "birth_year": ["born"],
        "minutes": ["min_playing", "min_playing_time", "min", "minutes"],
        "minutes_90s": ["mins_per_90_playing", "mins_per_90_playing_time", "mins_per_90", "x90s", "90s"],
        "goals_pens": ["g_minus_pk", "g_minus_pk_performance", "gls_minus_pk", "npg"],
        "npxg": ["npxg_expected", "npxg", "npx_g_expected", "npx_g"],
        "url": ["url", "player_url", "urlfbref"],
    },
    "shooting": {
        "minutes_90s": ["mins_per_90", "x90s", "90s", "mins_per_90_playing_time"],
        "shots": ["sh_standard", "sh", "shots"],
        "shots_on_target": ["sot_standard", "sot"],
        "shots_on_target_pct": ["sot_percent_standard", "sot_percent", "so_t_percent"],
        "goals_per_shot_on_target": ["g_per_sot_standard", "g_per_sot", "goals_per_shot_on_target"],
        "npxg_shooting": ["npxg_expected", "npxg"],
    },
    "passing": {
        "minutes_90s": ["mins_per_90", "x90s", "90s"],
        "passes_pct": ["cmp_percent_total", "cmp_percent", "pass_completion_percent"],
        "passes_total": ["att_total"],
        "passes_short": ["att_short"],
        "passes_pct_short": ["cmp_percent_short"],
        "passes_medium": ["att_medium"],
        "passes_pct_medium": ["cmp_percent_medium"],
        "passes_long": ["att_long"],
        "passes_pct_long": ["cmp_percent_long"],
        "assisted_shots": ["kp", "key_passes"],
        "passes_into_final_third": ["final_third", "passes_into_final_third", "x1_3"],
        "passes_into_penalty_area": ["ppa"],
        "crosses_into_penalty_area": ["crs_pa", "crspa"],
        "progressive_passes": ["prg_p", "prgp", "prog"],
        "passes_total_distance": ["tot_dist_total", "totdist_total"],
        "passes_progressive_distance": ["prg_dist_total", "prgdist_total"],
    },
    "defense": {
        "minutes_90s": ["mins_per_90", "x90s", "90s"],
        "tackles": ["tkl_tackles", "tkl", "tackles"],
        "tackles_won": ["tkl_w_tackles", "tklw_tackles", "tklw", "tkl_w"],
        "tackles_def_3rd": ["def_3rd_tackles"],
        "challenges": ["att_challenges"],
        "challenge_tackles_pct": ["tkl_percent_challenges"],
        "blocks": ["blocks_blocks", "blocks"],
        "blocked_shots": ["sh_blocks"],
        "blocked_passes": ["pass_blocks"],
        "interceptions": ["int"],
        "tackles_interceptions": ["tkl_plus_int", "tklplusint"],
        "clearances": ["clr"],
        "errors": ["err"],
    },
    "possession": {
        "minutes_90s": ["mins_per_90", "x90s", "90s"],
        "touches": ["touches_touches", "touches"],
        "touches_att_pen_area": ["att_pen_touches", "touches_att_pen_area"],
        "take_ons": ["att_take", "att_take_ons"],
        "take_ons_won": ["succ_take", "succ_take_ons", "succ_take_ons_take_ons"],
        "take_ons_won_pct": ["succ_percent_take", "succ_percent_take_ons"],
        "carries": ["carries_carries", "carries"],
        "carries_progressive_distance": ["prg_dist_carries", "prgdist_carries"],
        "progressive_carries": ["prg_c_carries", "prgc_carries", "prgc"],
        "miscontrols": ["mis_carries", "mis"],
        "dispossessed": ["dis_carries", "dis"],
        "progressive_passes_received": ["prg_r_receiving", "prgr_receiving", "prgr"],
    },
    "misc": {
        "minutes_90s": ["mins_per_90", "x90s", "90s"],
        "fouls": ["fls_performance", "fls", "fouls"],
        "cards_yellow": ["crd_y_performance", "crdy_performance", "crd_y", "crdy"],
        "crosses": ["crs_performance", "crs"],
        "aerials_won": ["won_aerial", "won_aerial_duels", "aerials_won"],
        "aerials_lost": ["lost_aerial", "lost_aerial_duels", "aerials_lost"],
        "aerials_won_pct": ["won_percent_aerial", "won_percent_aerial_duels", "aerials_won_pct"],
    },
    "playingtime": {
        "minutes_pct": ["min_percent_playing_time", "mn_percent", "min_percent"],
        "minutes": ["min_playing_time"],  # fallback when standard's Min_Playing is absent
        "minutes_90s": ["mins_per_90_playing_time", "mins_per_90"],
    },
    "keepers": {
        "minutes_90s": ["mins_per_90"],
        "gk_saves": ["saves_performance", "saves"],
        "gk_save_pct": ["save_percent_performance", "save_percent"],
        "gk_clean_sheets_pct": ["cs_percent_performance", "cs_percent"],
        "gk_goals_against_per90": ["ga90_performance", "ga90"],
        # pen-save% deliberately unmapped (MAPPING.md) — tiny samples, mostly blank
    },
    "keepers_adv": {
        "minutes_90s": ["mins_per_90"],
        # worldfootballR renames "PSxG+/-_Expected" via make.names ("/"→_per_, "-"→_minus_)
        "gk_psxg_net": ["psxg_plus_per_minus_expected", "psxg_plus_minus", "psxg_net"],
    },
    "passing_types": {
        "minutes_90s": ["mins_per_90"],
        "crosses": ["crs_pass"],
    },
}

# identity columns every dump row needs, whatever the stat type
_IDENTITY = {"player": ["player"], "birth_year": ["born"], "team": ["squad"], "url": ["url", "player_url", "urlfbref"]}

# a file is treated as carrying a stat type when more than this share of the
# type's DISTINCTIVE keys (non-shared ones) resolve in its header. 0.6 keeps a
# shooting file (which also carries npxg) from half-matching as "stats".
_DETECT_THRESHOLD = 0.6
_SHARED = {"minutes_90s", "player", "team", "comp_level", "position", "age", "birth_year", "url", "minutes"}


def _resolve(header_slugs: Dict[str, str], aliases: List[str]) -> Optional[str]:
    for a in aliases:
        if a in header_slugs:
            return header_slugs[a]
    return None


def detect_types(fieldnames: List[str]) -> List[str]:
    header_slugs = {slug(h): h for h in fieldnames}
    types = []
    for stat_type, table in ALIASES.items():
        distinctive = [k for k in table if k not in _SHARED]
        if not distinctive:
            continue
        hits = sum(1 for k in distinctive if _resolve(header_slugs, table[k]))
        if hits / len(distinctive) >= _DETECT_THRESHOLD:
            types.append(stat_type)
    return types


def _fbref_id(row: Dict[str, str], header_slugs: Dict[str, str]) -> Optional[str]:
    url_col = _resolve(header_slugs, _IDENTITY["url"])
    if url_col:
        m = _FBREF_ID.search(row.get(url_col) or "")
        if m:
            return m.group(1)
    # no url column: synthesize a stable id from name+birth year
    player_col = _resolve(header_slugs, _IDENTITY["player"])
    born_col = _resolve(header_slugs, _IDENTITY["birth_year"])
    if player_col and (row.get(player_col) or "").strip():
        return f"csv:{(row.get(player_col) or '').strip()}|{(row.get(born_col) or '').strip()}"
    return None


def load_csv_pages() -> Tuple[Dict[str, List[Dict[str, str]]], Dict[str, str]]:
    """Returns (pages, provenance): canonical rows per stat type, and which
    file served each type. Empty dicts when cache/csv/ is absent."""
    pages: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    provenance: Dict[str, str] = {}
    if not CSV_DIR.exists():
        return {}, {}
    for path in sorted(CSV_DIR.glob("*.csv")):
        with open(path, newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            if not reader.fieldnames:
                continue
            header_slugs = {slug(h): h for h in reader.fieldnames}
            types = detect_types(reader.fieldnames)
            if not types:
                print(f"csv: {path.name} matched no stat type — skipped")
                continue
            rows = list(reader)
        season_col = _resolve(header_slugs, ["season_end_year", "season"])
        if season_col:
            rows = [r for r in rows if (r.get(season_col) or "").strip() in ("2025", "2024-2025", "2024/2025")]
        for stat_type in types:
            table = {**ALIASES[stat_type], **_IDENTITY, **{
                k: v for k, v in ALIASES["stats"].items() if stat_type == "stats"
            }}
            out_rows = []
            for row in rows:
                fid = _fbref_id(row, header_slugs)
                if not fid:
                    continue
                rec: Dict[str, str] = {"fbref_id": fid}
                for key, aliases in table.items():
                    col = _resolve(header_slugs, aliases)
                    if col is not None:
                        rec[key] = (row.get(col) or "").strip()
                # R writes Born as a float ("1999.0") — TM keys on "1999"
                if rec.get("birth_year"):
                    try:
                        rec["birth_year"] = str(int(float(rec["birth_year"])))
                    except ValueError:
                        pass
                out_rows.append(rec)
            pages[stat_type].extend(out_rows)
            provenance[stat_type] = path.name
    return dict(pages), provenance


def load_team_possession() -> Dict[str, float]:
    """Squad → season possession %, from a TEAM-shaped CSV in cache/csv/
    (has a Poss + Squad column, no Player column — e.g. worldfootballR's
    big5_team_possession). Empty dict when no such file exists; the caller
    reports the adjustment inactive rather than approximating (MAPPING.md)."""
    out: Dict[str, float] = {}
    if not CSV_DIR.exists():
        return out
    for path in sorted(CSV_DIR.glob("*.csv")):
        with open(path, newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            if not reader.fieldnames:
                continue
            header_slugs = {slug(h): h for h in reader.fieldnames}
            poss_col = _resolve(header_slugs, ["poss", "poss_percent", "possession"])
            squad_col = _resolve(header_slugs, ["squad", "team"])
            player_col = _resolve(header_slugs, ["player"])
            if not poss_col or not squad_col or player_col:
                continue  # not a team possession table
            season_col = _resolve(header_slugs, ["season_end_year", "season"])
            for row in reader:
                if season_col and (row.get(season_col) or "").strip() not in ("2025", "2024-2025", "2024/2025"):
                    continue
                squad = (row.get(squad_col) or "").strip()
                if squad.lower().startswith("vs "):
                    continue  # opponent-side rows in the team dumps
                raw = (row.get(poss_col) or "").strip()
                try:
                    poss = float(raw)
                except ValueError:
                    continue
                if squad and 0 < poss <= 100:
                    out[squad] = poss
    return out


# fields the whole derivation hangs on — 0% mapped means a schema mismatch,
# not sparse data, and the run must abort before the join
REQUIRED_FIELDS = [("stats", "minutes"), ("stats", "player"), ("stats", "birth_year")]


def assert_required(pages: Dict[str, List[Dict[str, str]]]) -> None:
    failures = []
    for stat_type, key in REQUIRED_FIELDS:
        rows = pages.get(stat_type, [])
        if not rows:
            failures.append(f"{stat_type} (no rows at all)")
            continue
        if not any((r.get(key) or "").strip() for r in rows):
            failures.append(f"{stat_type}.{key} mapped 0%")
    if failures:
        raise RuntimeError(
            "required field(s) unmapped — fix csv_ingest.ALIASES before joining: " + "; ".join(failures)
        )


def schema_report(pages: Dict[str, List[Dict[str, str]]]) -> List[str]:
    """Which canonical keys came back empty — the to-fix list for a new dump."""
    problems = []
    for stat_type, rows in pages.items():
        if not rows:
            continue
        for key in ALIASES[stat_type]:
            populated = sum(1 for r in rows if (r.get(key) or "").strip())
            if populated < len(rows) // 2:
                problems.append(f"{stat_type}.{key} ({populated}/{len(rows)} populated)")
    return problems
