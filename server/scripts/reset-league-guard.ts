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
 * Safe to reset when the database cannot be a real league: no season yet, a
 * local dev host, or every club's manager email is a test address. Any club
 * with a real-looking inbox on a non-local host → refuse.
 */
export function classifyReset(input: {
  host: string;
  seasonCount: number;
  clubEmails: string[];
}): ResetVerdict {
  const { host, seasonCount, clubEmails } = input;
  const realEmails = clubEmails.filter((e) => !isTestEmail(e));
  const localHost = isLocalHost(host);
  const noSeason = seasonCount === 0;
  const allTestEmails = clubEmails.length > 0 && realEmails.length === 0;

  const safe = noSeason || localHost || allTestEmails;
  const reason = noSeason ? 'no season exists — nothing real to protect'
    : localHost ? `local host (${host}) — a dev database`
    : allTestEmails ? 'every club manager email is a test address'
    : `${realEmails.length} club(s) have real manager emails — looks like a real league`;

  return { safe, reason, realEmails };
}
