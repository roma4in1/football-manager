"""CSV ingestion tests — fixture strings shaped like the worldfootballR dump
(and a Kaggle-ish variant), no real cache, no network."""

from pathlib import Path

import csv_ingest
from csv_ingest import detect_types, load_csv_pages, schema_report, slug

WFR_PASSING = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,90s,Cmp_percent_Total,Att_Short,Cmp_percent_Short,Att_Medium,Cmp_percent_Medium,Att_Long,Cmp_percent_Long,KP,Final_Third,PPA,CrsPA,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998,30.0,88.0,300,92.0,280,89.0,220,71.5,20,110,30,12,https://fbref.com/en/players/aaaa1111/Lena-Long
2025,Testers,Premier League,Sami Short,ENG,MF,23,2001,28.0,91.0,600,95.5,410,93.0,40,55.0,45,140,55,3,https://fbref.com/en/players/bbbb2222/Sami-Short
2024,Old Season,Premier League,Past Player,ENG,MF,30,1994,20.0,80.0,100,80.0,100,80.0,100,60.0,10,50,10,1,https://fbref.com/en/players/cccc3333/Past-Player
"""

WFR_STANDARD = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,MP_Playing_Time,Min_Playing_Time,Mins_Per_90_Playing_Time,Gls,G_minus_PK,npxG_Expected,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998,34,2700,30.0,3,3,1.4,https://fbref.com/en/players/aaaa1111/Lena-Long
2025,Testers,Premier League,Sami Short,ENG,MF,23,2001,30,2520,28.0,8,7,5.9,https://fbref.com/en/players/bbbb2222/Sami-Short
"""

NO_URL_MISC = """Player,Born,Squad,90s,Fls,CrdY,Crs,Won_Aerial_Duels,Won_percent_Aerial_Duels
Lena Long,1998,Testers,30.0,25,4,40,80,68.0
"""


def _write(tmp_path: Path, name: str, content: str) -> None:
    (tmp_path / name).write_text(content)


def test_slug_normalizes_percent_and_plus():
    assert slug("Cmp_percent_Short") == "cmp_percent_short"
    assert slug("Cmp%_Short") == "cmp_percent_short"
    assert slug("Tkl+Int") == "tkl_plus_int"


def test_detect_types_is_specific():
    passing_headers = WFR_PASSING.splitlines()[0].split(",")
    assert detect_types(passing_headers) == ["passing"]
    standard_headers = WFR_STANDARD.splitlines()[0].split(",")
    # a standard file must be stats and must NOT half-match shooting
    assert detect_types(standard_headers) == ["stats"]


def test_load_maps_columns_filters_season_and_extracts_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    _write(tmp_path, "passing.csv", WFR_PASSING)
    _write(tmp_path, "standard.csv", WFR_STANDARD)
    pages, provenance = load_csv_pages()

    assert set(pages) == {"passing", "stats"}
    assert provenance == {"passing": "passing.csv", "stats": "standard.csv"}

    passing = {r["fbref_id"]: r for r in pages["passing"]}
    assert set(passing) == {"aaaa1111", "bbbb2222"}, "2024 season row filtered out"
    assert passing["aaaa1111"]["passes_pct_long"] == "71.5"
    assert passing["aaaa1111"]["passes_long"] == "220"
    assert passing["bbbb2222"]["passes_pct_short"] == "95.5"

    stats = {r["fbref_id"]: r for r in pages["stats"]}
    assert stats["aaaa1111"]["minutes"] == "2700"
    assert stats["aaaa1111"]["goals_pens"] == "3"
    assert stats["aaaa1111"]["npxg"] == "1.4"
    assert stats["aaaa1111"]["birth_year"] == "1998"
    assert stats["aaaa1111"]["team"] == "Testers"


def test_no_url_dump_synthesizes_stable_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    _write(tmp_path, "misc.csv", NO_URL_MISC)
    pages, _ = load_csv_pages()
    assert set(pages) == {"misc"}
    row = pages["misc"][0]
    assert row["fbref_id"] == "csv:Lena Long|1998"
    assert row["aerials_won_pct"] == "68.0"


def test_schema_report_flags_unpopulated_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    # passing file with an empty long-completion column
    broken = WFR_PASSING.replace("71.5", "").replace("55.0", "").replace("60.0", "")
    _write(tmp_path, "passing.csv", broken)
    pages, _ = load_csv_pages()
    gaps = schema_report(pages)
    assert any(g.startswith("passing.passes_pct_long") for g in gaps)


def test_missing_dir_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path / "nope")
    pages, provenance = load_csv_pages()
    assert pages == {} and provenance == {}
