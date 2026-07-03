"""Cache coverage audit: which league/page tables are populated."""
import json, warnings
warnings.filterwarnings("ignore")
from pathlib import Path
import fbref_parse
from fetch import PAGE_MARKERS

def main():
    unavailable, ok, low = [], 0, []
    for f in sorted((Path(__file__).parent / "cache").glob("fbref_*.html")):
        league, page = f.stem.replace("fbref_", "").rsplit("_", 1)
        try:
            rows = fbref_parse.parse_players(f.read_text(), fbref_parse.TABLE_IDS[page])
        except ValueError:
            unavailable.append(f"{league}/{page}")
            continue
        n = sum(1 for r in rows if (r.get(PAGE_MARKERS[page]) or "").strip())
        if n > len(rows) * 0.5:
            ok += 1
        else:
            low.append(f"{league}/{page}: {n}/{len(rows)}")
    print(f"{ok} pages populated")
    print("low:", low)
    print("unavailable:", unavailable)

if __name__ == "__main__":
    main()
