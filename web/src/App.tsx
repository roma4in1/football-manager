import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { api, ApiError, type Me } from './api.ts';
import { AuctionScreen } from './screens/AuctionScreen.tsx';
import { FacilitiesScreen } from './screens/FacilitiesScreen.tsx';
import { HalfTimeScreen } from './screens/HalfTimeScreen.tsx';
import { Home } from './screens/Home.tsx';
import { LineupScreen } from './screens/LineupScreen.tsx';
import { Login } from './screens/Login.tsx';
import { ReplayScreen } from './screens/ReplayScreen.tsx';
import { ResultScreen } from './screens/ResultScreen.tsx';
import { StandingsScreen } from './screens/StandingsScreen.tsx';

export function App() {
  const [me, setMe] = useState<Me | 'anon' | 'loading'>('loading');

  useEffect(() => {
    api.me().then(setMe, (err) => {
      setMe(err instanceof ApiError && err.status === 401 ? 'anon' : 'anon');
    });
  }, []);

  if (me === 'loading') return <p className="muted center">…</p>;
  if (me === 'anon') return <Login />;

  return (
    <BrowserRouter>
      <nav className="topnav">
        <Link to="/">Home</Link>
        <Link to="/standings">Standings</Link>
        <Link to="/facilities">Facilities</Link>
        <span className="spacer" />
        <span className="muted">{me.club.name}</span>
      </nav>
      <Routes>
        <Route path="/" element={<Home me={me} />} />
        <Route path="/auction" element={<AuctionScreen />} />
        <Route path="/lineup/:fixtureId" element={<LineupScreen />} />
        <Route path="/ht/:fixtureId" element={<HalfTimeScreen me={me} />} />
        <Route path="/result/:fixtureId" element={<ResultScreen me={me} />} />
        <Route path="/replay/:fixtureId" element={<ReplayScreen me={me} />} />
        <Route path="/standings" element={<StandingsScreen />} />
        <Route path="/facilities" element={<FacilitiesScreen />} />
        <Route path="*" element={<Home me={me} />} />
      </Routes>
    </BrowserRouter>
  );
}
