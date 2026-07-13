/**
 * league-email.test.ts — Resend EmailDelivery (password reset), fetch injected.
 * No network, no DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resendEmailDelivery } from './league-email.ts';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, calls: Captured[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(status < 400 ? '{"id":"x"}' : '{"message":"nope"}', { status });
  }) as typeof fetch;
}

test('sendPasswordReset posts to Resend with auth header, sender, recipient and the link', async () => {
  const calls: Captured[] = [];
  const delivery = resendEmailDelivery({
    apiKey: 're_test_key',
    from: 'FM League <login@topfootballgame.com>',
    fetchImpl: fakeFetch(200, calls),
  });

  await delivery.sendPasswordReset('alpha@test.io', 'https://topfootballgame.com/reset?token=abc');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer re_test_key');
  assert.equal(headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
  assert.equal(body.from, 'FM League <login@topfootballgame.com>');
  assert.deepEqual(body.to, ['alpha@test.io']);
  assert.ok(String(body.subject).toLowerCase().includes('reset'));
  assert.ok(String(body.text).includes('https://topfootballgame.com/reset?token=abc'));
  assert.ok(String(body.html).includes('href="https://topfootballgame.com/reset?token=abc"'));
});

test('a non-2xx from Resend throws (the caller must surface the failure)', async () => {
  const calls: Captured[] = [];
  const delivery = resendEmailDelivery({ apiKey: 'k', from: 'a@b.c', fetchImpl: fakeFetch(422, calls) });
  await assert.rejects(
    () => delivery.sendPasswordReset('alpha@test.io', 'https://x/reset?token=t'),
    /resend 422/,
  );
});
