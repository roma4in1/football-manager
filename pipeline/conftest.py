# pytest imports the flat pipeline modules (names, join, …) — this conftest
# puts pipeline/ on sys.path regardless of the invocation directory.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
