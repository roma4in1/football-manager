/**
 * The auction room (DESIGN-BRIEF sketch): three-pane landscape.
 *  center — the LIVE LOT, focal point: position-aware stat summary (full
 *           profile on tap), high bid, bid/raise, the soft-close timer with
 *           a visible extension pulse; the nomination picker when no lot.
 *  left   — squad progress toward squadMin + per-position thin-warnings so a
 *           manager doesn't overspend while short a position.
 *  right  — money: the FIXED bidding balance (pre-committed split — no
 *           facility buttons here), wage room, the split slider until the
 *           first bid, signings so far.
 * The tightest 375px fit in the app: the lot never scrolls; both side panes
 * scroll in-box. Polls every 5s (live lots move fast).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Coins, Gavel, Search, Users, Wallet } from 'lucide-react';
import type { Attributes } from '@fm/engine/types';
import { LEAGUE_CFG, wageFromMarketValue } from '@fm/engine/config';
import { groupOf } from '@fm/engine/eligibility';
import { api, ApiError, type AuctionStateView, type PoolPlayerView } from '../api.ts';
import { Countdown } from '../components.tsx';
import { fmtMoney } from '../format.ts';
import { PosChip } from '../shell/Section.tsx';
import { EmptyState, PositionRating } from '../data.tsx';
import { ConfirmDialog, useToast } from '../ui.tsx';

const POLL_MS = 5_000;
const POOL_PAGE = 100; // rows rendered per scroll chunk — the WHOLE pool stays reachable
const POSITIONS = ['ALL', 'GK', 'DF', 'MF', 'FW'] as const;
const RESERVE_GROWTH_PCT = 10; // LEAGUE_CFG.reserveGrowthRate, shown to the manager

const XI_MIN: Record<string, number> = { GK: 1, DF: 4, MF: 4, FW: 2 };
const attrLabel = (k: string) => k.replace(/^gk/, 'gk ').replace(/([A-Z])/g, ' $1').toLowerCase();

/** DISPLAY ONLY: which 6–8 attributes to SHOW on the bid card for a role — a
 *  readable profile, NOT a valuation. The headline number is PositionRating,
 *  which reads the engine's real per-position composite (data.tsx). */
const BID_STATS: Record<string, Array<keyof Attributes>> = {
  GK: ['gkReflexes', 'gkPositioning', 'gkDistribution', 'composure', 'decisions', 'jumping'],
  DF: ['tackling', 'marking', 'positioning', 'heading', 'strength', 'pace', 'anticipation'],
  MF: ['passing', 'vision', 'firstTouch', 'longPassing', 'stamina', 'decisions', 'workRate'],
  FW: ['finishing', 'offTheBall', 'pace', 'dribbling', 'composure', 'heading'],
};

function SplitPanel({ you, onSet }: {
  you: AuctionStateView['you'];
  onSet: (reserve: number) => Promise<void>;
}) {
  const [reserve, setReserve] = useState(you.totalPot - you.auctionBudget);
  if (you.splitLocked) {
    return (
      <p className="muted" style={{ margin: '0.2rem 0' }}>
        Split locked: brought <strong>{fmtMoney(you.auctionBudget)}</strong>, reserve{' '}
        <strong>{fmtMoney(you.reserve)}</strong>.
      </p>
    );
  }
  return (
    <div>
      <label className="slider" style={{ margin: '0.2rem 0' }}>
        bring {fmtMoney(you.totalPot - reserve)} · reserve {fmtMoney(reserve)}
        <input
          type="range" min={0} max={you.totalPot} step={Math.max(1_000, Math.round(you.totalPot / 200))}
          value={reserve}
          onChange={(e) => setReserve(Number(e.target.value))}
          onMouseUp={() => void onSet(reserve)}
          onTouchEnd={() => void onSet(reserve)}
        />
      </label>
      <p className="faint" style={{ fontSize: '0.72rem', margin: 0 }}>
        Reserve spends on facilities + the mid-season window only, grows {RESERVE_GROWTH_PCT}%/season.
        Locks at your first bid; unspent bring half-converts.
      </p>
    </div>
  );
}

export function AuctionScreen() {
  const [state, setState] = useState<AuctionStateView | null>(null);
  const [poolList, setPoolList] = useState<PoolPlayerView[]>([]);
  const [amount, setAmount] = useState<number>(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>('ALL');
  const [fullProfile, setFullProfile] = useState(false);
  const [visible, setVisible] = useState(POOL_PAGE);
  const poolListRef = useRef<HTMLUListElement>(null);
  const [extended, setExtended] = useState(false);
  const prevCloseRef = useRef<string | null>(null);
  const [squadPositions, setSquadPositions] = useState<string[]>([]);
  const [pendingBid, setPendingBid] = useState<number | null>(null); // amount awaiting confirmation
  const [bidBusy, setBidBusy] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    const s = await api.auctionState();
    setState(s);
    if (s.phase === 'auction') {
      // the nomination picker is the only consumer of the pool (2k+ rows with
      // attribute blobs) — fetch it only when the picker can render
      if (!s.lot && s.turn?.you) setPoolList((await api.auctionPool()).players);
      api.squad().then((r) => setSquadPositions(r.players.map((p) => p.position)), () => {});
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(iv);
  }, [load]);

  // the soft close, made VISIBLE: pulse when a bid pushes closesAt out
  useEffect(() => {
    const closes = state?.lot?.closesAt ?? null;
    if (closes && prevCloseRef.current && prevCloseRef.current !== closes) {
      setExtended(true);
      const t = setTimeout(() => setExtended(false), 1500);
      prevCloseRef.current = closes;
      return () => clearTimeout(t);
    }
    prevCloseRef.current = closes;
  }, [state?.lot?.closesAt]);

  useEffect(() => setVisible(POOL_PAGE), [search, position]);

  const filtered = useMemo(
    () =>
      poolList.filter(
        (p) =>
          (position === 'ALL' || p.position.toUpperCase().startsWith(position)) &&
          p.fullName.toLowerCase().includes(search.toLowerCase()),
      ),
    [poolList, search, position],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of squadPositions) c[groupOf(p)] += 1;
    return c;
  }, [squadPositions]);

  if (!state) return <EmptyState icon={Gavel} title="Loading the auction room…" />;

  if (state.phase !== 'auction') {
    return (
      <div className="card">
        <h2>Auction complete</h2>
        <p>The schedule is generated and matchweek 1 is open.</p>
        <a className="button primary" href="/">Go to your fixture</a>
      </div>
    );
  }

  const minBid = (state.lot?.highBid?.amount ?? 0) + LEAGUE_CFG.bidIncrementMin;

  const act = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setNotice(null);
    try {
      await fn();
      await load();
      if (done) toast(done, 'success');
    } catch (err) {
      if (err instanceof ApiError) {
        const e = err.body.error;
        setNotice(
          e === 'outbid' ? 'Outbid — someone got there first.' :
          e === 'over_budget' ? 'Over your bidding balance.' :
          e === 'wage_cap' ? 'His wage would break your cap.' :
          e === 'squad_full' ? 'Your squad is full.' :
          e === 'not_your_turn' ? 'Not your turn to nominate.' :
          e === 'lot_live' ? 'A lot is already live.' :
          e === 'split_locked' ? 'The split locked at your first bid.' :
          'Request failed.');
      } else {
        setNotice('request failed');
      }
    }
  };

  const lotPlayer = state.lot?.player ?? null;
  const bidKeys = lotPlayer ? BID_STATS[groupOf(lotPlayer.position)] : [];

  return (
    <div className="screen auction">
      {/* LEFT — squad progress + thin warnings */}
      <div className="pane pane-scroll auction-left">
        <div className="card tight">
          <h3><Users size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />Squad</h3>
          <p className="squad-progress">
            <strong>{state.you.squadCount}</strong>/{state.squadMin} needed
            <span className="progress"><span style={{ width: `${Math.min(100, (state.you.squadCount / state.squadMin) * 100)}%` }} /></span>
          </p>
          {(['GK', 'DF', 'MF', 'FW'] as const).map((g) => (
            <p key={g} className="pos-count">
              <PosChip position={g} /> {counts[g]}
              {counts[g] < XI_MIN[g] && <span className="badge badge-sus">THIN · need {XI_MIN[g]}</span>}
            </p>
          ))}
        </div>
        <div className="card tight">
          <h3>Clubs</h3>
          {state.clubs.map((c) => (
            <p key={c.clubId} className={c.you ? '' : 'muted'} style={{ margin: '0.15rem 0', fontSize: '0.82rem' }}>
              {c.name}{c.you ? ' (you)' : ''} · {c.squadCount} · {fmtMoney(c.remaining)}
            </p>
          ))}
        </div>
      </div>

      {/* CENTER — the live lot (never scrolls) or the nomination picker */}
      <div className="pane auction-center">
        {state.lot && lotPlayer ? (
          <div className={`card lot${extended ? ' extended' : ''}`}>
            <div className="lot-head">
              <PosChip position={lotPlayer.position} />
              <h2 style={{ margin: 0 }}>{lotPlayer.fullName}</h2>
              <span className={`lot-timer${extended ? ' pulse' : ''}`}>
                <Clock size={13} style={{ verticalAlign: '-2px', marginRight: 3 }} />
                <Countdown until={state.lot.closesAt} />{extended && ' +extended'}
              </span>
            </div>
            <p className="muted" style={{ margin: '0.1rem 0 0.35rem' }}>
              market value {fmtMoney(lotPlayer.marketValue)} · wage{' '}
              <strong>{fmtMoney(wageFromMarketValue(lotPlayer.marketValue))}/wk</strong>
              {(() => {
                const after = state.you.wageBill + wageFromMarketValue(lotPlayer.marketValue);
                const breaks = after > state.you.wageCap;
                return (
                  <span className={breaks ? 'error-inline' : ''}>
                    {' '}— wages if won {fmtMoney(after)}/{fmtMoney(state.you.wageCap)}{breaks && ' · OVER CAP'}
                  </span>
                );
              })()}
            </p>

            <div
              className="attr-grid lot-stats"
              onClick={() => setFullProfile((f) => !f)}
              title={fullProfile ? 'tap to collapse' : 'tap for the full profile'}
            >
              {(fullProfile ? (Object.keys(lotPlayer.attributes) as Array<keyof Attributes>) : bidKeys).map((k) => {
                const v = lotPlayer.attributes[k];
                return (
                  <span key={k} className="attr">
                    <span className="attr-name">{attrLabel(k)}</span>
                    <span className={`attr-val ${v >= 15 ? 'attr-high' : v >= 11 ? 'attr-mid' : 'attr-low'}`}>
                      {Math.round(v * 10) / 10}
                    </span>
                  </span>
                );
              })}
            </div>
            <p className="faint" style={{ fontSize: '0.7rem', margin: '0.1rem 0 0.4rem' }}>
              {fullProfile ? 'tap to collapse' : `role summary — tap for all 26`}
            </p>

            <p className="lot-bid">
              {state.lot.highBid
                ? <>High bid <strong>{fmtMoney(state.lot.highBid.amount)}</strong> — {state.lot.highBid.clubName}</>
                : <>No bids yet — opens at <strong>{fmtMoney(minBid)}</strong></>}
            </p>
            <form
              className="bid-row"
              onSubmit={(e) => {
                e.preventDefault();
                setPendingBid(amount || minBid); // confirm — a placed bid can't be retracted
              }}
            >
              <button type="button" onClick={() => setAmount(minBid)}>min {fmtMoney(minBid)}</button>
              <button type="button" onClick={() => setAmount((amount || minBid) + 10 * LEAGUE_CFG.bidIncrementMin)}>
                +{fmtMoney(10 * LEAGUE_CFG.bidIncrementMin)}
              </button>
              <input
                type="number" min={minBid} step={LEAGUE_CFG.bidIncrementMin} value={amount || ''}
                placeholder={String(minBid)}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
              <button type="submit" className="primary">Bid</button>
            </form>
          </div>
        ) : (
          <div className="card lot">
            {state.turn?.you ? (
              <>
                <h2 style={{ marginTop: 0 }}>Your turn — nominate</h2>
                <div className="pool-filter">
                  <span className="pool-search">
                    <Search size={15} aria-hidden />
                    <input type="text" placeholder="Search the pool" value={search} onChange={(e) => setSearch(e.target.value)} />
                  </span>
                  <div className="tabs">
                    {POSITIONS.map((p) => (
                      <button key={p} className={position === p ? 'active' : ''} onClick={() => setPosition(p)}>{p}</button>
                    ))}
                  </div>
                </div>
                <ul
                  className="player-list pool-list"
                  ref={poolListRef}
                  onScroll={() => {
                    const el = poolListRef.current;
                    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 300) {
                      setVisible((v) => (v < filtered.length ? v + POOL_PAGE : v));
                    }
                  }}
                >
                  {filtered.slice(0, visible).map((p) => (
                    <li key={p.playerId} className="player-row pool-row">
                      <PosChip position={p.position} />
                      <span className="pool-name">{p.fullName}</span>
                      <span className="pool-num" title="market value · wage/wk">
                        {fmtMoney(p.marketValue)}<br />
                        <span className="faint">{fmtMoney(wageFromMarketValue(p.marketValue))}/wk</span>
                      </span>
                      <span className="player-actions">
                        <PositionRating attributes={p.attributes} position={p.position} />
                        <button onClick={() => void act(() => api.nominate(p.playerId), `${p.fullName} nominated`)}>Nominate</button>
                      </span>
                    </li>
                  ))}
                  <li className="muted pool-count">
                    {Math.min(visible, filtered.length)} of {filtered.length} available shown
                    {visible < filtered.length && ' — scroll for more'}
                  </li>
                </ul>
              </>
            ) : (
              <>
                <h2 style={{ marginTop: 0 }}>No live lot</h2>
                <p className="muted">Waiting for {state.turn?.name ?? '…'} to nominate.</p>
              </>
            )}
          </div>
        )}
        {notice && <p className="error" style={{ margin: '0.3rem 0 0' }}>{notice}</p>}
      </div>

      {/* RIGHT — money (display + the split; never invest buttons) */}
      <div className="pane pane-scroll auction-right">
        <div className="card tight">
          <h3><Coins size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />Money</h3>
          <p className="money-row">
            <span className="money-label"><Wallet size={13} />balance</span>
            <span className="money-val">{fmtMoney(state.you.remaining)}</span>
          </p>
          <p className="money-sub">brought {fmtMoney(state.you.auctionBudget)} of {fmtMoney(state.you.totalPot)}</p>
          <p className="money-row">
            <span className="money-label">reserve</span>
            <span className="money-val">{fmtMoney(state.you.reserve)}</span>
          </p>
          {(() => {
            const room = Math.max(0, state.you.wageCap - state.you.wageBill);
            return (
              <>
                <p className="money-row">
                  <span className="money-label">wages</span>
                  <span className={`money-val${room === 0 ? ' over' : ''}`}>{fmtMoney(state.you.wageBill)} / {fmtMoney(state.you.wageCap)}</span>
                </p>
                <p className="money-sub">room {fmtMoney(room)}</p>
              </>
            );
          })()}
          <SplitPanel you={state.you} onSet={(reserve) => act(() => api.setAuctionSplit(reserve))} />
        </div>
        {state.signings.length > 0 && (
          <div className="card tight">
            <h3>Your signings</h3>
            {state.signings.map((s) => (
              <p key={s.playerId} style={{ margin: '0.2rem 0', fontSize: '0.82rem' }}>
                <PosChip position={s.position} /> {s.fullName} — {fmtMoney(s.price)} · {fmtMoney(s.wage)}/wk{' '}
                <select
                  value={s.duration}
                  onChange={(e) => void act(() => api.setContractDuration(s.playerId, Number(e.target.value)))}
                >
                  {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d}y</option>)}
                </select>
              </p>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingBid !== null && !!state.lot}
        title="Place this bid?"
        body={
          lotPlayer && pendingBid !== null ? (
            <>Bidding <strong>{fmtMoney(pendingBid)}</strong> for <strong>{lotPlayer.fullName}</strong>. A placed bid can't be retracted.</>
          ) : null
        }
        confirmLabel={pendingBid !== null ? `Bid ${fmtMoney(pendingBid)}` : 'Bid'}
        busy={bidBusy}
        onCancel={() => setPendingBid(null)}
        onConfirm={() => {
          const lotId = state.lot?.lotId;
          const amt = pendingBid;
          if (!lotId || amt === null) return;
          setBidBusy(true);
          void act(() => api.bid(lotId, amt), 'Bid placed').finally(() => {
            setBidBusy(false);
            setPendingBid(null);
          });
        }}
      />
    </div>
  );
}
