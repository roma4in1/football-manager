/**
 * club-identity.ts — the badge vocabulary and validation, shared by the server
 * (which rejects bad input) and the web client (which renders it and offers the
 * pickers). Lives in @fm/engine for the same reason league-config and
 * league-eligibility do: it is pure domain with zero runtime dependencies, and
 * web must import it without dragging server's deps.
 *
 * LOBBY-DESIGN-SPEC §6: a badge is COMPOSED from presets — a crest shape + an
 * emblem + two colours — and stored as structured data, never as an uploaded
 * image. That avoids file storage, moderation and blurry scaling, and it means
 * adding a new emblem is a code change here, not a database migration (the
 * schema deliberately does not constrain the ids).
 */

export const BADGE_SHAPES = ['shield', 'circle', 'rounded'] as const;
export const BADGE_EMBLEMS = ['ball', 'star', 'lion', 'anchor', 'bolt', 'crown', 'rose', 'none'] as const;

export type BadgeShape = (typeof BADGE_SHAPES)[number];
export type BadgeEmblem = (typeof BADGE_EMBLEMS)[number];

/** The curated palette the pickers offer. Free hex is accepted by the schema's
 *  CHECK, so this is a starting set, not a whitelist. */
export const BADGE_COLORS = [
  '#1e3a8a', '#2f6fed', '#0e9f6e', '#166534', '#b91c1c', '#dc3f54',
  '#c2660a', '#eab308', '#6d28d9', '#534ab7', '#0f172a', '#f8fafc',
] as const;

export const CLUB_NAME_MIN = 2;
export const CLUB_NAME_MAX = 32;

export interface ClubIdentity {
  name: string;
  badgeShape: BadgeShape;
  badgeEmblem: BadgeEmblem;
  primaryColor: string;
  secondaryColor: string;
}

const HEX = /^#[0-9a-f]{6}$/;

export type IdentityIssue =
  | 'name_too_short' | 'name_too_long' | 'bad_shape' | 'bad_emblem' | 'bad_color';

/**
 * Pure validation, mirrored exactly by the schema's CHECK constraints — the
 * client uses it to disable the save button, the server uses it to reject.
 * Returns every problem, not just the first, so a form can show them all.
 */
export function validateClubIdentity(input: unknown): { ok: true; value: ClubIdentity } | { ok: false; issues: IdentityIssue[] } {
  const issues: IdentityIssue[] = [];
  const o = (input ?? {}) as Record<string, unknown>;

  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (name.length < CLUB_NAME_MIN) issues.push('name_too_short');
  else if (name.length > CLUB_NAME_MAX) issues.push('name_too_long');

  const shape = o.badgeShape;
  if (!BADGE_SHAPES.includes(shape as BadgeShape)) issues.push('bad_shape');

  const emblem = o.badgeEmblem;
  if (!BADGE_EMBLEMS.includes(emblem as BadgeEmblem)) issues.push('bad_emblem');

  const primary = typeof o.primaryColor === 'string' ? o.primaryColor.toLowerCase() : '';
  const secondary = typeof o.secondaryColor === 'string' ? o.secondaryColor.toLowerCase() : '';
  if (!HEX.test(primary) || !HEX.test(secondary)) issues.push('bad_color');

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      name,
      badgeShape: shape as BadgeShape,
      badgeEmblem: emblem as BadgeEmblem,
      primaryColor: primary,
      secondaryColor: secondary,
    },
  };
}

/** Initials for the crest — the same rule the placeholder ClubBadge used, kept
 *  so a club that never picks an emblem still reads as itself. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}
