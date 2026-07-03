import config
from derive import Metrics, derive_all, injury_proneness, squash


def test_squash_center_clamp_and_bounds():
    assert squash(0.0) in (10, 11)
    assert squash(config.Z_CLAMP) == 20
    assert squash(10.0) == 20  # clamped at the tail
    assert squash(-10.0) == 1
    assert squash(-config.Z_CLAMP) == 1


def _mk(fbref_id, position, minutes, pct_long, pct_short, pct_medium, long_vol=100):
    minutes_90s = str(minutes / 90)
    tables = {
        "stats": {
            "fbref_id": fbref_id, "player": fbref_id, "position": position,
            "minutes": str(minutes), "minutes_90s": minutes_90s, "age": "25-000",
            "goals_pens": "2",
        },
        "passing": {
            "minutes_90s": minutes_90s,
            "passes_pct_long": str(pct_long), "passes_long": str(long_vol),
            "passes_pct_short": str(pct_short), "passes_pct_medium": str(pct_medium),
            "passes_short": "300", "passes_medium": "300", "passes_pct": "85",
        },
        "possession": {"minutes_90s": minutes_90s, "touches": "900", "carries": "300"},
        "playingtime": {"minutes_pct": "50"},
    }
    return Metrics(tables, height_cm=182)


def _squad():
    # long-pass specialist vs short-pass metronome vs two average fillers
    return [
        _mk("LONG", "DF", 2700, pct_long=85, pct_short=70, pct_medium=70, long_vol=400),
        _mk("SHORT", "MF", 2700, pct_long=40, pct_short=95, pct_medium=95, long_vol=20),
        _mk("AVG1", "MF", 2700, pct_long=60, pct_short=82, pct_medium=82),
        _mk("AVG2", "FW", 2700, pct_long=55, pct_short=80, pct_medium=80),
        _mk("DFAVG", "DF", 2700, pct_long=55, pct_short=80, pct_medium=80),
        # same per-90 long-pass profile as LONG, an eighth of the minutes
        _mk("ROOKIE", "DF", 300, pct_long=85, pct_short=70, pct_medium=70, long_vol=44),
    ]


def test_long_passing_split_reads_only_long_metrics():
    derived = derive_all(_squad())
    by_id = dict(zip(["LONG", "SHORT", "AVG1", "AVG2", "DFAVG", "ROOKIE"], derived))
    assert by_id["LONG"]["attributes"]["longPassing"] > by_id["SHORT"]["attributes"]["longPassing"]
    assert by_id["SHORT"]["attributes"]["passing"] > by_id["LONG"]["attributes"]["passing"]


def test_minutes_shrinkage_pulls_rookie_toward_group_mean():
    derived = derive_all(_squad())
    by_id = dict(zip(["LONG", "SHORT", "AVG1", "AVG2", "DFAVG", "ROOKIE"], derived))
    # identical raw long-pass profile, 300' vs 2700' → the rookie lands closer
    # to the (lower) group mean than the veteran
    assert by_id["ROOKIE"]["attributes"]["longPassing"] < by_id["LONG"]["attributes"]["longPassing"]


def test_outfield_players_get_flat_gk_attributes():
    derived = derive_all(_squad())
    for d in derived:
        for gk_attr in ("gkReflexes", "gkPositioning", "gkDistribution"):
            assert d["attributes"][gk_attr] == 3


def test_attributes_complete_and_in_range():
    derived = derive_all(_squad())
    from derive import ATTR_ORDER
    for d in derived:
        assert set(d["attributes"].keys()) == set(ATTR_ORDER)
        assert all(1 <= v <= 20 for v in d["attributes"].values())


def test_injury_proneness_prior_bounds_and_direction():
    young_durable = injury_proneness(age=21.0, minutes_pct_z=1.5)
    old_fragile = injury_proneness(age=33.0, minutes_pct_z=-1.5)
    assert 1 <= young_durable < old_fragile <= 20
