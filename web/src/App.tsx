import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, type Me, type MeWithClub } from './api.ts';
import { Login } from './screens/Login.tsx';
import { ResetPassword } from './screens/ResetPassword.tsx';
import { CreateClub } from './screens/CreateClub.tsx';
import { LeaguesHub } from './screens/LeaguesHub.tsx';
import { Landing } from './public/Landing.tsx';
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
      {me === 'anon' ? (
        /* The PUBLIC shell. No rotate gate: a landing page is portrait-first on
           a phone (see public/Landing.tsx). Unknown paths land on the pitch, so
           a stranger following any link gets both doors. */
        <Routes>
          <Route path="/login" element={<Login onAuthed={load} />} />
          <Route path="/signup" element={<Login initialMode="signup" onAuthed={load} />} />
          <Route path="/reset" element={<ResetPassword />} />
          <Route path="*" element={<Landing />} />
        </Routes>
      ) : (
        <Authed me={me} onReload={load} onLogout={logout} />
      )}
    </BrowserRouter>
  );
}

/**
 * The authenticated shell, in order of what the account still needs:
 *   no club identity   → name your club            (outside `.app`)
 *   no league, or /leagues → the Leagues Hub       (outside `.app`)
 *   otherwise          → the always-landscape game (inside `.app`)
 *
 * The first two render OUTSIDE `.app` on purpose: styles.css hides `.app` on a
 * portrait phone behind the rotate overlay, so anything that is a manager's
 * ONLY available screen must live outside it or it is a dead end — the bug
 * AccountLanding had, which the Hub now retires for good.
 *
 * Split out as a component so it can call useLocation (a hook needs to be
 * inside BrowserRouter), which keeps GameShell's absolute route table exactly
 * as it was — nesting it under a splat route would have made every path
 * relative.
 */
function Authed({ me, onReload, onLogout }: { me: Me; onReload: () => void; onLogout: () => void }) {
  const { pathname } = useLocation();

  if (me.clubIdentity === null) {
    return <CreateClub existing={null} onSaved={onReload} onLogout={onLogout} />;
  }
  if (pathname === '/leagues' || !me.club || !me.season) {
    return <LeaguesHub me={me} onSwitched={onReload} onLogout={onLogout} />;
  }
  return (
    <>
      <RotateOverlay />
      <GameShell me={{ ...me, club: me.club, season: me.season }} onLogout={onLogout} />
    </>
  );
}

/** Portrait phones get the one prompt the app has (styles.css hides .app under it). */
function RotateOverlay() {
  return (
    <div className="rotate-overlay">
      <span className="glyph">📱↻</span>
      <strong>Hold your phone sideways</strong>
      <span>The league plays in landscape.</span>
    </div>
  );
}

/** The logged-in, club-scoped app: the persistent rail + every game screen. */
function GameShell({ me, onLogout }: { me: MeWithClub; onLogout: () => void }) {
  const marketHome = me.season.phase === 'auction' ? '/market/auction' : '/market/transfers';

  return (
    <div className="app">
        <Rail phase={me.season.phase} clubName={me.club.name} leagueCount={me.leagues.length} onLogout={onLogout} />
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
