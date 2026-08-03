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
import type { BadgeEmblem, BadgeShape, ClubIdentity } from '@fm/engine/club-identity';
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
/** The emblem glyphs — drawn on a 32×32 crest, centred, deliberately simple so
 *  they stay legible at the 22px the squad list and standings render. */
const EMBLEMS: Record<BadgeEmblem, string | null> = {
  none: null,
  ball: 'M16 9.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 2.2l3.2 2.3-1.2 3.8h-4L12.8 14z',
  star: 'M16 9l2.1 4.5 4.9.6-3.6 3.3 1 4.8-4.4-2.5-4.4 2.5 1-4.8-3.6-3.3 4.9-.6z',
  lion: 'M16 9c-3 0-5.5 2.2-5.5 5 0 1.6.8 3 2 4l-.7 2.8 2.6-1.3c.5.1 1 .2 1.6.2s1.1-.1 1.6-.2l2.6 1.3-.7-2.8c1.2-1 2-2.4 2-4 0-2.8-2.5-5-5.5-5zm-2 4.4a.9.9 0 110 1.8.9.9 0 010-1.8zm4 0a.9.9 0 110 1.8.9.9 0 010-1.8z',
  anchor: 'M15 9h2v2.2h1.8v1.8H17v6.4c2-.3 3.4-1.6 3.7-3.4h1.9c-.4 3.2-2.9 5.4-6.6 5.6-3.7-.2-6.2-2.4-6.6-5.6h1.9c.3 1.8 1.7 3.1 3.7 3.4V13h-1.8v-1.8H15z',
  bolt: 'M17.8 9l-6 7.4h3.4L14 23l6.2-7.8h-3.6z',
  crown: 'M10 21l-1.2-8 4 2.6L16 10l3.2 5.6 4-2.6L22 21z',
  rose: 'M16 9.5c-3 0-5.4 2.2-5.4 4.9 0 3.3 3.4 6 5.4 8.1 2-2.1 5.4-4.8 5.4-8.1 0-2.7-2.4-4.9-5.4-4.9zm0 2.6a2.3 2.3 0 110 4.6 2.3 2.3 0 010-4.6z',
};

const SHAPE_PATHS: Record<BadgeShape, string> = {
  shield: 'M16 1 L30 5 V16 C30 24 23 29 16 31 C9 29 2 24 2 16 V5 Z',
  circle: 'M16 1 A15 15 0 1 1 15.99 1 Z',
  rounded: 'M1 1 h30 v30 h-30 Z',
};

/**
 * The club crest. Renders the account's STORED identity (accounts-arc phase 2:
 * a shape + an emblem + two colours, composed from presets per
 * LOBBY-DESIGN-SPEC §6) when one exists.
 *
 * Without an identity it falls back to the original name-derived placeholder — a
 * hashed hue and the club's initials — so every existing call site (standings,
 * squad rows) keeps working for clubs whose account has not made one yet, and
 * for seeded clubs that have no account at all.
 */
export function ClubBadge({ name, identity, size = 22 }: {
  name: string;
  identity?: ClubIdentity | null;
  size?: number;
}) {
  const hue = hashHue(name);
  const primary = identity?.primaryColor ?? `hsl(${hue} 46% 44%)`;
  const secondary = identity?.secondaryColor ?? `hsl(${hue} 46% 34%)`;
  const shape = identity ? SHAPE_PATHS[identity.badgeShape] : SHAPE_PATHS.rounded;
  const emblem = identity ? EMBLEMS[identity.badgeEmblem] : null;
  const uid = `crest-${identity ? `${identity.badgeShape}-${identity.badgeEmblem}-${primary.slice(1)}-${secondary.slice(1)}` : `${hue}-${initialsOf(name)}`}`;

  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className="club-badge" role="img" aria-label={`${name} crest`}
    >
      <defs>
        <clipPath id={uid}><path d={shape} /></clipPath>
      </defs>
      <g clipPath={`url(#${uid})`}>
        <rect x="0" y="0" width="32" height="32" fill={primary} />
        {/* the lower band: the second colour, always present so both choices read */}
        <path d="M0 22 L32 12 L32 32 L0 32 Z" fill={secondary} />
        {emblem
          ? <path d={emblem} fill="#fff" fillOpacity="0.92" />
          : (
            <text x="16" y="21" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff"
                  fontFamily="system-ui, -apple-system, sans-serif" letterSpacing="0.02em">
              {initialsOf(name)}
            </text>
          )}
      </g>
      <path d={shape} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
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
