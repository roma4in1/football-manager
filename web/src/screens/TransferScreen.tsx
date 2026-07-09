import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type MarketView, type Me, type TransferStateView } from '../api.ts';

const ERROR_TEXT: Record<string, string> = {
  window_closed: 'The transfer window is closed.',
  over_budget: 'Not enough budget.',
  wage_cap: 'That wage would break your cap.',
  squad_full: 'Your squad is full.',
  seller_at_floor: 'That club cannot sell below the squad minimum.',
  not_free: 'Someone signed them first.',
  player_moved: 'That player has already moved — the offer expired.',
  offer_resolved: 'That offer is already resolved.',
  own_player: 'That player is already yours.',
  bad_fee: 'Enter a whole, positive fee.',
};

const describe = (err: unknown): string =>
  err instanceof ApiError ? ERROR_TEXT[err.body.error ?? ''] ?? 'Action failed.' : 'Action failed.';

export function TransferScreen({ me }: { me: Me }) {
  const [state, setState] = useState<TransferStateView | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offerFor, setOfferFor] = useState<{ playerId: string; name: string } | null>(null);
  const [fee, setFee] = useState('');

  const refresh = useCallback(() => {
    Promise.all([api.transferState(), api.transferMarket()])
      .then(([st, mk]) => {
        setState(st);
        setMarket(mk);
      })
      .catch(() => setError('Transfer market unavailable.'));
  }, []);
  useEffect(refresh, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOfferFor(null);
      setFee('');
      refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state || !market) {
    return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  }

  const { you } = state;
  const received = state.offers.filter((o) => o.sellerClubId === me.club.id && o.status === 'pending');
  const made = state.offers.filter((o) => o.buyerClubId === me.club.id);
  const canBuy = state.windowOpen && you.squadCount < you.squadMax;

  return (
    <div>
      <p className="muted">
        {state.windowOpen ? (
          <>Open until {state.deadlineAt ? new Date(state.deadlineAt).toLocaleString() : 'the week closes'}.</>
        ) : (
          <>Closed — the market opens for one week at mid-season.</>
        )}
        {' '}Budget <strong>{you.budgetRemaining.toLocaleString()}</strong> · wages{' '}
        <strong>{you.wageBill.toLocaleString()}</strong>/{you.wageCap.toLocaleString()} · squad{' '}
        <strong>{you.squadCount}</strong> ({you.squadMin}–{you.squadMax})
      </p>
      {error && <p className="error">{error}</p>}

      {received.length > 0 && (
        <div className="card">
          <h2>Offers for your players</h2>
          {received.map((o) => (
            <p key={o.id}>
              {o.buyerName} offers <strong>{o.fee.toLocaleString()}</strong> for {o.playerName}{' '}
              <button className="primary" disabled={busy} onClick={() => act(() => api.acceptOffer(o.id))}>
                Accept
              </button>{' '}
              <button disabled={busy} onClick={() => act(() => api.rejectOffer(o.id))}>
                Reject
              </button>
            </p>
          ))}
        </div>
      )}

      {made.length > 0 && (
        <div className="card">
          <h2>Your offers</h2>
          {made.map((o) => (
            <p key={o.id} className={o.status === 'pending' ? '' : 'muted'}>
              {o.playerName} ({o.sellerName}) — {o.fee.toLocaleString()} · {o.status}
            </p>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Free pool</h2>
        <p className="muted">Fixed price = market value; first come, first signed.</p>
        {market.pool.length === 0 && <p className="muted">Nobody left in the pool.</p>}
        {market.pool.map((p) => (
          <p key={p.playerId}>
            {p.fullName} · {p.position} · {p.marketValue.toLocaleString()} (wage {p.wage.toLocaleString()}){' '}
            <button
              className="primary"
              disabled={busy || !canBuy || p.marketValue > you.budgetRemaining}
              onClick={() => act(() => api.signPoolPlayer(p.playerId))}
            >
              Sign
            </button>
          </p>
        ))}
      </div>

      {market.clubs
        .filter((cl) => !cl.you)
        .map((cl) => (
          <div className="card" key={cl.clubId}>
            <h2>{cl.name}</h2>
            {cl.players.map((p) => (
              <p key={p.playerId}>
                {p.fullName} · {p.position} · wage {p.wage.toLocaleString()}
                {p.injuryWeeksLeft > 0 && <span className="muted"> · injured {p.injuryWeeksLeft}w</span>}{' '}
                {offerFor?.playerId === p.playerId ? (
                  <>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      placeholder="fee"
                      value={fee}
                      onChange={(e) => setFee(e.target.value)}
                    />{' '}
                    <button
                      className="primary"
                      disabled={busy || !/^\d+$/.test(fee) || Number(fee) < 1}
                      onClick={() => act(() => api.makeOffer(p.playerId, Number(fee)))}
                    >
                      Send offer
                    </button>{' '}
                    <button disabled={busy} onClick={() => setOfferFor(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    disabled={busy || !canBuy}
                    onClick={() => {
                      setOfferFor({ playerId: p.playerId, name: p.fullName });
                      setFee('');
                    }}
                  >
                    Offer…
                  </button>
                )}
              </p>
            ))}
          </div>
        ))}
    </div>
  );
}
