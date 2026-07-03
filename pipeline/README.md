# Data pipeline

Standalone Python pipeline (not a pnpm package): FBref Big-5 stats +
transfermarkt-datasets open dump → `seeds/players.sql` for the league schema.

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py            # cache-first; fetches only what's missing
FBREF_MODE=wayback .venv/bin/python run.py   # prime cache via archive.org
.venv/bin/python -m pytest tests   # transform-layer tests, no network
```

- `MAPPING.md` — the attribute derivation contract (review this first).
- `config.py` — every tunable constant.
- `reports/unmatched.md` — join misses; fix via `manual-matches.csv`
  (`fbref_id,tm_id` rows) and re-run.
- `reports/distributions.md` — per-attribute histograms + top-20 sanity lists.
- `cache/` — raw HTML/CSV; runs are deterministic given the same cache.

fbref fetching stays under their published 10 req/min budget (6.5 s between
requests, 8 requests total). The wayback mode exists because datacenter IPs
are commonly blocked by their CDN; residential `live` mode is the normal path.
