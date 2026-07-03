"""End-to-end pipeline: cache → parse → join → derive → seed SQL + reports.

  .venv/bin/python run.py            # uses cache; fetches only what's missing
  FBREF_MODE=wayback ... run.py      # prime the cache from archive.org

Deterministic: same cache → identical outputs.
"""

from __future__ import annotations

import json
from pathlib import Path

import config
import derive
import emit
import fetch
import fbref_parse
import join as join_mod
import tm_parse
from names import normalize_club, normalize_name

HERE = Path(__file__).parent


def main() -> None:
    fetch.fetch_fbref()
    fetch.fetch_tm()

    pages = {}
    for page in config.FBREF_PAGES:
        rows = []
        for _, league in config.FBREF_LEAGUES:
            html = fetch.fbref_page_path(league, page).read_text()
            try:
                rows.extend(fbref_parse.parse_players(html, fbref_parse.TABLE_IDS[page]))
            except ValueError:
                print(f"NOTE: no {page} data for {league} — affected metrics will be imputed")
        pages[page] = rows
    merged = derive.merge_tables(pages)
    print(f"fbref: {len(merged)} players across {len(pages)} tables")

    # minutes hard floor before anything else
    kept = {
        fid: tables for fid, tables in merged.items()
        if fbref_parse.num(tables["stats"], "minutes") >= config.MINUTES_HARD_FLOOR
    }
    print(f"minutes floor {config.MINUTES_HARD_FLOOR}': {len(kept)} kept, {len(merged) - len(kept)} dropped")

    tm_players = tm_parse.load_tm_players(fetch.tm_players_path())
    print(f"tm: {len(tm_players)} recent Big-5 players")

    fbref_join_rows = [
        {
            "fbref_id": fid,
            "name": t["stats"].get("player", ""),
            "norm_name": normalize_name(t["stats"].get("player", "")),
            "birth_year": t["stats"].get("birth_year", ""),
            "club": t["stats"].get("team", ""),
            "norm_club": normalize_club(t["stats"].get("team", "")),
        }
        for fid, t in kept.items()
    ]
    manual = join_mod.load_manual_matches(HERE / "manual-matches.csv")
    matched, unmatched = join_mod.join_players(fbref_join_rows, tm_players, manual)
    join_mod.write_unmatched_report(HERE / "reports" / "unmatched.md", unmatched, len(fbref_join_rows))
    rate = len(matched) / max(1, len(fbref_join_rows))
    kinds = {}
    for m in matched.values():
        kinds[m["join"]] = kinds.get(m["join"], 0) + 1
    print(f"join: {rate:.1%} matched {kinds}; {len(unmatched)} unmatched → reports/unmatched.md")

    metrics = [
        derive.Metrics(tables, matched.get(fid, {}).get("height_cm"))
        for fid, tables in kept.items()
        if fid in matched
    ]
    fids = [fid for fid in kept if fid in matched]
    derived = derive.derive_all(metrics)

    seed_players = []
    for fid, met, d in zip(fids, metrics, derived):
        tm = matched[fid]
        height = tm.get("height_cm") or config.DEFAULT_HEIGHT_CM
        low_conf = list(d["low_confidence"]) + ["injuryProneness"]
        if not tm.get("height_cm"):
            low_conf.append("heightCm")
        if not tm.get("foot"):
            low_conf.append("preferredFoot")
        low_conf.append("weightKg")  # TM dump has no weight; height-based estimate
        physical = {"injuryProneness": derive.injury_proneness(d["age"], d["minutes_pct_z"])}
        seed_players.append({
            "full_name": tm["name"] or kept[fid]["stats"].get("player", ""),
            "birth_date": tm["birth_date"],
            "position": d["position"],
            "height_cm": height,
            "weight_kg": height - 105,
            "foot": tm.get("foot") or "R",
            "market_value": max(1, tm.get("market_value") or 1),
            "attributes": d["attributes"],
            "physical": physical,
            "source_meta": {
                "fbref_id": fid,
                "tm_id": tm["tm_id"],
                "join": tm["join"],
                "minutes": int(d["minutes"]),
                "low_confidence": sorted(set(low_conf)),
                "pipeline": "v1",
            },
            "minutes": d["minutes"],
        })

    # duplicate (name, birth_date) — two TM ids colliding: keep the higher-minutes row
    seen = {}
    for p in sorted(seed_players, key=lambda x: -x["minutes"]):
        seen.setdefault((p["full_name"], p["birth_date"]), p)
    seed_players = sorted(seen.values(), key=lambda p: p["full_name"])

    emit.write_seed_sql(HERE / "seeds" / "players.sql", seed_players)
    emit.write_distribution_report(HERE / "reports" / "distributions.md", seed_players, derive.ATTR_ORDER)
    summary = {
        "players": len(seed_players),
        "match_rate": round(rate, 4),
        "join_kinds": kinds,
        "injury_source": "prior (no injuries table in TM dump)",
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
