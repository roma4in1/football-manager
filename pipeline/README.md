# Data pipeline

Standalone Python pipeline (not a pnpm package): FBref Big-5 player stats +
transfermarkt-datasets open dump → `seeds/players.sql` for the league schema.

**The pipeline never touches the network.** Populating `cache/` is a human
step (fbref's CDN blocks automation; DECISIONS.md):

- save each fbref per-league season page from a browser as
  `cache/fbref_{League}_{page}.html` — leagues `Premier-League`, `La-Liga`,
  `Serie-A`, `Bundesliga`, `Ligue-1` × pages `stats`, `shooting`, `passing`,
  `defense`, `possession`, `misc`, `playingtime`, `keepers`;
- drop the transfermarkt-datasets `players.csv` in as `cache/tm_players.csv`.

Mixed provenance is fine — the parser handles fbref tables both inside HTML
comments and in the live DOM.

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
