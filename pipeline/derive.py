"""Metric assembly + attribute derivation. Implements MAPPING.md exactly —
if you change a weight here, change the table there in the same commit.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import config
from fbref_parse import num

GROUPS = ("GK", "DF", "MF", "FW")
ATTR_ORDER = [
    "passing", "longPassing", "vision", "firstTouch", "dribbling", "finishing", "heading", "crossing",
    "tackling", "marking", "setPieceDelivery",
    "pace", "acceleration", "stamina", "strength", "jumping", "agility",
    "decisions", "composure", "positioning", "offTheBall", "anticipation", "workRate", "aggression",
    "gkReflexes", "gkPositioning", "gkDistribution",
]
LOW_CONFIDENCE = {
    "heading", "setPieceDelivery", "pace", "acceleration", "stamina",
    "strength", "jumping", "agility", "composure", "workRate",
}


def coarse_position(pos: str) -> str:
    first = (pos or "").split(",")[0].strip().upper()
    return first if first in GROUPS else "MF"


def merge_tables(pages: Dict[str, List[Dict]]) -> Dict[str, Dict]:
    """fbref_id → merged metric row. `stats` is canonical for identity/minutes."""
    merged: Dict[str, Dict] = {}
    for row in pages["stats"]:
        merged[row["fbref_id"]] = {"stats": row}
    for page, rows in pages.items():
        if page == "stats":
            continue
        for row in rows:
            if row["fbref_id"] in merged:
                merged[row["fbref_id"]][page] = row
    return merged


class Metrics:
    """Raw metric extraction for one player (rates per MAPPING.md rule 1)."""

    def __init__(self, tables: Dict[str, Dict], height_cm: Optional[int]):
        self.t = tables
        self.height_cm = height_cm
        self.minutes = num(tables["stats"], "minutes")
        self.position = coarse_position(tables["stats"].get("position", ""))
        age_raw = (tables["stats"].get("age") or "25").split("-")[0]
        self.age = float(age_raw) if age_raw.isdigit() else 25.0

    def _present(self, page: str, key: str) -> bool:
        row = self.t.get(page)
        return bool(row and (row.get(key) or "").strip())

    def _per90(self, page: str, key: str) -> Optional[float]:
        """None = data unavailable (empty cell / missing table) — NOT zero."""
        if not self._present(page, key):
            return None
        row = self.t[page]
        n90 = num(row, "minutes_90s")
        return num(row, key) / n90 if n90 > 0 else 0.0

    def _per_touch(self, key: str) -> Optional[float]:
        if not self._present("possession", key) or not self._present("possession", "touches"):
            return None
        row = self.t["possession"]
        touches = num(row, "touches")
        return num(row, key) / touches if touches > 0 else 0.0

    def _pct(self, page: str, key: str) -> Optional[float]:
        return num(self.t[page], key) if self._present(page, key) else None

    def raw(self) -> Dict[str, Optional[float]]:
        p, m = self._pct, self._per90
        sm_pct: Optional[float] = None
        ps, pm = p("passing", "passes_pct_short"), p("passing", "passes_pct_medium")
        if ps is not None and pm is not None:
            short_att = num(self.t.get("passing", {}), "passes_short")
            med_att = num(self.t.get("passing", {}), "passes_medium")
            sm_total = max(1.0, short_att + med_att)
            sm_pct = (ps * short_att + pm * med_att) / sm_total
        carry_dist: Optional[float] = None
        if self._present("possession", "carries_progressive_distance"):
            carries = max(1.0, num(self.t.get("possession", {}), "carries"))
            carry_dist = num(self.t["possession"], "carries_progressive_distance") / carries
        age_z_pace = -config.PACE_AGE_SLOPE * max(0.0, self.age - config.PACE_AGE_PEAK)
        age_z_stam = -config.STAMINA_AGE_SLOPE * max(0.0, self.age - config.STAMINA_AGE_PEAK)
        return {
            "pass_sm_pct": sm_pct,
            "pass_long_pct": p("passing", "passes_pct_long"),
            "pass_long_vol": m("passing", "passes_long"),
            "pass_pct": p("passing", "passes_pct"),
            "crs_pa": m("passing", "crosses_into_penalty_area"),
            "crs": m("misc", "crosses"),
            "key_passes": m("passing", "assisted_shots"),
            "ppa": m("passing", "passes_into_penalty_area"),
            "pft": m("passing", "passes_into_final_third"),
            "miscontrol_pt": self._per_touch("miscontrols"),
            "dispossessed_pt": self._per_touch("dispossessed"),
            "takeon_pct": p("possession", "take_ons_won_pct"),
            "takeon_won": m("possession", "take_ons_won"),
            "prog_carries": m("possession", "progressive_carries"),
            "prog_carry_dist": carry_dist,
            "gpsot": p("shooting", "goals_per_shot_on_target"),
            "sot_pct": p("shooting", "shots_on_target_pct"),
            "np_goals": m("stats", "goals_pens"),
            "clearances": m("defense", "clearances"),
            "challenge_pct": p("defense", "challenge_tackles_pct"),
            "tackles_won": m("defense", "tackles_won"),
            "blocks": m("defense", "blocks"),
            "blocked_shots": m("defense", "blocked_shots"),
            "blocked_passes": m("defense", "blocked_passes"),
            "tackles_def3": m("defense", "tackles_def_3rd"),
            "tkl_int": m("defense", "tackles_interceptions"),
            "interceptions": m("defense", "interceptions"),
            "challenges": m("defense", "challenges"),
            "errors": m("defense", "errors"),
            "touches": m("possession", "touches"),
            "touches_pen": m("possession", "touches_att_pen_area"),
            "prog_received": m("possession", "progressive_passes_received"),
            "fouls": m("misc", "fouls"),
            "yellows": m("misc", "cards_yellow"),
            "minutes_pct": self._pct("playingtime", "minutes_pct") or 0.0,
            "height": float(self.height_cm or config.DEFAULT_HEIGHT_CM),
            "age_curve_pace": age_z_pace,
            "age_curve_stamina": age_z_stam,
            "gk_save_pct": p("keepers", "gk_save_pct"),
            "gk_pens_save_pct": p("keepers", "gk_pens_save_pct"),
            "gk_cs_pct": p("keepers", "gk_clean_sheets_pct"),
            "gk_ga90": p("keepers", "gk_goals_against_per90"),
        }


# attribute → [(metric, weight, invert)]; age-curve metrics enter as raw z offsets
BLENDS: Dict[str, List[Tuple[str, float, bool]]] = {
    "passing": [("pass_sm_pct", 1.0, False)],
    "longPassing": [("pass_long_pct", config.LONG_PASS_COMPLETION_W, False), ("pass_long_vol", config.LONG_PASS_VOLUME_W, False)],
    "crossing": [("crs_pa", 0.6, False), ("crs", 0.4, False)],
    "vision": [("key_passes", 0.4, False), ("ppa", 0.3, False), ("pft", 0.3, False)],
    "firstTouch": [("miscontrol_pt", 0.7, True), ("pass_pct", 0.3, False)],
    "dribbling": [("takeon_pct", 0.5, False), ("takeon_won", 0.3, False), ("prog_carries", 0.2, False)],
    "finishing": [("gpsot", 0.4, False), ("sot_pct", 0.3, False), ("np_goals", 0.3, False)],
    "heading": [("height", 0.6, False), ("clearances", 0.2, False), ("np_goals", 0.2, False)],
    "tackling": [("challenge_pct", 0.5, False), ("tackles_won", 0.5, False)],
    "marking": [("blocks", 0.4, False), ("clearances", 0.3, False), ("tackles_def3", 0.3, False)],
    "pace": [("prog_carry_dist", 0.4, False), ("takeon_won", 0.2, False), ("age_curve_pace", 0.4, False)],
    "acceleration": [("takeon_won", 0.4, False), ("prog_carries", 0.2, False), ("age_curve_pace", 0.4, False)],
    "stamina": [("minutes_pct", 0.6, False), ("age_curve_stamina", 0.4, False)],
    "strength": [("height", 0.5, False), ("dispossessed_pt", 0.3, True), ("fouls", 0.2, False)],
    "jumping": [("height", 0.7, False), ("clearances", 0.3, False)],
    "agility": [("takeon_pct", 0.5, False), ("miscontrol_pt", 0.5, True)],
    "decisions": [("pass_pct", 0.4, False), ("dispossessed_pt", 0.4, True), ("errors", 0.2, True)],
    "composure": [("errors", 0.5, True), ("miscontrol_pt", 0.5, True)],
    "positioning": [("interceptions", 0.5, False), ("blocked_shots", 0.25, False), ("clearances", 0.25, False)],
    "offTheBall": [("touches_pen", 0.5, False), ("prog_received", 0.5, False)],
    "anticipation": [("interceptions", 0.6, False), ("blocked_passes", 0.4, False)],
    "workRate": [("tkl_int", 0.5, False), ("touches", 0.3, False), ("minutes_pct", 0.2, False)],
    "aggression": [("fouls", 0.5, False), ("yellows", 0.3, False), ("challenges", 0.2, False)],
    "gkReflexes": [("gk_save_pct", 0.7, False), ("gk_pens_save_pct", 0.3, False)],
    "gkPositioning": [("gk_cs_pct", 0.5, False), ("gk_ga90", 0.5, True)],
    "gkDistribution": [("pass_long_pct", 0.6, False), ("pass_pct", 0.4, False)],
}
GK_ONLY = ("gkReflexes", "gkPositioning", "gkDistribution")
AGE_CURVE_METRICS = {"age_curve_pace", "age_curve_stamina"}
OUTFIELD_GK_ATTR = 3
SPD_DERIVED = "setPieceDelivery"  # blend of two attribute z's, handled separately


def zstats(values: List[Optional[float]]) -> Tuple[float, float]:
    present = [v for v in values if v is not None]
    if len(present) < 2:
        return (present[0] if present else 0.0), 1.0
    mu = statistics.fmean(present)
    sd = statistics.pstdev(present) or 1.0
    return mu, sd


def squash(z: float) -> int:
    z = max(-config.Z_CLAMP, min(config.Z_CLAMP, z))
    return max(1, min(20, round(config.SQUASH_CENTER + z * config.SQUASH_SCALE)))


def derive_all(players: List[Metrics]) -> List[Dict]:
    """players → [{attributes, position, low_confidence, minutes, age, …}].

    MAPPING.md rules 2–4: metric z LEAGUE-WIDE (attributes are absolute in
    the engine), GK-only metrics z within the GK cohort, then each player's
    attribute z is shrunk toward the POSITION-GROUP mean of that attribute.
    """
    raws = [p.raw() for p in players]
    league = list(range(len(players)))
    gks = [i for i, p in enumerate(players) if p.position == "GK"]

    metric_keys = {m for blend in BLENDS.values() for (m, _, _) in blend}
    ztable: Dict[Tuple[str, str], Tuple[float, float]] = {}
    for key in metric_keys:
        ztable[(key, "LEAGUE")] = zstats([raws[i][key] for i in league])
        ztable[(key, "GK")] = zstats([raws[i][key] for i in gks]) if gks else (0.0, 1.0)

    # pass 1: raw attribute z per player (pre-shrinkage)
    raw_attr_z: List[Dict[str, float]] = []
    for i, p in enumerate(players):
        zs: Dict[str, float] = {}
        for attr, blend in BLENDS.items():
            if attr in GK_ONLY and p.position != "GK":
                continue
            cohort = "GK" if attr in GK_ONLY else "LEAGUE"
            z = 0.0
            w_present = 0.0
            for metric, weight, invert in blend:
                value = raws[i][metric]
                if value is None:
                    continue  # metric unavailable for this player's league/page
                if metric in AGE_CURVE_METRICS:
                    mz = value  # already a z-offset
                else:
                    mu, sd = ztable[(metric, cohort)]
                    mz = (value - mu) / sd
                z += weight * (-mz if invert else mz)
                w_present += weight
            # re-normalize to keep the scale; all-missing → impute later
            zs[attr] = (z / w_present) if w_present > 0 else None
        raw_attr_z.append(zs)

    # position-group mean of each attribute z — the shrinkage target
    group_sum: Dict[Tuple[str, str], List[float]] = defaultdict(lambda: [0.0, 0.0])
    for i, p in enumerate(players):
        for attr, z in raw_attr_z[i].items():
            if z is None:
                continue
            acc = group_sum[(attr, p.position)]
            acc[0] += z
            acc[1] += 1
    group_mean = {k: (s / n if n else 0.0) for k, (s, n) in group_sum.items()}

    out = []
    for i, p in enumerate(players):
        attrs: Dict[str, int] = {}
        zcache: Dict[str, float] = {}
        w = p.minutes / (p.minutes + config.SHRINK_M0)
        imputed: List[str] = []
        for attr in BLENDS:
            if attr in GK_ONLY and p.position != "GK":
                attrs[attr] = OUTFIELD_GK_ATTR
                continue
            target = group_mean.get((attr, p.position), 0.0)
            own = raw_attr_z[i][attr]
            if own is None:
                z = target  # metric absent for this league — position-group prior
                imputed.append(attr)
            else:
                z = w * own + (1 - w) * target
            zcache[attr] = z
            attrs[attr] = squash(z)
        # setPieceDelivery = blend of crossing/vision z (post-shrink)
        attrs[SPD_DERIVED] = squash(0.5 * zcache.get("crossing", 0.0) + 0.5 * zcache.get("vision", 0.0))

        mu_m, sd_m = ztable[("minutes_pct", "LEAGUE")]
        out.append({
            "attributes": {a: attrs[a] for a in ATTR_ORDER},
            "position": p.position,
            "minutes": p.minutes,
            "age": p.age,
            "low_confidence": sorted(LOW_CONFIDENCE | set(imputed)),
            "minutes_pct_z": ((raws[i]["minutes_pct"] or 0.0) - mu_m) / sd_m,
        })
    return out


def injury_proneness(age: float, minutes_pct_z: float) -> int:
    """Fallback prior — the TM dump has no injuries table (MAPPING.md)."""
    raw = config.INJURY_BASE + config.INJURY_AGE_SLOPE * max(0.0, age - 24) - config.INJURY_MINUTES_WEIGHT * minutes_pct_z
    return max(1, min(20, round(raw)))
