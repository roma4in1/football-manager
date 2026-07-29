# EAFC dot-tracker — WIP status (diagnostic session, Jul 2026)

Purpose: convert the reference/eafc 2-D tactical-view clips into
pitch-relative (105x68 m) player/ball positions, so every sim-vs-EAFC
claim rests on distributions instead of hand-measured single frames
(binding constraint identified by the builder: n=1 per class).

## Validated components (keep)
- **Homography refinement** (`refine`): given a near-correct base quad,
  re-locates the four boundary lines in warped space and corrects
  affinely. Verified on 7245/f010: boundary lines land within ±2 px of
  (0,1050)x(0,680), halfway line at x=525 (52.5 m) — mapping error
  ≈ ±0.2 m + dot-centroid noise (~±0.5 m).
- **Dot detection** (`detect`): median-background subtraction on V
  (medianBlur 61 kills the stripe texture), blob area band, k-means
  splitting of merged blobs, penalty/centre-spot exclusion, HSV team
  classes (green=Betis, white=Spurs, yellow/pink keepers, ball).
  Verified on the full-screen framing: 10/10 Spurs outfielders, ball
  found in a crowded box. Box-cluster greens undersplit — k-means
  splitting improves it; validate counts per frame (QC gate 7-12).
- **Layout clustering**: 16x9 luminance signatures group frames into
  the clip's discrete framings (menu-overlay vs full-screen); dominant
  clusters of 40-49 frames exist per clip.

## The unsolved stage (the only blocker)
**Base-quad acquisition.** The clips are handheld phone-of-screen:
4+ framings per clip, drift, moire, and — the root cause found last —
the pitch's LIGHT STRIPES overlap the boundary lines in luminance
(~140-165 vs ~150-230 depending on frame), so luminance masks feed
Hough hundreds of stripe edges. A thinness (tophat-13) mask separates
lines from stripes in principle; the stacked-mask Hough still fails to
assemble the quad (verticals short/broken). Iteration stopped at the
session's budget per the measure-don't-sink discipline.

## Recommended completion (choose one)
1. **CHEAPEST, RECOMMENDED: better footage.** Direct SCREEN RECORDING
   (console/PC capture, not phone-of-screen) makes acquisition trivial:
   static pixel-exact rectangle, no moire, hardcode the quad once. The
   entire unsolved stage disappears. 2-3 minutes of tactical-view
   capture per situation class is enough.
2. **Manual corner seeding:** view each layout-cluster's median frame
   (3-4 per clip), hand-read the four corners once per cluster,
   hardcode into CANDS, let `refine` absorb drift. ~10 minutes of
   human work; the pipeline is otherwise complete.
3. **Template search:** correlate the warped line-template (goal lines,
   boxes, halfway, circle) over scale/offset per cluster stack.

## After acquisition works — the run plan (preregistered)
- CLOCK REGIME first: p95 dot speed in wall time; <=9.5 m/s => action
  renders real-time (career-mode norm) and 1s-lag velocities are valid;
  per-90 rates are NEVER valid (game clock is ~7-8x wall).
- Validate against the 4 hand-measured frames (ledger: Spurs rest line
  ~52 m, block len ~30 m in buildup; block ~25 m long in midcirc;
  back line ~11.7 m at deep entries).
- Then the comparison battery per situation class vs engine2 probes
  (scratchpad situ-metrics.mjs / box-class.mjs of the diagnostic
  session): attachment share (<=2.5 m), per-class extents/width,
  1s-lag off-ball displacement, transition reorg.
