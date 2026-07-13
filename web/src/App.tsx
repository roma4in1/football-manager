import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError, type Me, type MeWithClub } from './api.ts';
import { Login } from './screens/Login.tsx';
import { ResetPassword } from './screens/ResetPassword.tsx';
import { AccountLanding } from './screens/AccountLanding.tsx';
import { Rail } from './shell/Rail.tsx';
import { Section } from './shell/Section.tsx';
import { TacticsSection } from './tactics/TacticsSection.tsx';
import { AuctionScreen } from './screens/AuctionScreen.tsx';
import { BracketScreen } from './screens/BracketScreen.tsx';
import { FacilitiesScreen } from './screens/FacilitiesScreen.tsx';
import { HalfTimeScreen } from './screens/HalfTimeScreen.tsx';
import { Home } from './screens/Home.tsx';
import { LineupScreen } from './screens/LineupScreen.tsx';
import { MatchDetailScreen } from './screens/MatchDetailScreen.tsx';
import { ResultsListScreen } from './screens/ResultsListScreen.tsx';
import { SquadScreen } from './screens/SquadScreen.tsx';
import { StandingsScreen } from './screens/StandingsScreen.tsx';
import { TrainingScreen } from './screens/TrainingScreen.tsx';
import { TransferScreen } from './screens/TransferScreen.tsx';

/** the rail's market badge tracks the season phase — refresh it lightly */
const ME_POLL_MS = 60_000;

const MARKET_TABS = [
  { to: '/market/auction', label: 'auction' },
  { to: '/market/transfers', label: 'transfers' },
  { to: '/market/facilities', label: 'facilities' },
];
const SQUAD_TABS = [
  { to: '/squad', label: 'players', end: true },
  { to: '/squad/training', label: 'training' },
];
const SEASON_TABS = [
  { to: '/season/results', label: 'results' },
  { to: '/season/standings', label: 'standings' },
  { to: '/season/bracket', label: 'bracket' },
];

function MatchDetailRedirect() {
  const id = window.location.pathname.split('/').pop();
  return <Navigate to={`/season/match/${id}`} replace />;
}

export function App() {
  const [me, setMe] = useState<Me | 'anon' | 'loading'>('loading');

  const load = useCallback(
    () => api.me().then(setMe, (err) => setMe(err instanceof ApiError && err.status === 401 ? 'anon' : 'anon')),
    [],
  );

  useEffect(() => {
    void load();
    const iv = setInterval(load, ME_POLL_MS);
    return () => clearInterval(iv);
  }, [load]);

  const logout = useCallback(async () => {
    try { await api.logout(); } finally { setMe('anon'); }
  }, []);

  if (me === 'loading') return <p className="muted center">…</p>;

  return (
    <BrowserRouter>
      <div className="rotate-overlay">
        <span className="glyph">📱↻</span>
        <strong>Hold your phone sideways</strong>
        <span>The league plays in landscape.</span>
      </div>
      {me === 'anon' ? (
        <Routes>
          <Route path="/reset" element={<ResetPassword />} />
          <Route path="*" element={<Login onAuthed={load} />} />
        </Routes>
      ) : me.club && me.season ? (
        <GameShell me={{ ...me, club: me.club, season: me.season }} onLogout={logout} />
      ) : (
        <AccountLanding email={me.manager.email} onLogout={logout} />
      )}
    </BrowserRouter>
  );
}

/** The logged-in, club-scoped app: the persistent rail + every game screen. */
function GameShell({ me, onLogout }: { me: MeWithClub; onLogout: () => void }) {
  const marketHome = me.season.phase === 'auction' ? '/market/auction' : '/market/transfers';

  return (
    <div className="app">
        <Rail phase={me.season.phase} clubName={me.club.name} onLogout={onLogout} />
        <div className="content">
          <Routes>
            <Route path="/" element={<Home me={me} />} />

            <Route path="/squad" element={
              <Section title="squad" fixed tabs={SQUAD_TABS}><SquadScreen /></Section>
            } />
            <Route path="/squad/training" element={
              <Section title="squad" tabs={SQUAD_TABS}><TrainingScreen /></Section>
            } />

            <Route path="/tactics" element={<TacticsSection />} />

            <Route path="/market" element={<Navigate to={marketHome} replace />} />
            <Route path="/market/auction" element={
              <Section title="market" fixed tabs={MARKET_TABS}><AuctionScreen /></Section>
            } />
            <Route path="/market/transfers" element={
              <Section title="market" fixed tabs={MARKET_TABS}><TransferScreen me={me} /></Section>
            } />
            <Route path="/market/facilities" element={
              <Section title="market" tabs={MARKET_TABS}><FacilitiesScreen /></Section>
            } />

            <Route path="/season" element={<Navigate to="/season/results" replace />} />
            <Route path="/season/results" element={
              <Section title="season" tabs={SEASON_TABS}><ResultsListScreen me={me} /></Section>
            } />
            <Route path="/season/match/:fixtureId" element={<MatchDetailScreen me={me} />} />
            <Route path="/season/standings" element={
              <Section title="season" tabs={SEASON_TABS}><StandingsScreen me={me} /></Section>
            } />
            <Route path="/season/bracket" element={
              <Section title="season" tabs={SEASON_TABS}><BracketScreen /></Section>
            } />

            {/* per-fixture flows (reached from home) */}
            <Route path="/lineup/:fixtureId" element={<LineupScreen />} />
            <Route path="/ht/:fixtureId" element={<HalfTimeScreen me={me} />} />
            <Route path="/result/:fixtureId" element={<MatchDetailRedirect />} />
            <Route path="/replay/:fixtureId" element={<MatchDetailRedirect />} />

            {/* legacy paths → their section homes */}
            <Route path="/auction" element={<Navigate to="/market/auction" replace />} />
            <Route path="/transfers" element={<Navigate to="/market/transfers" replace />} />
            <Route path="/facilities" element={<Navigate to="/market/facilities" replace />} />
            <Route path="/training" element={<Navigate to="/squad/training" replace />} />
            <Route path="/standings" element={<Navigate to="/season/standings" replace />} />
            <Route path="/playoffs" element={<Navigate to="/season/bracket" replace />} />
            <Route path="*" element={<Home me={me} />} />
          </Routes>
        </div>
      </div>
  );
}
