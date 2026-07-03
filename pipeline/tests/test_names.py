from names import clubs_match, normalize_club, normalize_name


def test_normalize_name_strips_accents_and_punctuation():
    assert normalize_name("Şükrü Çağrı-Güler") == "sukru cagri guler"
    assert normalize_name("  N'Golo   Kanté ") == "n golo kante"


def test_normalize_club_drops_legal_forms():
    assert normalize_club("Sevilla Fútbol Club S.A.D.") == "sevilla"
    assert normalize_club("Club Atlético Osasuna") == "atletico osasuna"
    assert normalize_club("1. FC Union Berlin e. V.") == "1 union berlin"


def test_clubs_match_containment_and_token_rules():
    assert clubs_match("sevilla", "sevilla")
    assert clubs_match("osasuna", "atletico osasuna")  # containment
    assert clubs_match("atletico osasuna", "osasuna")
    # one shared token between two multi-token names must NOT match
    assert not clubs_match("manchester city", "manchester united")
    # …but a single-token name matching one of its tokens does
    assert clubs_match("barcelona", "barcelona b")
    assert not clubs_match("", "sevilla")
