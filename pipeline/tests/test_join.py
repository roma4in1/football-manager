from join import join_players
from names import normalize_club, normalize_name


def fb(fbref_id, name, year, club):
    return {
        "fbref_id": fbref_id, "name": name, "norm_name": normalize_name(name),
        "birth_year": year, "club": club, "norm_club": normalize_club(club),
    }


def tm(tm_id, name, year, club):
    return {
        "tm_id": tm_id, "name": name, "norm_name": normalize_name(name),
        "birth_date": f"{year}-01-01", "birth_year": year,
        "club": club, "norm_club": normalize_club(club),
        "foot": "R", "height_cm": 180, "market_value": 1000,
    }


TM_POOL = [
    tm("t1", "Jens Castrop", "2003", "Borussia Mönchengladbach"),
    tm("t2", "Caio Henrique", "1997", "AS Monaco"),
    tm("t3", "José Ángel Carmona", "2002", "Sevilla Fútbol Club S.A.D."),
    tm("t4", "Charalampos Lykogiannis", "1993", "Bologna FC 1909"),
    tm("t5", "Kevin Exact", "1999", "Testers FC"),
    tm("t6", "Kevin Exact", "1999", "Others United"),  # same name+year, other club
    tm("t7", "Nicolas Gonzalez", "2001", "FC Nantes"),
    tm("t8", "Totally Different", "1990", "Elsewhere"),
    tm("t9", "Marc Carmona", "2002", "Getafe CF"),  # second subset candidate for the club tiebreak
]


def test_exact_with_club_tiebreaker():
    matched, unmatched = join_players([fb("f1", "Kevin Exact", "1999", "Testers")], TM_POOL)
    assert matched["f1"]["tm_id"] == "t5"
    assert matched["f1"]["join"] == "exact"
    assert not unmatched


def test_token_reorder_matches():
    matched, _ = join_players([fb("f2", "Castrop Jens", "2003", "Gladbach")], TM_POOL)
    assert matched["f2"]["tm_id"] == "t1"
    assert matched["f2"]["join"] == "token_sort"


def test_subset_full_name_vs_short_form():
    matched, _ = join_players([fb("f3", "Caio Henrique Oliveira Silva", "1997", "Monaco")], TM_POOL)
    assert matched["f3"]["tm_id"] == "t2"
    assert matched["f3"]["join"] == "subset"


def test_single_token_subset_club_breaks_ties():
    # two Carmonas born 2002 → the club decides
    matched, _ = join_players([fb("f4", "Carmona", "2002", "Sevilla")], TM_POOL)
    assert matched["f4"]["tm_id"] == "t3"
    matched2, _ = join_players([fb("f4b", "Carmona", "2002", "Getafe")], TM_POOL)
    assert matched2["f4b"]["tm_id"] == "t9"
    # ambiguous (two candidates, unknown club) stays unmatched
    _, unmatched = join_players([fb("f5", "Carmona", "2002", "Real Madrid")], TM_POOL)
    assert unmatched and unmatched[0]["fbref_id"] == "f5"


def test_surname_unique_in_year_matches_without_club():
    # TM current club is a season newer than the fbref club — uniqueness carries it
    matched, _ = join_players([fb("f6", "Babis Lykogiannis", "1993", "Some New Club")], TM_POOL)
    assert matched["f6"]["tm_id"] == "t4"
    assert matched["f6"]["join"] == "surname_unique"


def test_fuzzy_catches_transliteration_variants():
    # different surname spelling defeats the exact/subset/surname passes
    matched, _ = join_players([fb("f7", "Nicolas Gonzales", "2001", "Olympique Lyon")], TM_POOL)
    assert matched["f7"]["tm_id"] == "t7"
    assert matched["f7"]["join"] == "fuzzy"


def test_manual_override_wins_and_unmatched_reported():
    manual = {"f8": "t8"}
    matched, unmatched = join_players([fb("f8", "Someone Odd", "1990", "Nowhere")], TM_POOL, manual)
    assert matched["f8"]["tm_id"] == "t8"
    assert matched["f8"]["join"] == "manual"

    _, unmatched = join_players([fb("f9", "Someone Odd", "1990", "Nowhere")], TM_POOL)
    assert unmatched and unmatched[0]["fbref_id"] == "f9"
    assert "best_guess" in unmatched[0]


def test_birth_year_is_a_hard_gate():
    # right name, wrong year → no match even with the club agreeing
    _, unmatched = join_players([fb("f10", "Kevin Exact", "1998", "Testers")], TM_POOL)
    assert unmatched
