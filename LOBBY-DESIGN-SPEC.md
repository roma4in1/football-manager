# Accounts, Clubs & Leagues — Design Spec

Status: design locked, pre-build. This replaces the seeded-manager model
(`setup-production.ts` + `clubs.json`) with self-service accounts, persistent
club identity, and code-based league lobbies. Build phase-by-phase; each phase
is its own PR with gates. Production must keep working throughout (deploy only
coherent states).

---

## 1. Core model

Three layers, three lifetimes:

```
account            — email + password. Auth + settings. One per person.
  └─ club_identity — name, badge, colors. Persistent, editable anytime.
                     Travels with the account into every league.
       └─ league_entry × N — competitive state in one league. RESETS to zero
                             when you join a league. Multiple concurrent leagues
                             per account are allowed and independent.
            └─ seasons — within a league, seasons ROLL OVER (squad continuity,
                        growth) using the existing rollover system.
```

**Reset boundaries (the rule that governs everything):**
- Edit identity (name/badge/colors) → reflects across ALL the account's leagues, anytime.
- Join a NEW league → fresh `league_entry`: empty squad, starting budget, no facilities, no history *in that league*.
- New SEASON within a league → rollover: keep squad, growth, facilities, continuity.

**Concurrency:** one account can be in many leagues at once, each fully
independent. This is the defining architectural choice — see §4.

---

## 2. Data model changes

Today `clubs` conflates identity (name) with league-scoped competitive state.
Split it:

**`accounts`** (new)
- id, email (unique), password_hash (bcrypt/argon2 — never plaintext),
  created_at, password_reset fields (token, expiry).

**`club_identities`** (new — 1:1 with account)
- id, account_id, name, badge (see §6), primary_color, secondary_color,
  updated_at. Optional: career stats / trophies (leagues won, seasons played).

**`leagues`** (new)
- id, name, join_code (unique, short, shareable), host_account_id, status
  (`lobby` | `active` | `complete`), club_capacity (e.g. 8), created_at.

**`league_entries`** (was `clubs`, now league-scoped membership)
- id, league_id, account_id, club_identity_id (snapshot or FK — see note),
  budget, wage state, facilities, table position, etc. — everything that
  resets on join. Roster (`squad_players`), fixtures, auction data all FK to
  `league_entry` / `league` instead of the old `club`.

Note on identity snapshot: when a user joins a league, decide whether the entry
references the live `club_identity` (badge changes reflect retroactively in old
leagues) or snapshots name/badge/colors at join time (historical leagues keep
the look they had). Recommendation: **reference live identity** — simpler, and
a user changing their badge mid-season updating everywhere is fine/expected for
a friends' game. Revisit only if it feels wrong.

Migration: existing `clubs`/`managers` from the seeded model can be dropped
(no real season has run yet). The seeded `setup-production.ts` path is REMOVED
— testing uses the real create/join flow with two accounts.

---

## 3. Auth (email + password)

- **Sign up:** email + password → creates `account` → prompts create-club (§5).
- **Log in:** email + password → session cookie (`fm_session`, same as today —
  keep the SW `/api/*` denylist + Secure/SameSite=Lax cookie that already works).
- **Password reset:** "forgot password" → email a reset link (reuse the Resend
  integration that already works) → set new password. This is the one place
  email still matters, and it's worth having.
- Password rules: hash with argon2id or bcrypt, min length, rate-limit login
  attempts (the per-process limiter already exists — keep one Fly machine so it
  isn't halved).
- Retire magic-link redeem (`/api/auth/redeem`) OR keep it only for the reset
  flow. Decide during build; simplest is password login + email reset only.

---

## 4. League context — the big architectural shift

Because a user can be in multiple leagues, the app is no longer "you have a
club." Every game screen is scoped to a **currently-selected league**.

- `/api/me` returns the account + club_identity + a LIST of league memberships
  (with each league's status + what needs attention).
- A **league context** (selected league id) scopes squad/tactics/market/season.
  Data layer moves from `getMyClub()` → `getMyEntry(leagueId)`.
- Home becomes a **Leagues Hub** (§5): the list of your leagues + create/join.
- Every existing screen (squad, tactics, market, season, home-fixture) reads the
  selected league's entry. Add a league switcher in the nav/header.

This touches every screen. It's the bulk of the work and the reason this is an
arc, not a feature. Build the context layer first so screens migrate onto it.

---

## 5. Screens & flow

**New:**
1. **Sign up / Log in** — email + password; forgot-password.
2. **Create club** (first login) — name, badge, colors. Editable later in
   account settings. This is the identity, created once.
3. **Leagues Hub (home)** — list your leagues (name, status, attention badge:
   "auction live", "matchday", "your bid"), plus **Create league** and
   **Join league (enter code)**. Pick a league → enter it.
4. **Create league** — name + capacity → generates a shareable **join code** →
   drops you into the lobby as host.
5. **Lobby** (new season phase, pre-auction) — shows joined clubs (badges +
   names), the join code to share, waiting state, and a host **Start** control
   (enabled at min capacity; auto-suggest at full). Starting transitions the
   league `lobby → active` and opens the auction.
6. **Join league** — enter code → land in that league's lobby with your club.
7. **Account settings** — edit email/password, edit club identity
   (name/badge/colors). Changes reflect across leagues.

**Existing (now league-scoped):** squad, tactics (incl. the new lineup pitch),
market/auction, season/standings, home fixture — all read the selected league.

---

## 6. Club identity editor (badge/colors)

Keep it achievable — no freehand art. Suggested v1:
- **Name** — text.
- **Colors** — primary + secondary from a palette (or hex pickers).
- **Badge** — composed from presets: a shape/crest template + an emblem/icon
  (from a curated set) + the two colors. Renders as SVG (consistent with the
  app's SVG-based visuals, scales everywhere the club appears — hub, lobby,
  pitch, standings).
- Store as structured data (shape id, emblem id, colors), render SVG from it —
  not an uploaded image (avoids file storage, moderation, and keeps it crisp).
Later: more templates, uploaded crests (with the storage/moderation that
implies). v1 = preset composition only.

---

## 7. Season state machine change

Add a **`lobby`** phase before `auction`:

```
league created → LOBBY (clubs join by code; host starts)
              → AUCTION (opens when host starts / capacity met)
              → REGULAR SEASON → (transfer window) → ... → SEASON END
              → ROLLOVER → next season's setup (same league, squad continuity)
```

The N<4 / N>=4 rules, playoffs, rollover — all unchanged, they operate within
a league. Only the front is new: `lobby` feeds `auction` instead of
`setup-production.ts` seeding clubs directly.

Capacity/gating: the join code gates who joins; capacity caps the lobby. Only
the host starts. Consider: what if fewer than capacity join — host can start
with whoever's in (>= min viable, e.g. 2), and the schedule/rules adapt to
actual N (the club-count-aware logic already handles variable N).

---

## 8. Build phases (each its own PR, gated, production stays coherent)

**Phase 1 — Accounts + auth.** `accounts` table, sign-up/login (email+password,
hashed), session (reuse the working cookie/SW setup), password reset via email.
Gate: sign up, log in, reset password end-to-end.

**Phase 2 — Club identity.** `club_identities`, create-club screen, the
badge/color SVG editor, account settings to edit it. Gate: create + edit a club
identity; it renders as SVG.

**Phase 3 — League context refactor.** Split `clubs` → `leagues` +
`league_entries`; introduce the league-context data layer; migrate every game
screen to read the selected league. Remove `setup-production.ts` seeding. This
is the big one — likely sub-split. Gate: existing single-league play works
through the new league-scoped data layer (prove no gameplay regression).

**Phase 4 — Create/join/lobby.** League creation + join code, the Leagues Hub,
the lobby screen + the new `lobby` season phase, host-start → auction. Gate:
two accounts, one creates a league, other joins by code, host starts, auction
opens — the full real flow (this replaces seeded testing).

**Phase 5 — Multi-league polish.** League switcher, cross-league attention
surfacing on the hub, concurrent-league correctness (a user acting in two live
leagues). Gate: one account in two concurrent leagues, both playable
independently.

Each phase deploys only when coherent. Keep the aggregate engine as the default
sim throughout (the engine arc is separate). Determinism, one Fly machine, the
DEPLOY.md discipline all still apply.

---

## 9. Open/deferred (not v1)

- Trophy/career record at account level (nice, cheap-ish — could fold into
  Phase 2). Decide during build.
- Badge snapshot-vs-live (§2 note) — default live, revisit if it feels wrong.
- Uploaded custom crests (storage + moderation) — later.
- Public/discoverable leagues — not needed for a friends' game; code-only for now.
- Spectator/join-mid-season — out of scope; you join in the lobby before auction.
