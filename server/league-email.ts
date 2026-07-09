/**
 * league-email.ts — production LinkDelivery via Resend (https://resend.com).
 *
 * Why Resend: single HTTPS POST, no SDK, free tier (100/day, 3k/mo) dwarfs an
 * 8-manager league's login traffic, and domain verification is two DNS records
 * on the Cloudflare zone we already manage (docs/DEPLOY.md). The provider hides
 * behind the existing LinkDelivery interface, so swapping it is one module.
 *
 * No new dependency: global fetch (Node ≥ 18). Failures throw — the
 * request-link route surfaces a 500 and the manager retries; a swallowed send
 * would look identical to the deliberate unknown-email 204.
 */

import { LEAGUE_CFG } from '@fm/engine/config';
import type { LinkDelivery } from './league-api.ts';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TTL = `${LEAGUE_CFG.authTokenTtlMinutes} minutes`;

export interface ResendOptions {
  apiKey: string;
  /** Verified sender, e.g. 'FM League <login@topfootballgame.com>'. */
  from: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function resendLinkDelivery(opts: ResendOptions): LinkDelivery {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async sendLoginLink(email, url) {
      const res = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: opts.from,
          to: [email],
          subject: 'Your FM League login link',
          text: `Sign in to FM League:\n\n${url}\n\nThe link is single-use and expires in ${TTL}. If you didn't request it, ignore this email.`,
          html:
            `<p>Sign in to FM League:</p>` +
            `<p><a href="${url}">Open FM League</a></p>` +
            `<p style="color:#667">The link is single-use and expires in ${TTL}. If you didn't request it, ignore this email.</p>`,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}
