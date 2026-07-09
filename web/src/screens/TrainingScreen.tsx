import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type TrainingView } from '../api.ts';

const FOCUS_BLURB: Record<string, string> = {
  balanced: 'A little of everything, slowly.',
  possession: 'Passing, vision, first touch, dribbling.',
  attacking: 'Finishing, movement, crossing, set pieces.',
  defending: 'Tackling, marking, positioning, composure.',
  physical: 'Pace, stamina, strength, agility.',
};

export function TrainingScreen() {
  const [view, setView] = useState<TrainingView | null>(null);
  const [intensity, setIntensity] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(() => {
    api.training().then(
      (t) => {
        setView(t);
        setIntensity(t.intensity);
      },
      () => setError('Training unavailable.'),
    );
  }, []);
  useEffect(refresh, [refresh]);

  const save = async (focus: string, nextIntensity: number) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.setTraining(focus, nextIntensity);
      setSaved(true);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'training_closed') {
        setError('Training can only be set during the season.');
      } else {
        setError('Could not save training.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!view && !error) return <main><p className="muted">Loading…</p></main>;
  if (!view) return <main><p className="error">{error}</p></main>;

  return (
    <main>
      <h1>Training</h1>
      <p className="muted">
        Applies at each weekly tick. Ground level {view.trainingLevel}/5 scales development;{' '}
        keepers always train their craft. Growth lands at season end.
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="muted">Saved.</p>}

      <div className="card">
        <h2>Focus</h2>
        {view.focuses.map((f) => (
          <label key={f} className="radio-row">
            <input
              type="radio"
              name="focus"
              checked={view.focus === f}
              disabled={busy}
              onChange={() => void save(f, intensity)}
            />
            <strong>{f}</strong>
            <span className="muted"> — {FOCUS_BLURB[f] ?? ''}</span>
          </label>
        ))}
      </div>

      <div className="card">
        <h2>Intensity</h2>
        <p className="muted">
          Rest recovers legs but develops nothing; grinding develops more and recovers less.
        </p>
        <label className="slider">
          {intensity <= 0.15 ? 'Rest' : intensity < 0.45 ? 'Light' : intensity <= 0.65 ? 'Normal' : intensity < 0.9 ? 'Hard' : 'Flat out'}
          {' '}({intensity.toFixed(2)})
          <input
            type="range" min={0} max={1} step={0.05}
            value={intensity}
            disabled={busy}
            onChange={(e) => setIntensity(Number(e.target.value))}
            onMouseUp={() => void save(view.focus, intensity)}
            onTouchEnd={() => void save(view.focus, intensity)}
          />
        </label>
      </div>
    </main>
  );
}
