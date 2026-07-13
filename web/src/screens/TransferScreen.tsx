/**
 * market → transfers (DESIGN-SPEC): two-pane. Left = browse the market
 * (free pool with first-come signings, other clubs' squads with inline
 * offers); right = your window (status, budget/wage/squad, offers received
 * with accept/reject, offers made). Both panes scroll in-box.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type MarketView, type MeWithClub, type TransferStateView } from '../api.ts';
import { Countdown } from '../components.tsx';
import { PosChip } from '../shell/Section.tsx';
import { useToast } from '../ui.tsx';

const ERROR_TEXT: Record<string, string> = {
  window_closed: 'The transfer window is closed.',
  over_budget: 'Not enough reserve.',
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

export function TransferScreen({ me }: { me: MeWithClub }) {
  const [state, setState] = useState<TransferStateView | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [fee, setFee] = useState('');
  const { toast } = useToast();

  const refresh = useCallback(() => {
    Promise.all([api.transferState(), api.transferMarket()])
      .then(([st, mk]) => {
        setState(st);
        setMarket(mk);
      })
      .catch(() => setError('Transfer market unavailable.'));
  }, []);
  useEffect(refresh, [refresh]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOfferFor(null);
      setFee('');
      refresh();
      if (done) toast(done, 'success');
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
    <div className="screen transfer-panes">
      {/* MARKET — the pool + other squads, scrolls in-box */}
      <div className="pane pane-scroll" style={{ flex: '1.35 1 0' }}>
        <div className="card tight">
          <h3>Free pool — fixed price, first come</h3>
          {market.pool.length === 0 && <p className="muted">Nobody left in the pool.</p>}
          <ul className="player-list">
            {market.pool.map((p) => (
              <li key={p.playerId} className="player-row">
                <span className="player-name">{p.fullName}</span>
                <span className="player-meta">
                  <PosChip position={p.position} /> {p.marketValue.toLocaleString()} · wage {p.wage.toLocaleString()}
                </span>
                <span className="player-actions">
                  <button
                    className="primary"
                    disabled={busy || !canBuy || p.marketValue > you.budgetRemaining}
                    onClick={() => act(() => api.signPoolPlayer(p.playerId), `${p.fullName} signed`)}
                  >
                    Sign
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {market.clubs.filter((cl) => !cl.you).map((cl) => (
          <div className="card tight" key={cl.clubId}>
            <h3>{cl.name}</h3>
            <ul className="player-list">
              {cl.players.map((p) => (
                <li key={p.playerId} className="player-row">
                  <span className="player-name">{p.fullName}</span>
                  <span className="player-meta">
                    <PosChip position={p.position} /> wage {p.wage.toLocaleString()}
                    {p.injuryWeeksLeft > 0 && <span className="badge badge-inj">INJ {p.injuryWeeksLeft}w</span>}
                  </span>
                  <span className="player-actions">
                    {offerFor === p.playerId ? (
                      <>
                        <input
                          type="number" inputMode="numeric" min={1} placeholder="fee" value={fee}
                          style={{ width: '5.5rem', margin: 0 }}
                          onChange={(e) => setFee(e.target.value)}
                        />
                        <button
                          className="primary"
                          disabled={busy || !/^\d+$/.test(fee) || Number(fee) < 1}
                          onClick={() => act(() => api.makeOffer(p.playerId, Number(fee)), `Offer sent for ${p.fullName}`)}
                        >
                          Send
                        </button>
                        <button disabled={busy} onClick={() => setOfferFor(null)}>✕</button>
                      </>
                    ) : (
                      <button disabled={busy || !canBuy} onClick={() => { setOfferFor(p.playerId); setFee(''); }}>
                        Offer…
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* YOUR WINDOW — status + offers, scrolls in-box */}
      <div className="pane pane-scroll" style={{ flex: '1 1 0' }}>
        <div className={`card tight${state.windowOpen ? ' accent' : ''}`}>
          <h3>{state.windowOpen ? 'Window open' : 'Window closed'}</h3>
          <p className="muted" style={{ margin: '0.15rem 0' }}>
            {state.windowOpen && state.deadlineAt
              ? <>Closes <Countdown until={state.deadlineAt} /></>
              : 'Opens for one week at mid-season.'}
          </p>
          <p className="money-line">reserve <strong>{you.budgetRemaining.toLocaleString()}</strong></p>
          <p className="money-line muted">wages {you.wageBill.toLocaleString()} / {you.wageCap.toLocaleString()}</p>
          <p className="money-line muted">squad {you.squadCount} ({you.squadMin}–{you.squadMax})</p>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="card tight">
          <h3>Offers for your players</h3>
          {received.length === 0 && <p className="muted">None pending.</p>}
          {received.map((o) => (
            <p key={o.id} style={{ margin: '0.3rem 0' }}>
              {o.buyerName} offers <strong>{o.fee.toLocaleString()}</strong> for {o.playerName}
              <span style={{ display: 'inline-flex', gap: '0.3rem', marginLeft: '0.4rem' }}>
                <button className="primary" disabled={busy} onClick={() => act(() => api.acceptOffer(o.id), `Sold ${o.playerName}`)}>Accept</button>
                <button disabled={busy} onClick={() => act(() => api.rejectOffer(o.id), 'Offer rejected')}>Reject</button>
              </span>
            </p>
          ))}
        </div>

        {made.length > 0 && (
          <div className="card tight">
            <h3>Your offers</h3>
            {made.map((o) => (
              <p key={o.id} className={o.status === 'pending' ? '' : 'muted'} style={{ margin: '0.2rem 0' }}>
                {o.playerName} ({o.sellerName}) — {o.fee.toLocaleString()} · {o.status}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
