/**
 * FM-style two-bar fitness split: CONDITION (1 − fatigue, the acute axis)
 * over SHARPNESS (match fitness, built by minutes, decayed by the bench).
 * Pure display — both values 0–1 from the squad view.
 */

export function FitnessBars({ fatigue, sharpness }: { fatigue: number; sharpness: number }) {
  const condition = Math.max(0, Math.min(1, 1 - fatigue));
  const sharp = Math.max(0, Math.min(1, sharpness));
  const tone = (v: number): string => (v >= 0.7 ? 'good' : v >= 0.45 ? 'mid' : 'low');
  return (
    <span className="fitbars" title={`Condition ${Math.round(condition * 100)}% · Sharpness ${Math.round(sharp * 100)}%`}>
      <span className="fitbar" aria-label={`condition ${Math.round(condition * 100)}%`}>
        <span className={`fitbar-fill ${tone(condition)}`} style={{ width: `${condition * 100}%` }} />
      </span>
      <span className="fitbar" aria-label={`sharpness ${Math.round(sharp * 100)}%`}>
        <span className={`fitbar-fill sharp ${tone(sharp)}`} style={{ width: `${sharp * 100}%` }} />
      </span>
    </span>
  );
}
