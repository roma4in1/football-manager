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

# actual worldfootballR dump shapes (verified on disk): R make.names suffixes
# differ per file — standard says Min_Playing, playing_time says Min_Playing.Time
WFR_STANDARD = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,MP_Playing,Min_Playing,Mins_Per_90_Playing,Gls,G_minus_PK,npxG_Expected,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998.0,34,2700,30.0,3,3,1.4,https://fbref.com/en/players/aaaa1111/Lena-Long
2025,Testers,Premier League,Sami Short,ENG,MF,23,2001,30,2520,28.0,8,7,5.9,https://fbref.com/en/players/bbbb2222/Sami-Short
"""

WFR_PLAYING_TIME = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,MP_Playing.Time,Min_Playing.Time,Min_percent_Playing.Time,Mins_Per_90_Playing.Time,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998,34,2700,88.9,30.0,https://fbref.com/en/players/aaaa1111/Lena-Long
"""

WFR_MISC = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,Mins_Per_90,CrdY,Fls,Crs,Won_Aerial,Lost_Aerial,Won_percent_Aerial,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998,30.0,4,25,12,80,38,67.8,https://fbref.com/en/players/aaaa1111/Lena-Long
"""

WFR_POSSESSION = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,Mins_Per_90,Touches_Touches,Att Pen_Touches,Att_Take,Succ_Take,Succ_percent_Take,Carries_Carries,PrgDist_Carries,PrgC_Carries,Mis_Carries,Dis_Carries,PrgR_Receiving,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998,30.0,2100,30,40,22,55.0,900,4200,60,20,15,90,https://fbref.com/en/players/aaaa1111/Lena-Long
"""

WFR_KEEPERS_ADV = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,Mins_Per_90,PSxG_Expected,PSxG_per_SoT_Expected,PSxG+_per__minus__Expected,Url
2025,Testers,Premier League,Greta Glove,ENG,GK,29,1996,34.0,48.2,0.31,5.6,https://fbref.com/en/players/dddd4444/Greta-Glove
"""

WFR_PASSING_TYPES = """Season_End_Year,Squad,Comp,Player,Nation,Pos,Age,Born,Mins_Per_90,Att,Live_Pass,Crs_Pass,CK_Pass,Url
2025,Testers,Premier League,Lena Long,ENG,DF,27,1998,30.0,1500,1400,120,30,https://fbref.com/en/players/aaaa1111/Lena-Long
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


def test_actual_dump_column_variants_map(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    _write(tmp_path, "big5_player_playing_time.csv", WFR_PLAYING_TIME)
    _write(tmp_path, "big5_player_misc.csv", WFR_MISC)
    _write(tmp_path, "big5_player_possession.csv", WFR_POSSESSION)
    _write(tmp_path, "big5_player_keepers_adv.csv", WFR_KEEPERS_ADV)
    _write(tmp_path, "big5_player_passing_types.csv", WFR_PASSING_TYPES)
    pages, _ = load_csv_pages()

    assert set(pages) >= {"playingtime", "misc", "possession", "keepers_adv", "passing_types"}
    pt = pages["playingtime"][0]
    assert pt["minutes_pct"] == "88.9" and pt["minutes"] == "2700"  # dots slug to underscores
    misc = pages["misc"][0]
    assert misc["aerials_won"] == "80" and misc["aerials_won_pct"] == "67.8" and misc["crosses"] == "12"
    poss = pages["possession"][0]
    assert poss["take_ons_won"] == "22" and poss["take_ons_won_pct"] == "55.0"
    adv = pages["keepers_adv"][0]
    assert adv["gk_psxg_net"] == "5.6"  # PSxG+/- via make.names decoding
    ptypes = pages["passing_types"][0]
    assert ptypes["crosses"] == "120"


def test_assert_required_aborts_on_unmapped_minutes(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    broken = WFR_STANDARD.replace("Min_Playing,", "Minutes_Total,")  # unmapped header
    _write(tmp_path, "standard.csv", broken)
    pages, _ = load_csv_pages()
    try:
        csv_ingest.assert_required(pages)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as err:
        assert "stats.minutes mapped 0%" in str(err)


def test_missing_dir_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path / "nope")
    pages, provenance = load_csv_pages()
    assert pages == {} and provenance == {}


TEAM_POSSESSION = """Season_End_Year,Squad,Comp,Poss,Touches_Touches
2025,Arsenal,Premier League,58.3,25000
2025,vs Arsenal,Premier League,41.7,20000
2024,Arsenal,Premier League,61.0,26000
2025,Getafe,La Liga,42.1,19000
"""


def test_load_team_possession_reads_team_shaped_file(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    _write(tmp_path, "big5_team_possession.csv", TEAM_POSSESSION)
    _write(tmp_path, "standard.csv", WFR_STANDARD)  # player file must be ignored
    poss = csv_ingest.load_team_possession()
    # current season only, opponent ("vs ") rows skipped, player files skipped
    assert poss == {"Arsenal": 58.3, "Getafe": 42.1}


def test_load_team_possession_empty_without_team_file(tmp_path, monkeypatch):
    monkeypatch.setattr(csv_ingest, "CSV_DIR", tmp_path)
    _write(tmp_path, "standard.csv", WFR_STANDARD)
    assert csv_ingest.load_team_possession() == {}
