# Data pipeline

Standalone Python pipeline (not a pnpm package): FBref Big-5 player stats +
transfermarkt-datasets open dump → `seeds/players.sql` for the league schema.

**The pipeline never touches the network.** Populating `cache/` is a human
step (DECISIONS.md):

- **primary**: drop the 2024-25 Big-5 season dump (worldfootballR_data
  release or Kaggle equivalent) into `cache/csv/` — one CSV per stat type,
  auto-detected; run.py prints a schema report if columns don't map;
- fallback: fbref per-league pages saved from a browser as
  `cache/fbref_{League}_{page}.html` (only used for stat types the dump
  lacks; the parser handles tables inside HTML comments and in the live DOM);
- drop the transfermarkt-datasets `players.csv` in as `cache/tm_players.csv`.

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py            # cache → seeds/players.sql + reports
.venv/bin/python -m pytest tests   # transform-layer tests, fixtures only
```

- `MAPPING.md` — the attribute derivation contract (review this first).
- `config.py` — every tunable constant.
- `reports/unmatched.md` — join misses; fix via `manual-matches.csv`
  (`fbref_id,tm_id` rows) and re-run.
- `reports/distributions.md` — per-attribute histograms + top-20 sanity lists.
- Missing/empty cache pages don't block the run: affected metrics are imputed
  from the position-group mean and flagged in `source_meta.low_confidence`.
