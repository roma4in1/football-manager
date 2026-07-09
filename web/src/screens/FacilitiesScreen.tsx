import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FacilitiesView } from '../api.ts';

const MEDICAL_BLURB = 'Fewer and shorter injuries, faster fatigue recovery.';
const TRAINING_BLURB = 'Faster player growth at season end (arrives with training focus).';

export function FacilitiesScreen() {
  const [view, setView] = useState<FacilitiesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.facilities().then(setView, () => setError('Facilities unavailable.'));
  }, []);
  useEffect(refresh, [refresh]);

  const invest = async (facility: 'training' | 'medical') => {
    setBusy(true);
    setError(null);
    try {
      await api.investFacility(facility);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'insufficient_budget') setError('Not enough budget.');
      else if (err instanceof ApiError && err.body.error === 'level_cap') setError('Already at the maximum level.');
      else if (err instanceof ApiError && err.body.error === 'investment_closed') setError('Investment is closed in this season phase.');
      else setError('Investment failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!view && !error) return <p className="muted">Loading…</p>;
  if (!view) return <p className="error">{error}</p>;

  const card = (key: 'training' | 'medical', title: string, blurb: string) => {
    const f = view[key];
    const affordable = f.nextCost !== null && f.nextCost <= view.budgetRemaining;
    return (
      <div className="card" key={key}>
        <h2>{title}</h2>
        <p className="facility-pips" aria-label={`${title} level ${f.level} of 5`}>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < f.level ? 'pip filled' : 'pip'} />
          ))}
          <span className="muted"> level {f.level}/5</span>
        </p>
        <p className="muted">{blurb}</p>
        {f.nextCost === null ? (
          <p className="muted">Maxed out.</p>
        ) : (
          <button
            className="primary"
            disabled={busy || !view.investmentOpen || !affordable}
            onClick={() => invest(key)}
          >
            Upgrade — {f.nextCost.toLocaleString()}
          </button>
        )}
      </div>
    );
  };

  return (
    <div>
      <p className="muted">
        Budget remaining: <strong>{view.budgetRemaining.toLocaleString()}</strong>
        {!view.investmentOpen && ' · investment opens during regular play'}
      </p>
      {error && <p className="error">{error}</p>}
      {card('medical', 'Medical centre', MEDICAL_BLURB)}
      {card('training', 'Training ground', TRAINING_BLURB)}
      <p className="muted">Youth academy: coming in a later season.</p>
    </div>
  );
}
