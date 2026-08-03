/**
 * CreateClub — the account's club identity: name, crest, colours.
 * Accounts-arc phase 2 (LOBBY-DESIGN-SPEC §2/§6).
 *
 * REPLACES AccountLanding, and that fixes a real dead-end. AccountLanding
 * rendered inside `.app`, which styles.css HIDES on a portrait phone in favour
 * of the "hold your phone sideways" overlay — so a brand-new account, which is
 * exactly where the landing page's Sign up button leads, hit a blank screen.
 * This screen renders OUTSIDE `.app` as a `main.narrow` (the same frame the auth
 * screens use), so it is portrait-usable end to end: land → sign up → name your
 * club, with no rotation required. The rotate gate stays where it belongs, on
 * the always-landscape game.
 *
 * The identity is ACCOUNT-scoped, not league-scoped: it travels into every
 * league and is editable at any time, which is why create and edit are the same
 * screen and the same PUT.
 */

import { useState } from 'react';
import {
  BADGE_COLORS, BADGE_EMBLEMS, BADGE_SHAPES, CLUB_NAME_MAX, CLUB_NAME_MIN,
  validateClubIdentity, type BadgeEmblem, type BadgeShape, type ClubIdentity,
} from '@fm/engine/club-identity';
import { api } from '../api.ts';
import { ClubBadge } from '../data.tsx';
import { ActionButton, useToast } from '../ui.tsx';

const SHAPE_LABEL: Record<BadgeShape, string> = { shield: 'Shield', circle: 'Circle', rounded: 'Square' };
const EMBLEM_LABEL: Record<BadgeEmblem, string> = {
  none: 'Initials', ball: 'Ball', star: 'Star', lion: 'Lion',
  anchor: 'Anchor', bolt: 'Bolt', crown: 'Crown', rose: 'Rose',
};

export function CreateClub({ existing, onSaved, onLogout }: {
  existing: ClubIdentity | null;
  onSaved: () => void;
  onLogout?: () => void;
}) {
  const editing = existing !== null;
  const [name, setName] = useState(existing?.name ?? '');
  const [badgeShape, setShape] = useState<BadgeShape>(existing?.badgeShape ?? 'shield');
  const [badgeEmblem, setEmblem] = useState<BadgeEmblem>(existing?.badgeEmblem ?? 'ball');
  const [primaryColor, setPrimary] = useState(existing?.primaryColor ?? '#534ab7');
  const [secondaryColor, setSecondary] = useState(existing?.secondaryColor ?? '#1e3a8a');
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const draft: ClubIdentity = { name: name.trim(), badgeShape, badgeEmblem, primaryColor, secondaryColor };
  const valid = validateClubIdentity(draft).ok;
  // the preview needs a name to draw initials against; show something sane
  const preview: ClubIdentity = { ...draft, name: draft.name || 'FC' };

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api.saveClubIdentity(draft);
      toast(editing ? 'Club updated' : 'Club created', 'success');
      onSaved();
    } catch {
      setError('Could not save your club, try again.');
      throw new Error('save failed'); // let ActionButton fall back to idle
    }
  };

  return (
    <main className="narrow auth club-editor">
      <h1 className="auth-brand"><a href="/">FM League</a></h1>
      <form
        className="card auth-card"
        onSubmit={(e) => { e.preventDefault(); if (valid) void submit().catch(() => {}); }}
      >
        <h2>{editing ? 'Your club' : 'Name your club'}</h2>
        {!editing && (
          <p className="muted crest-hint">
            This is your club in every league you play. You can change it whenever you like.
          </p>
        )}

        <div className="crest-preview">
          <ClubBadge name={preview.name} identity={preview} size={72} />
        </div>

        <label className="field">
          Club name
          <input
            type="text" value={name} maxLength={CLUB_NAME_MAX} autoFocus={!editing}
            onChange={(e) => setName(e.target.value)} placeholder="Real Coteaux"
          />
        </label>

        <h3>Crest</h3>
        <div className="pick-row">
          {BADGE_SHAPES.map((s) => (
            <button key={s} type="button" aria-pressed={badgeShape === s} onClick={() => setShape(s)}>
              {SHAPE_LABEL[s]}
            </button>
          ))}
        </div>

        <h3>Emblem</h3>
        <div className="pick-row">
          {BADGE_EMBLEMS.map((e) => (
            <button key={e} type="button" aria-pressed={badgeEmblem === e} onClick={() => setEmblem(e)}>
              {EMBLEM_LABEL[e]}
            </button>
          ))}
        </div>

        <h3>Colours</h3>
        <div className="swatch-row" role="group" aria-label="Primary colour">
          {BADGE_COLORS.map((c) => (
            <button
              key={`p${c}`} type="button" className="swatch" style={{ background: c }}
              aria-label={`Primary ${c}`} aria-pressed={primaryColor === c}
              onClick={() => setPrimary(c)}
            />
          ))}
        </div>
        <div className="swatch-row" role="group" aria-label="Secondary colour">
          {BADGE_COLORS.map((c) => (
            <button
              key={`s${c}`} type="button" className="swatch" style={{ background: c }}
              aria-label={`Secondary ${c}`} aria-pressed={secondaryColor === c}
              onClick={() => setSecondary(c)}
            />
          ))}
        </div>

        {name.trim().length > 0 && name.trim().length < CLUB_NAME_MIN && (
          <p className="error">Give your club at least {CLUB_NAME_MIN} characters.</p>
        )}
        {error && <p className="error">{error}</p>}
        <ActionButton className="primary auth-cta" onAct={submit} disabled={!valid}>
          {editing ? 'Save changes' : 'Create club'}
        </ActionButton>
      </form>

      {onLogout && (
        <div className="auth-switch">
          <button className="ghost" onClick={onLogout}>Sign out</button>
        </div>
      )}
    </main>
  );
}
