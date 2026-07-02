# Data sources — verified 2026-07-02

## Verdict summary

| Need | Source | Status |
|---|---|---|
| Per-90 performance stats (attribute derivation) | FBref Big-5 aggregate pages | ✅ primary |
| Market values, heights, positions, contracts | transfermarkt-datasets (open Kaggle/GitHub dump) | ✅ primary, zero scraping |
| Injury histories (proneness derivation) | transfermarkt-datasets / worldfootballR path | ⚠️ usable, see notes |
| Real fixtures/squads via API | football-data.org | ❌ dropped |

## FBref (sports-reference)
- Published rate limit: **10 req/min for FBref**, violators jailed up to a day. This is
  their own bot-traffic page — de facto tolerated scraping at that rate, despite ToS
  boilerplate prohibiting automation.
- Key consequence for pipeline design: use the **Big-5 combined league pages**
  (standard, shooting, passing, defense, possession, misc, playing-time, keepers)
  — all ~2,700 players in <10 page fetches total. Never crawl per-player pages.
- Full pipeline run ≈ 1 minute of requests. Re-run per season, not scheduled.

## Transfermarkt
- ToS prohibits scraping, but ecosystem is large and tolerated in practice.
- **Better path: don't scrape.** `dcaribou/transfermarkt-datasets` publishes cleaned
  TM data (players, valuations, appearances, transfers) as an open dataset,
  refreshed regularly. Pull the dump; join on player name + club + DOB against FBref.
- Injury histories: available via per-player TM pages (worldfootballR shows the
  route). 2,700 player-page fetches is the one genuinely gray-area scrape in the
  plan. Decision: check whether the open dataset covers injuries first; if not,
  fall back to **age + minutes-load prior only** for injuryProneness v1 and skip
  the scrape. Attribute is low-stakes; not worth the crawl.

## football-data.org — dropped
- Free tier = fixtures/results/tables only for 12 comps; player data (squads,
  lineups) requires €29/mo Deep Data. We don't need real fixtures (fantasy league)
  and can't get players free → no reason to integrate.

## Name-matching note
FBref and TM use different player IDs. Join key: normalized name + birth date
(+ club as tiebreaker). Expect ~2–5% manual fixups at 2,700 players; budget an
evening. fuzzy-match on transliterated names (unidecode) before giving up.

## Open user task (not doable from here)
- iOS PWA web-push: test on the actual friend group's devices week 1.
  Fallback if flaky: email digest for the weekly reveal.
