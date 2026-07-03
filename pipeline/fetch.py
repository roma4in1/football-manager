"""Source fetching with a disk cache — re-runs never touch the network.

fbref: live mode (throttled well under their 10 req/min budget) or wayback
mode (web.archive.org snapshots) to prime the cache from blocked networks.
transfermarkt: one CSV download from the open-dump mirror.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests

import config
from fbref_parse import TABLE_IDS, parse_players

CACHE = Path(__file__).parent / "cache"

# one marker column per page — a snapshot is only accepted when the column is
# populated (fbref's late-2025 provider change RETROACTIVELY emptied advanced
# columns on newer snapshots of the same URL)
PAGE_MARKERS = {
    "stats": "minutes", "shooting": "shots", "passing": "passes_pct_long",
    "defense": "tackles", "possession": "carries", "misc": "fouls",
    "playingtime": "minutes_pct", "keepers": "gk_saves",
}


def _populated(html: str, page: str) -> bool:
    try:
        rows = parse_players(html, TABLE_IDS[page])
    except ValueError:
        return False
    if not rows:
        return False
    marker = PAGE_MARKERS[page]
    n = sum(1 for r in rows if (r.get(marker) or "").strip())
    return n >= max(1, len(rows) // 2)


def _get(url: str, **kwargs) -> requests.Response:
    last: Exception = RuntimeError("unreachable")
    for attempt in range(4):
        try:
            res = requests.get(url, timeout=120, headers={"User-Agent": config.FBREF_USER_AGENT}, **kwargs)
            res.raise_for_status()
            return res
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as err:
            status = getattr(getattr(err, "response", None), "status_code", None)
            if status is not None and status < 500 and status != 429:
                raise  # 4xx (except 429) won't heal on retry
            last = err
            time.sleep(10 * (attempt + 1))
    raise last


def fbref_page_path(league: str, page: str) -> Path:
    return CACHE / f"fbref_{league}_{page}.html"


def _cdx_snapshots(url: str) -> list:
    for attempt in range(5):
        res = _get(
            "http://web.archive.org/cdx/search/cdx",
            params={"url": url, "output": "json", "filter": "statuscode:200"},
        )
        try:
            rows = res.json()
            return [r[1] for r in rows[1:]]
        except ValueError:
            time.sleep(10 * (attempt + 1))  # CDX hiccup: 200 with empty body
    # transient CDX failure — crash so a resumed run retries this page
    # (a RuntimeError would wrongly persist an "unavailable" placeholder)
    raise requests.ConnectionError(f"CDX kept returning junk for {url}")


def _snapshot_candidates(url: str) -> list:
    """Newest-first, preferring the pre-provider-change window."""
    snaps = _cdx_snapshots(url)
    good = [ts for ts in snaps if ts <= config.FBREF_SNAPSHOT_BEFORE]
    rest = [ts for ts in snaps if ts > config.FBREF_SNAPSHOT_BEFORE]
    return list(reversed(good)) + list(reversed(rest))


def _fetch_wayback_page(url: str, page: str) -> tuple:
    """Walk snapshots newest-first until one has populated data; SPN as a
    last resort (only helps pages whose live version is still populated)."""
    candidates = _snapshot_candidates(url)
    if not candidates:
        print(f"no snapshot for {url} — requesting save-page-now")
        try:
            _get(f"https://web.archive.org/save/{url}")
        except requests.HTTPError:
            pass  # SPN often 5xxs while still queuing the capture
        for _ in range(12):
            time.sleep(15)
            candidates = _snapshot_candidates(url)
            if candidates:
                break
    tried = 0
    for ts in candidates:
        if tried >= 8:
            break
        tried += 1
        try:
            html = _get(f"http://web.archive.org/web/{ts}/{url}").text
        except requests.HTTPError as err:
            if getattr(err.response, "status_code", 0) == 404:
                time.sleep(20)  # fresh SPN captures lag playback
                continue
            raise
        if _populated(html, page):
            return html, ts
        print(f"  snapshot {ts} of {url} has empty columns — trying older")
        time.sleep(1.5)
    # last resort: the same league's in-season fallback page (see config)
    fallback = url.replace(config.FBREF_SEASON, config.FBREF_FALLBACK_SEASON)
    if fallback != url:
        print(f"  no populated {config.FBREF_SEASON} snapshot — falling back to {fallback}")
        for ts in _snapshot_candidates(fallback)[:8]:
            try:
                html = _get(f"http://web.archive.org/web/{ts}/{fallback}").text
            except requests.HTTPError as err:
                if getattr(err.response, "status_code", 0) == 404:
                    continue
                raise
            if _populated(html, page):
                return html, ts
            time.sleep(1.5)
    raise RuntimeError(f"no POPULATED wayback snapshot for {url}")


def fetch_fbref(force: bool = False) -> dict:
    """Fetch all league × page tables into the cache; returns {(league, page): path}."""
    CACHE.mkdir(exist_ok=True)
    mode = os.environ.get("FBREF_MODE", config.FBREF_MODE)
    out = {}
    for comp_id, league in config.FBREF_LEAGUES:
        for page in config.FBREF_PAGES:
            path = fbref_page_path(league, page)
            out[(league, page)] = path
            if path.exists() and not force:
                continue
            url = config.FBREF_BASE.format(comp_id=comp_id, page=page, league=league)
            if mode == "wayback":
                try:
                    html, ts = _fetch_wayback_page(url, page)
                    meta = {"source": "wayback", "snapshot": ts, "url": url}
                except RuntimeError as err:
                    # no populated capture anywhere: record the gap and move on —
                    # derivation imputes position-group means for missing metrics
                    print(f"UNAVAILABLE {league}/{page}: {err}")
                    html = "<html><!-- unavailable --></html>"
                    meta = {"source": "unavailable", "url": url}
                time.sleep(1.5)  # be polite to archive.org
            else:
                html = _get(url).text
                meta = {"source": "live", "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "url": url}
                time.sleep(config.FBREF_SECONDS_BETWEEN_REQUESTS)
            path.write_text(html)
            path.with_suffix(".meta.json").write_text(json.dumps(meta))
            print(f"fetched {league}/{page} ({meta['source']}, {len(html) // 1024} KiB)")
    return out


def tm_players_path() -> Path:
    return CACHE / "tm_players.csv"


def fetch_tm(force: bool = False) -> Path:
    CACHE.mkdir(exist_ok=True)
    path = tm_players_path()
    if path.exists() and not force:
        return path
    res = _get(config.TM_PLAYERS_URL)
    path.write_bytes(res.content)
    print(f"fetched tm players.csv ({len(res.content) // 1024} KiB)")
    return path


if __name__ == "__main__":
    fetch_fbref()
    fetch_tm()
