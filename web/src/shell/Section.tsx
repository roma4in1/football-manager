/**
 * Section frame: title + tab chips, body fills the remaining height.
 * `fixed` bodies never scroll as a page (two-pane screens manage their own
 * in-box scrolling — the 375px-landscape rule); default bodies scroll.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface SectionTab {
  to: string;
  label: string;
  end?: boolean;
}

export function Section({ title, tabs, fixed, children }: {
  title: string;
  tabs?: SectionTab[];
  fixed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="section">
      <div className="section-head">
        <h1>{title}</h1>
        {tabs && (
          <div className="tabs">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                {t.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
      <div className={`section-body${fixed ? ' fixed' : ''}`}>{children}</div>
    </div>
  );
}

/** Position chip — the group hue, everywhere a player appears. */
export function PosChip({ position }: { position: string }) {
  const group = position.startsWith('GK') ? 'GK' : position.startsWith('D') ? 'DF' : position.startsWith('M') ? 'MF' : 'FW';
  return <span className={`pos pos-${group}`}>{position}</span>;
}
