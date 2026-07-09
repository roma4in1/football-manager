/**
 * Season-start auction room: current lot with countdown + bidding, own
 * budget/roster panel, nomination picker on your turn, pool browser with
 * search/position filter. Polls state every 5s (live lots move fast).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AuctionStateView, type PoolPlayerView } from '../api.ts';
import { Countdown } from '../components.tsx';

const POLL_MS = 5_000;
const POSITIONS = ['ALL', 'GK', 'DF', 'MF', 'FW'] as const;
const RESERVE_GROWTH_PCT = 10; // LEAGUE_CFG.reserveGrowthRate, shown to the manager

/**
 * Pre-auction budget split (6b): bring vs reserve, adjustable until your
 * first bid. Functional-first — the design pass restyles it.
 */
function SplitPanel({ you, onSet }: {
  you: AuctionStateView['you'];
  onSet: (reserve: number) => Promise<void>;
}) {
  const [reserve, setReserve] = useState(you.totalPot - you.auctionBudget);
  if (you.splitLocked) {
    return (
      <section className="card">
        <h3>Budget split</h3>
        <p className="muted">
          Locked at your first bid: bringing <strong>{you.auctionBudget.toLocaleString()}</strong>,
          reserve <strong>{you.reserve.toLocaleString()}</strong>.
        </p>
      </section>
    );
  }
  return (
    <section className="card">
      <h3>Budget split — set before your first bid</h3>
      <label className="slider">
        Bring {(you.totalPot - reserve).toLocaleString()} · reserve {reserve.toLocaleString()}
        <input
          type="range" min={0} max={you.totalPot} step={1000}
          value={reserve}
          onChange={(e) => setReserve(Number(e.target.value))}
          onMouseUp={() => void onSet(reserve)}
          onTouchEnd={() => void onSet(reserve)}
        />
      </label>
      <p className="muted">
        Reserve spends ONLY on facilities and the mid-season transfer window — never auction
        bidding — and grows {RESERVE_GROWTH_PCT}% when it carries into next season. Unspent
        bidding money only half-converts to reserve when the draft ends.
      </p>
    </section>
  );
}

export function AuctionScreen() {
  const [state, setState] = useState<AuctionStateView | null>(null);
  const [poolList, setPoolList] = useState<PoolPlayerView[]>([]);
  const [amount, setAmount] = useState<number>(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>('ALL');

  const load = useCallback(async () => {
    const s = await api.auctionState();
    setState(s);
    if (s.phase === 'auction') setPoolList((await api.auctionPool()).players);
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(iv);
  }, [load]);

  const filtered = useMemo(
    () =>
      poolList.filter(
        (p) =>
          (position === 'ALL' || p.position.toUpperCase().startsWith(position)) &&
          p.fullName.toLowerCase().includes(search.toLowerCase()),
      ),
    [poolList, search, position],
  );

  if (!state) return <main><p className="muted">Loading auction…</p></main>;

  if (state.phase !== 'auction') {
    return (
      <main>
        <h1>Auction complete</h1>
        <p>The schedule is generated and matchweek 1 is open.</p>
        <a className="button primary" href="/">Go to your fixture</a>
      </main>
    );
  }

  const minBid = (state.lot?.highBid?.amount ?? 0) + 1;

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        const extra = err.body.error === 'outbid' ? ` — high bid is ${(err.body as { highBid?: number }).highBid}` : '';
        setNotice(`${err.body.error ?? 'failed'}${extra}`);
        await load();
      } else {
        setNotice('request failed');
      }
    }
  };

  return (
    <main>
      <h1>Season auction</h1>

      {state.lot ? (
        <section className="card">
          <h2>
            {state.lot.player.fullName} <span className="muted">({state.lot.player.position})</span>
          </h2>
          <p className="muted">Market value {state.lot.player.marketValue.toLocaleString()}</p>
          <p>
            Closes <Countdown until={state.lot.closesAt} /> · High bid:{' '}
            {state.lot.highBid ? `${state.lot.highBid.amount} (${state.lot.highBid.clubName})` : 'none yet'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const lotId = state.lot!.lotId;
              void act(() => api.bid(lotId, amount || minBid));
            }}
          >
            <input
              type="number" min={minBid} step={1} value={amount || minBid}
              onChange={(e) => setAmount(Number(e.target.value))}
              aria-label="bid amount"
            />
            <button type="submit" className="primary">Bid</button>
          </form>
        </section>
      ) : (
        <section className="card">
          {state.turn?.you ? (
            <p><strong>Your turn to nominate</strong> — pick a player from the pool below.</p>
          ) : (
            <p className="muted">No live lot. Waiting for {state.turn?.name ?? '…'} to nominate.</p>
          )}
        </section>
      )}

      {notice && <p className="error">{notice}</p>}

      <SplitPanel you={state.you} onSet={(reserve) => act(() => api.setAuctionSplit(reserve))} />

      <section className="card">
        <h3>Your club</h3>
        <p>
          Bidding balance <strong>{state.you.remaining.toLocaleString()}</strong>
          {' '}(brought {state.you.auctionBudget.toLocaleString()} of {state.you.totalPot.toLocaleString()})
          {' '}· reserve <strong>{state.you.reserve.toLocaleString()}</strong> · squad{' '}
          <strong>{state.you.squadCount}</strong> (min {state.squadMin}, max {state.squadMax}) · wages{' '}
          {state.you.wageBill}/{state.you.wageCap}
        </p>
        {state.signings.length > 0 && (
          <ul className="status-list">
            {state.signings.map((s) => (
              <li key={s.playerId}>
                {s.fullName} ({s.position}) — paid {s.price}, wage {s.wage} ·{' '}
                <label>
                  contract{' '}
                  <select
                    value={s.duration}
                    onChange={(e) => void act(() => api.setContractDuration(s.playerId, Number(e.target.value)))}
                  >
                    {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d} season{d > 1 ? 's' : ''}</option>)}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>Clubs</h3>
        <ul className="status-list">
          {state.clubs.map((club) => (
            <li key={club.clubId}>
              {club.name}{club.you ? ' (you)' : ''} — budget {club.remaining.toLocaleString()}, squad {club.squadCount}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Player pool ({filtered.length})</h3>
        <p>
          <input
            type="search" placeholder="Search players" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="search pool"
          />
          {POSITIONS.map((pos) => (
            <button
              key={pos} type="button" aria-pressed={position === pos}
              onClick={() => setPosition(pos)}
            >
              {pos}
            </button>
          ))}
        </p>
        <ul className="player-list">
          {filtered.map((p) => (
            <li key={p.playerId} className="player-row">
              <span className="player-name">{p.fullName}</span>
              <span className="player-meta">{p.position} · MV {p.marketValue.toLocaleString()}</span>
              {state.turn?.you && !state.lot && (
                <button type="button" onClick={() => void act(() => api.nominate(p.playerId))}>
                  Nominate
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
