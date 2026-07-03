from pathlib import Path

from fbref_parse import num, parse_players

FIXTURE = (Path(__file__).parent / "fixtures" / "fbref_mini.html").read_text()


def test_parses_comment_wrapped_table_and_skips_header_rows():
    rows = parse_players(FIXTURE, "stats_passing")
    # 2 real players; the repeated thead row and the linkless row are skipped
    assert [r["fbref_id"] for r in rows] == ["aaaa1111", "bbbb2222"]


def test_id_from_data_append_csv_or_href():
    rows = parse_players(FIXTURE, "stats_passing")
    assert rows[0]["fbref_id"] == "aaaa1111"  # data-append-csv
    assert rows[1]["fbref_id"] == "bbbb2222"  # href fallback
    assert rows[0]["team"] == "Testers FC"


def test_num_coercion_handles_commas_and_blanks():
    rows = parse_players(FIXTURE, "stats_passing")
    assert num(rows[0], "passes_pct_long") == 78.5
    assert num(rows[1], "passes_pct_long") == 1234.0  # '1,234' — thousands-sep strip
    assert num(rows[1], "passes_long") == 0.0  # blank → default
    assert num(rows[1], "missing_key", default=7.5) == 7.5


def test_missing_table_raises():
    try:
        parse_players(FIXTURE, "stats_nope")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
