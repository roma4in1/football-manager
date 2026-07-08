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


# ── GK cohort separation (MAPPING rule 3) ────────────────────────────────────

def _mk_gk(fbref_id, minutes=2700):
    """A GK with ELITE outfield numbers — must still get flat outfield attrs."""
    minutes_90s = str(minutes / 90)
    tables = {
        "stats": {
            "fbref_id": fbref_id, "player": fbref_id, "position": "GK",
            "minutes": str(minutes), "minutes_90s": minutes_90s, "age": "28-000",
            "goals_pens": "0",
        },
        "passing": {
            "minutes_90s": minutes_90s, "passes_pct": "99",
            "passes_pct_short": "99", "passes_pct_medium": "99", "passes_pct_long": "90",
            "passes_short": "500", "passes_medium": "500", "passes_long": "300",
        },
        "possession": {"minutes_90s": minutes_90s, "touches": "1200", "carries": "400", "miscontrols": "0"},
        "playingtime": {"minutes_pct": "95"},
        "keepers": {"minutes_90s": minutes_90s, "gk_save_pct": "80", "gk_clean_sheets_pct": "45", "gk_goals_against_per90": "0.6"},
    }
    return Metrics(tables, height_cm=192)


def test_gk_gets_flat_outfield_attributes_despite_elite_metrics():
    derived = derive_all(_squad() + [_mk_gk("KEEPER")])
    gk = derived[-1]
    from derive import GK_ONLY
    for attr, value in gk["attributes"].items():
        if attr in GK_ONLY:
            continue
        assert value == config.GK_OUTFIELD_ATTR, f"{attr}={value} for a GK"
    # and a real GK attribute is still derived, not flattened
    assert gk["attributes"]["gkDistribution"] > config.GK_OUTFIELD_ATTR


def test_gk_excluded_from_outfield_z_distribution():
    # adding a 99%-completion GK must NOT change any outfielder's passing:
    # if GKs entered the outfield distribution, means/stds would shift
    without_gk = derive_all(_squad())
    with_gk = derive_all(_squad() + [_mk_gk("KEEPER")])
    for before, after in zip(without_gk, with_gk):
        assert before["attributes"] == after["attributes"]


# ── pass difficulty (MAPPING rule: passing blend) ────────────────────────────

def _mk_passer(fbref_id, position, pct, prog_passes, prog_dist, tot_dist, minutes=2700):
    minutes_90s = str(minutes / 90)
    tables = {
        "stats": {
            "fbref_id": fbref_id, "player": fbref_id, "position": position,
            "minutes": str(minutes), "minutes_90s": minutes_90s, "age": "25-000",
            "goals_pens": "1",
        },
        "passing": {
            "minutes_90s": minutes_90s,
            "passes_pct_short": str(pct), "passes_pct_medium": str(pct),
            "passes_short": "400", "passes_medium": "400", "passes_pct": str(pct),
            "progressive_passes": str(prog_passes),
            "passes_progressive_distance": str(prog_dist), "passes_total_distance": str(tot_dist),
        },
        "possession": {"minutes_90s": minutes_90s, "touches": "900", "carries": "300"},
        "playingtime": {"minutes_pct": "80"},
    }
    return Metrics(tables, height_cm=182)


def test_passing_rewards_difficulty_over_safe_recycling():
    # identical completion; the line-breaker plays progressive, the recycler
    # passes sideways — difficulty terms must separate them
    squad = [
        _mk_passer("BREAKER", "MF", pct=88, prog_passes=250, prog_dist=6000, tot_dist=15000),
        _mk_passer("RECYCLER", "DF", pct=88, prog_passes=40, prog_dist=1200, tot_dist=15000),
        _mk_passer("AVG1", "MF", pct=80, prog_passes=120, prog_dist=3000, tot_dist=12000),
        _mk_passer("AVG2", "FW", pct=76, prog_passes=100, prog_dist=2500, tot_dist=10000),
    ]
    derived = derive_all(squad)
    by_id = dict(zip(["BREAKER", "RECYCLER", "AVG1", "AVG2"], derived))
    assert by_id["BREAKER"]["attributes"]["passing"] > by_id["RECYCLER"]["attributes"]["passing"]


# ── per-metric attempt shrinkage (MAPPING rule 2b) ───────────────────────────

def _mk_dribbler(fbref_id, position, takeon_pct, attempts, minutes=2700):
    minutes_90s = str(minutes / 90)
    won = round(attempts * takeon_pct / 100)
    tables = {
        "stats": {
            "fbref_id": fbref_id, "player": fbref_id, "position": position,
            "minutes": str(minutes), "minutes_90s": minutes_90s, "age": "25-000",
            "goals_pens": "1",
        },
        "possession": {
            "minutes_90s": minutes_90s, "touches": "900", "carries": "300",
            "take_ons": str(attempts), "take_ons_won": str(won),
            "take_ons_won_pct": str(takeon_pct),
        },
        "playingtime": {"minutes_pct": "80"},
    }
    return Metrics(tables, height_cm=182)


def test_per_metric_shrinkage_math():
    from derive import shrink_rates
    players = [
        _mk_dribbler("LUCKY", "MF", takeon_pct=100.0, attempts=5),    # 5/5 — tiny sample
        _mk_dribbler("PROVEN", "FW", takeon_pct=60.0, attempts=200),  # 120/200 — real signal
        _mk_dribbler("AVG", "MF", takeon_pct=50.0, attempts=100),
    ]
    raws = [p.raw() for p in players]
    shrink_rates(raws, [p.attempts() for p in players], ["OUTFIELD"] * 3)
    k = config.SHRINK_PRIORS["takeon_pct"]
    # attempt-weighted population mean: (100·5 + 60·200 + 50·100) / 305
    mu = (100.0 * 5 + 60.0 * 200 + 50.0 * 100) / 305
    assert abs(raws[0]["takeon_pct"] - (5 / (5 + k) * 100.0 + k / (5 + k) * mu)) < 1e-9
    assert abs(raws[1]["takeon_pct"] - (200 / (200 + k) * 60.0 + k / (200 + k) * mu)) < 1e-9
    # the tiny perfect sample lands closer to the mean than to its raw 100%
    assert abs(raws[0]["takeon_pct"] - mu) < abs(100.0 - mu) * 0.3
    # the proven volume dribbler keeps most of its signal
    assert abs(raws[1]["takeon_pct"] - 60.0) < 2.0


def test_shrinkage_flips_small_perfect_sample_below_proven_volume():
    squad = [
        _mk_dribbler("LUCKY", "MF", takeon_pct=100.0, attempts=5),
        _mk_dribbler("PROVEN", "FW", takeon_pct=62.0, attempts=200),
        _mk_dribbler("AVG1", "MF", takeon_pct=45.0, attempts=90),
        _mk_dribbler("AVG2", "DF", takeon_pct=40.0, attempts=60),
    ]
    derived = derive_all(squad)
    by_id = dict(zip(["LUCKY", "PROVEN", "AVG1", "AVG2"], derived))
    assert by_id["PROVEN"]["attributes"]["dribbling"] > by_id["LUCKY"]["attributes"]["dribbling"]


def test_missing_attempts_leaves_rate_unshrunk():
    from derive import shrink_rates
    p = _mk_dribbler("SOLO", "MF", takeon_pct=70.0, attempts=50)
    raws = [p.raw()]
    atts = [p.attempts()]
    atts[0]["takeon_pct"] = None  # denominator unavailable in this dump shape
    shrink_rates(raws, atts, ["OUTFIELD"])
    assert raws[0]["takeon_pct"] == 70.0


# ── possession adjustment (MAPPING rule 1) ───────────────────────────────────

def test_possession_adjustment_scales_volumes_only_when_team_poss_known():
    minutes_90s = str(2700 / 90)
    tables = {
        "stats": {
            "fbref_id": "P", "player": "P", "position": "MF",
            "minutes": "2700", "minutes_90s": minutes_90s, "age": "25-000", "goals_pens": "1",
        },
        "possession": {
            "minutes_90s": minutes_90s, "touches": "1800", "carries": "300",
            "touches_att_pen_area": "90", "take_ons": "60", "take_ons_won": "30",
            "take_ons_won_pct": "50", "miscontrols": "30",
        },
        "playingtime": {"minutes_pct": "80"},
    }
    unadjusted = Metrics(dict(tables), height_cm=182).raw()
    # 62.5% possession team → volumes deflate by 50/62.5 = 0.8
    adjusted = Metrics(dict(tables), height_cm=182, team_possession=62.5).raw()
    assert abs(adjusted["touches"] - unadjusted["touches"] * 0.8) < 1e-9
    assert abs(adjusted["takeon_won"] - unadjusted["takeon_won"] * 0.8) < 1e-9
    # rates and per-touch metrics are untouched — they are already share-free
    assert adjusted["takeon_pct"] == unadjusted["takeon_pct"]
    assert adjusted["miscontrol_pt"] == unadjusted["miscontrol_pt"]
