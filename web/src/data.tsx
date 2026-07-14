/**
 * data.tsx — reusable data-display primitives, the "considered/professional"
 * layer shared across the persistent gameplay screens (and inherited by the
 * lobby arc). Pure/presentational, no state, no storage.
 *
 *   • ClubBadge   — the signature: a deterministic SVG crest (initials + a
 *                   name-seeded hue). The placeholder the lobby's club-identity
 *                   editor will formalize into real badge/colors.
 *   • StatusBadges, PositionRating, StatTile, Attr — consistent stat/label bits.
 *   • EmptyState  — a considered empty/loading state (never a bare line).
 *   • keyRating / POSITION_KEY_ATTRS — the position-weighted headline number
 *     the squad list and the auction summary both read from.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Attributes } from '@fm/engine/types';
import { positionScore } from '@fm/engine/eligibility';
import { fmtAttr, fmtRating } from './format.ts';

/* ── the headline rating: the engine's per-position fit score ─────────────── */

/**
 * The player's role rating on the 0–20 attribute scale. This is the ENGINE's
 * own per-position composite (positionScore → the exact weighting bestXI()
 * ranks and selects on), so the number a manager reads is the number the
 * selection + sim actually reward — no separate display formula to drift from.
 */
export function keyRating(attributes: Attributes, position: string): number {
  return Math.round(positionScore(attributes, position) * 10) / 10;
}

/** The role-rating chip — a bold, tabular number toned by strength. */
export function PositionRating({ attributes, position }: { attributes: Attributes; position: string }) {
  const r = keyRating(attributes, position);
  const tone = r >= 14 ? 'high' : r >= 11 ? 'mid' : 'low';
  return (
    <span className={`rating rating-${tone}`} title="Role rating — the engine's per-position fit score">
      {fmtRating(r)}
    </span>
  );
}

/* ── club crest (signature) ───────────────────────────────────────────────── */

const hashHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};

const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
};

/**
 * A deterministic crest for a club: a rounded shield in a name-seeded hue with
 * a darker lower band and the club's initials. Fixed lightness keeps the white
 * initials legible across every hue. Scales anywhere a club appears.
 */
export function ClubBadge({ name, size = 22 }: { name: string; size?: number }) {
  const hue = hashHue(name);
  const base = `hsl(${hue} 46% 44%)`;
  const dark = `hsl(${hue} 46% 34%)`;
  const cid = `crest-${hue}-${initialsOf(name)}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className="club-badge" role="img" aria-label={`${name} crest`}
    >
      <defs>
        <clipPath id={cid}><rect x="1" y="1" width="30" height="30" rx="9" /></clipPath>
      </defs>
      <g clipPath={`url(#${cid})`}>
        <rect x="1" y="1" width="30" height="30" fill={base} />
        <path d="M1 23 L31 13 L31 31 L1 31 Z" fill={dark} />
      </g>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      <text x="16" y="21" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff"
            fontFamily="system-ui, -apple-system, sans-serif" letterSpacing="0.02em">
        {initialsOf(name)}
      </text>
    </svg>
  );
}

/* ── status + stat bits ───────────────────────────────────────────────────── */

/** INJ / SUS / RET badges from any player-like record — one source everywhere. */
export function StatusBadges({ injuryWeeksLeft, suspendedNext, justReturned }: {
  injuryWeeksLeft: number; suspendedNext: boolean; justReturned: boolean;
}) {
  return (
    <>
      {injuryWeeksLeft > 0 && <span className="badge badge-inj">INJ {injuryWeeksLeft}w</span>}
      {suspendedNext && <span className="badge badge-sus">SUS</span>}
      {justReturned && <span className="badge badge-ret">RET</span>}
    </>
  );
}

/** A labelled stat block: big tabular value over a caption. */
export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-val">{value}</span>
      <span className="stat-tile-label">{label}</span>
    </div>
  );
}

/** One attribute cell — name + tone-coloured value, tabular. */
export function Attr({ name, value }: { name: string; value: number }) {
  const tone = value >= 15 ? 'attr-high' : value >= 11 ? 'attr-mid' : 'attr-low';
  return (
    <span className="attr">
      <span className="attr-name">{name}</span>
      <span className={`attr-val ${tone}`}>{fmtAttr(value)}</span>
    </span>
  );
}

/* ── empty / loading states ───────────────────────────────────────────────── */

/** A considered empty or loading state — an icon, a plain title, an optional
 *  next step. Never a bare "nothing here". */
export function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <Icon className="empty-icon" size={26} strokeWidth={1.6} aria-hidden />
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}
