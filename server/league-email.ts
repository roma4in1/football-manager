/**
 * league-email.ts — production EmailDelivery via Resend (https://resend.com).
 *
 * Since the accounts arc (LOBBY-DESIGN-SPEC §3) email is used for ONE thing:
 * password-reset links. Login is email + password (no magic link), so the only
 * transactional mail left is "forgot password".
 *
 * Why Resend: single HTTPS POST, no SDK, free tier (100/day, 3k/mo) dwarfs an
 * 8-manager league's reset traffic, and domain verification is two DNS records
 * on the Cloudflare zone we already manage (docs/DEPLOY.md). The provider hides
 * behind the EmailDelivery interface, so swapping it is one module.
 *
 * No new dependency: global fetch (Node ≥ 18). Failures throw — the
 * forgot-password route swallows the error into the same 204 it returns for an
 * unknown email (no account enumeration), and logs server-side.
 */

import { LEAGUE_CFG } from '@fm/engine/config';
import type { EmailDelivery } from './league-api.ts';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TTL = `${LEAGUE_CFG.resetTokenTtlMinutes} minutes`;

export interface ResendOptions {
  apiKey: string;
  /** Verified sender, e.g. 'FM League <login@topfootballgame.com>'. */
  from: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function resendEmailDelivery(opts: ResendOptions): EmailDelivery {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async sendPasswordReset(email, url) {
      const res = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: opts.from,
          to: [email],
          subject: 'Reset your FM League password',
          text: `Reset your FM League password:\n\n${url}\n\nThe link expires in ${TTL}. If you didn't request it, ignore this email — your password is unchanged.`,
          html:
            `<p>Reset your FM League password:</p>` +
            `<p><a href="${url}">Choose a new password</a></p>` +
            `<p style="color:#667">The link expires in ${TTL}. If you didn't request it, ignore this email — your password is unchanged.</p>`,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}
