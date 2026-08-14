/**
 * reset-league-guard.ts — the pure safety classifier for reset-league.ts,
 * split out so it is unit-testable with no database and no DNS. It answers one
 * question: is it safe to tear this league down, or does it look like a real
 * friends' season that must never be wiped?
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Reserved / demo domains that never reach a real inbox (RFC 2606 + the
// project's own demo/seed domains). A real manager address is never one of these.
const TEST_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example', 'test', 'invalid', 'localhost',
  'demo.io', 'demo', 'mailinator.com',
]);

/** True when a DATABASE_URL host is a local dev database (never production). */
export const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host);

/** A manager email that can only belong to a test setup, never a real friend. */
export function isTestEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.includes('+')) return true;        // sub-addressing: one human, many "clubs"
  return TEST_DOMAINS.has(domain);
}

export interface ResetVerdict {
  safe: boolean;
  reason: string;
  /** club emails that look real — the reason a populated league is refused */
  realEmails: string[];
}

/**
 * Safe to reset when the database cannot be a real league.
 *
 * ── TWO OF THESE RULES ARE NEWER THAN THE TOOL, AND BOTH EXIST BECAUSE PHASE 4
 *    CHANGED WHAT A DATABASE CAN HOLD ─────────────────────────────────────────
 *
 * THE TEARDOWN IS GLOBAL AND STAYS GLOBAL. `reset-league.ts` empties EVERY
 * league; that is right for the one thing it is for — an operator clearing a
 * pre-launch database — and it cannot be narrowed without becoming a different
 * tool (see that file's header for why ordered DELETEs are not a substitution).
 * So the guard refuses the case the tool cannot express: MORE THAN ONE LEAGUE on
 * a database that is not a dev box. "Delete one user's league" is a product
 * feature, not a teardown script, and it must be safe against leagues that are
 * live — a different problem with a different risk.
 *
 * AND "NO SEASON" STOPPED MEANING "NOTHING TO PROTECT". It meant it when the
 * only way to make a league was `setup-production.ts`, which creates the season
 * in the same act. A phase-4 LOBBY has clubs, members and a join code somebody
 * is holding, and no season at all — so the season count alone would have waved
 * it through. It is only an escape now when there are no clubs either, which is
 * the genuinely empty tree (and the state a repaired reset leaves behind).
 */
export function classifyReset(input: {
  host: string;
  seasonCount: number;
  clubCount: number;
  leagueCount: number;
  clubEmails: string[];
}): ResetVerdict {
  const { host, seasonCount, clubCount, leagueCount, clubEmails } = input;
  const realEmails = clubEmails.filter((e) => !isTestEmail(e));

  // A dev box is disposable, and `pnpm playable` leaves TWO leagues on one — so
  // this stays first and unconditional, exactly as before.
  if (isLocalHost(host)) {
    return { safe: true, reason: `local host (${host}) — a dev database`, realEmails };
  }

  // The tool has no way to remove one of several. Refuse rather than choose.
  if (leagueCount > 1) {
    return {
      safe: false,
      reason: `${leagueCount} leagues on a non-local database — this tool empties EVERY league and cannot remove one. `
        + 'Scoping it is a different tool (docs/DEPLOY.md §1.5)',
      realEmails,
    };
  }

  // The genuinely empty tree: no season AND no clubs.
  if (seasonCount === 0 && clubCount === 0) {
    return { safe: true, reason: 'no season and no clubs — nothing real to protect', realEmails };
  }

  if (clubEmails.length > 0 && realEmails.length === 0) {
    return { safe: true, reason: 'every club manager email is a test address', realEmails };
  }

  return {
    safe: false,
    reason: seasonCount === 0
      ? `${clubCount} club(s) but no season — a LOBBY league is real: its members hold a join code. `
        + `${realEmails.length} of them have real manager emails`
      : `${realEmails.length} club(s) have real manager emails — looks like a real league`,
    realEmails,
  };
}
