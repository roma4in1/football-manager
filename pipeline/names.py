"""Name/club normalization for the FBref↔TM join."""

from __future__ import annotations

import re

from unidecode import unidecode

_PUNCT = re.compile(r"[^a-z0-9 ]+")
_SPACES = re.compile(r"\s+")

# frequent club-name shape differences between fbref and transfermarkt
# (TM uses long legal forms: "Sevilla Fútbol Club S.A.D.", "1. FC Union Berlin e. V.")
_CLUB_NOISE = re.compile(
    r"\b(fc|cf|afc|ac|as|ss|ssc|sc|cd|rc|rcd|ud|us|club|de|calcio|futbol|futebol|football"
    r"|balompie|sad|spa|srl|ag|ev|gmbh|co|kgaa|1899|1907|04|05|09|96|1846|1893|1900|s|a|d|e|v)\b"
)


def normalize_name(name: str) -> str:
    s = unidecode(name or "").lower()
    s = _PUNCT.sub(" ", s)
    return _SPACES.sub(" ", s).strip()


def normalize_club(name: str) -> str:
    s = normalize_name(name)
    s = _CLUB_NOISE.sub(" ", s)
    return _SPACES.sub(" ", s).strip()


def clubs_match(a: str, b: str) -> bool:
    """Normalized-club comparison tolerant of legal-form leftovers.

    Equality, containment ("sevilla" ⊂ "sevilla atletico"… no — substring on
    the full string), or ≥2 shared tokens. One shared token only counts when
    one side IS that single token, so "manchester city" never matches
    "manchester united".
    """
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    ta, tb = set(a.split()), set(b.split())
    overlap = ta & tb
    if len(overlap) >= 2:
        return True
    return len(overlap) == 1 and (len(ta) == 1 or len(tb) == 1)
