/**
 * The persistent left rail — 5 sections (DESIGN-SPEC nav model):
 * triage / manage / deploy / invest / compete. Market carries a live badge
 * whenever a window is open (auction or mid-season) so no window is missed.
 */

import { NavLink } from 'react-router-dom';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const ICONS = {
  home: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
      <path d="M10 21v-6h4v6" />
    </svg>
  ),
  squad: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M8 4 5 6l1.5 3L8 8.2V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.2L17.5 9 19 6l-3-2a4 4 0 0 1-8 0Z" />
    </svg>
  ),
  tactics: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M12 4v16M12 12h.01" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  ),
  market: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.8 9.2a3 3 0 0 0-2.8-1.7c-1.6 0-2.8.9-2.8 2.2 0 2.9 5.8 1.5 5.8 4.4 0 1.3-1.3 2.3-3 2.3a3.3 3.3 0 0 1-3.1-1.9M12 5.8v1.7M12 16.4v1.8" />
    </svg>
  ),
  season: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" />
      <path d="M7 5H4v1.5A3.5 3.5 0 0 0 7.5 10M17 5h3v1.5A3.5 3.5 0 0 1 16.5 10" />
      <path d="M12 13v4m-3.5 3h7M10 20l.6-3h2.8l.6 3" />
    </svg>
  ),
};

const SECTIONS = [
  { to: '/', label: 'home', icon: ICONS.home, end: true },
  { to: '/squad', label: 'squad', icon: ICONS.squad },
  { to: '/tactics', label: 'tactics', icon: ICONS.tactics },
  { to: '/market', label: 'market', icon: ICONS.market },
  { to: '/season', label: 'season', icon: ICONS.season },
];

export function Rail({ phase, clubName }: { phase: string; clubName: string }) {
  const windowOpen = phase === 'auction' || phase === 'transfer_window';
  return (
    <nav className="rail" aria-label="sections">
      {SECTIONS.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          {s.icon}
          {s.label}
          {s.label === 'market' && windowOpen && <span className="live-dot" aria-label="a market window is open" />}
        </NavLink>
      ))}
      <span className="spacer" />
      <span className="whoami">{clubName}</span>
    </nav>
  );
}
