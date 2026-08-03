/**
 * Landing — the public entry point at "/" for a visitor with no account.
 *
 * This is the PUBLIC shell, not an app screen. DESIGN-BRIEF.md's always-
 * landscape / two-pane / persistent-rail layout describes the IN-GAME app and
 * deliberately does NOT apply here: a landing page is portrait-first on a
 * phone, wide on a desktop, scrollable, conventional. What it does inherit is
 * the identity — the token system in styles.css (light surfaces, the one
 * purple accent, generous whitespace). No new colours, no new primitives.
 *
 * Copy marked PLACEHOLDER below needs a product decision; everything else is
 * described from what the game actually does today (LOBBY-DESIGN-SPEC.md).
 */

import { Link } from 'react-router-dom';

const COPY = {
  /** PLACEHOLDER — working title, taken from the PWA manifest. */
  name: 'FM League',
  eyebrow: 'A private football management game',
  headline: 'Take a club. Draft a squad. Play the season.',
  sub:
    'A browser-based football manager for you and a handful of friends. Build a squad at ' +
    'auction, set your tactics and your lineup each week, and find out over a full season ' +
    'who actually knows what they are doing.',
  heroNote: 'Runs in your browser. Nothing to install.',
  /** PLACEHOLDER — season cadence (how long a season takes in real time) is undecided,
   *  so nothing here promises one. Add it when you have a number. */
  steps: [
    {
      title: 'Take a club',
      body: 'Create an account and take charge of a club for the season.',
    },
    {
      title: 'Draft your squad at auction',
      body: 'Every club starts empty. Squads are built in a live auction — one budget, one player pool, everyone bidding against each other.',
    },
    {
      title: 'Set tactics and lineups',
      body: 'Pick your eleven, shape how the team plays through each phase of the game, and manage training and fitness between matches.',
    },
    {
      title: 'Play out the season',
      body: 'Fixtures, results, a league table, a transfer window, and playoffs when the league is big enough for them.',
    },
  ],
  honestTitle: 'What this is not',
  honestBody:
    'This is not a mass-market game. There are no strangers, no global leaderboards, no ' +
    'store. It is a league for a group of people who already know each other, playing one ' +
    'season at a time.',
  closingTitle: 'Ready to take a club?',
  /** PLACEHOLDER — footer has no contact or legal links until you decide it needs them. */
  footer: 'FM League',
};

/**
 * The brand mark: the app icon's pitch, in the light identity rather than the
 * dark one. Reduced to the halfway line and centre circle — the full pitch
 * outline turns to mush at 28px.
 */
function Mark() {
  return (
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <rect width="128" height="128" rx="30" fill="var(--accent)" />
      <g stroke="#fff" strokeWidth="9" fill="none" opacity="0.92">
        <line x1="64" y1="16" x2="64" y2="112" />
        <circle cx="64" cy="64" r="25" />
      </g>
    </svg>
  );
}

export function Landing() {
  return (
    <div className="public">
      <header className="public-head">
        <Link className="public-brand" to="/">
          <Mark />
          <span>{COPY.name}</span>
        </Link>
        <nav className="public-head-actions">
          <Link className="button ghost" to="/login">Log in</Link>
          <Link className="button primary" to="/signup">Sign up</Link>
        </nav>
      </header>

      <main className="public-main">
        <section className="hero">
          <p className="hero-eyebrow">{COPY.eyebrow}</p>
          <h1 className="hero-title">{COPY.headline}</h1>
          <p className="hero-sub">{COPY.sub}</p>
          <div className="hero-actions">
            <Link className="button primary hero-cta" to="/signup">Create an account</Link>
            <Link className="button hero-cta" to="/login">I already have one</Link>
          </div>
          <p className="hero-note">{COPY.heroNote}</p>
        </section>

        <section className="public-section">
          <h2 className="public-section-title">How a season goes</h2>
          <ol className="steps">
            {COPY.steps.map((step, i) => (
              <li className="step" key={step.title}>
                <span className="step-n" aria-hidden="true">{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="public-section">
          <div className="public-note-card">
            <h2 className="public-section-title">{COPY.honestTitle}</h2>
            <p className="muted">{COPY.honestBody}</p>
          </div>
        </section>

        <section className="public-closing">
          <h2 className="public-section-title">{COPY.closingTitle}</h2>
          <div className="hero-actions">
            <Link className="button primary hero-cta" to="/signup">Sign up</Link>
          </div>
          <p className="hero-note">
            Already have an account? <Link to="/login">Log in</Link>.
          </p>
        </section>
      </main>

      <footer className="public-foot">{COPY.footer}</footer>
    </div>
  );
}
