"""End-to-end pipeline: cache → parse → join → derive → seed SQL + reports.

  .venv/bin/python run.py            # reads pipeline/cache/ ONLY — never the network

Deterministic: same cache → identical outputs. Populating the cache is a
human step (cachefiles.py / DECISIONS.md).
"""

from __future__ import annotations

import json
from pathlib import Path

import cachefiles
import config
import csv_ingest
import derive
import emit
import fbref_parse
import join as join_mod
import tm_parse
from names import normalize_club, normalize_name

HERE = Path(__file__).parent


def main() -> None:
    csv_pages, csv_prov = csv_ingest.load_csv_pages()
    html_types = []
    pages = {}
    # CSV-only stat types (keepers_adv, passing_types) ride along untouched
    for page in csv_pages:
        if page not in config.FBREF_PAGES:
            pages[page] = csv_pages[page]
    for page in config.FBREF_PAGES:
        if csv_pages.get(page):
            pages[page] = csv_pages[page]  # CSV is the primary source
            continue
        rows = []  # HTML parser — fallback for stat types the dump lacks
        for _, league in config.FBREF_LEAGUES:
            path = cachefiles.fbref_page_path(league, page)
            if not path.exists():
                continue
            try:
                html_rows = fbref_parse.parse_players(path.read_text(errors="replace"), fbref_parse.TABLE_IDS[page])
            except ValueError:
                continue
            rows.extend(html_rows)
        pages[page] = rows
        if rows:
            html_types.append(page)
    if csv_prov:
        print(f"csv-first: {sorted(csv_prov)} ← cache/csv/  |  html fallback: {sorted(html_types) or 'none'}")
        gaps = csv_ingest.schema_report(csv_pages)
        if gaps:
            print("CSV SCHEMA GAPS (fix aliases in csv_ingest.py):", "; ".join(gaps))
    else:
        cachefiles.verify_cache()
    mixed_sources = bool(csv_prov) and bool(html_types)
    csv_ingest.assert_required(pages)  # 0%-mapped required field aborts BEFORE the join
    merged = derive.merge_tables(pages)
    print(f"fbref: {len(merged)} players across {len(pages)} tables")

    # minutes hard floor before anything else
    kept = {
        fid: tables for fid, tables in merged.items()
        if fbref_parse.num(tables["stats"], "minutes") >= config.MINUTES_HARD_FLOOR
    }
    print(f"minutes floor {config.MINUTES_HARD_FLOOR}': {len(kept)} kept, {len(merged) - len(kept)} dropped")

    tm_players = tm_parse.load_tm_players(cachefiles.tm_players_path())
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

    # possession adjustment: active only when a TEAM possession table is in
    # the cache (fetching is a human step — never silently approximated)
    team_poss = csv_ingest.load_team_possession()
    if team_poss:
        print(f"possession adjustment: ACTIVE ({len(team_poss)} teams, baseline {config.POSS_ADJUST_BASELINE}%)")
    else:
        print("possession adjustment: INACTIVE — no big5_team possession CSV in cache/csv/ (MAPPING.md rule 1)")

    metrics = [
        derive.Metrics(
            tables,
            matched.get(fid, {}).get("height_cm"),
            team_poss.get((tables["stats"].get("team") or "").strip()),
        )
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
                # vintage recorded only when sources actually mix (MAPPING.md)
                **({"sources": {"csv": sorted(csv_prov), "html": sorted(html_types)}} if mixed_sources else {}),
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
