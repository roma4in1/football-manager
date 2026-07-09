/**
 * league-economy.test.ts — the reconciled economy scale binds where designed.
 *
 * The invariant (DECISIONS.md): the WAGE CAP is the primary constraint on
 * squad-stacking. A maxed legal squad — 4 elite (~200M market value) plus
 * squadMin filled with solid ~90M starters — fits JUST under the 150k cap,
 * a 5th elite breaks it, and the 2B budget has headroom over that basket so
 * the money is never what stops you first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUE_CFG, wageFromMarketValue } from './league-config.ts';

const ELITE_MV = 200_000_000;
const STARTER_MV = 90_000_000;

const basketWage = (elites: number, squadSize: number = LEAGUE_CFG.squadMin) =>
  elites * wageFromMarketValue(ELITE_MV) + (squadSize - elites) * wageFromMarketValue(STARTER_MV);

test('4 elite + squadMin of 90M starters fits EXACTLY at the wage cap (just under)', () => {
  const wages = basketWage(4);
  assert.ok(wages <= LEAGUE_CFG.defaultWageCap, `basket ${wages} must fit under the ${LEAGUE_CFG.defaultWageCap} cap`);
  // "exactly": within 2% of the cap — the cap binds, it doesn't merely exist
  assert.ok(
    wages >= LEAGUE_CFG.defaultWageCap * 0.98,
    `basket ${wages} leaves too much headroom — the cap would not be what stops a 5th signing`,
  );
});

test('a 5th elite breaks the cap — even trading a starter for them', () => {
  assert.ok(basketWage(5) > LEAGUE_CFG.defaultWageCap, '5 elite + starters to squadMin must exceed the cap');
});

test('filling to squadMax with starters also breaks the cap (no free depth-stacking)', () => {
  assert.ok(basketWage(4, LEAGUE_CFG.squadMax) > LEAGUE_CFG.defaultWageCap);
});

test('the 2B budget has headroom over the cap-maximal basket — wages bind first', () => {
  const basketValue = 4 * ELITE_MV + (LEAGUE_CFG.squadMin - 4) * STARTER_MV; // 1.61B
  assert.ok(basketValue < LEAGUE_CFG.defaultTransferBudget, 'the basket is affordable');
  assert.ok(
    basketValue <= LEAGUE_CFG.defaultTransferBudget * 0.85,
    'and with real headroom — the budget is not the binding constraint',
  );
});

test('facility costs are real fractions of the budget; both maxed exceeds it', () => {
  const oneFacility = LEAGUE_CFG.facilityCostByLevel.reduce((a, b) => a + b, 0);
  assert.ok(oneFacility >= LEAGUE_CFG.defaultTransferBudget * 0.25, 'one facility line is a real tradeoff');
  assert.ok(2 * oneFacility > LEAGUE_CFG.defaultTransferBudget, 'maxing BOTH still exceeds a full budget (PR #14 rule)');
  assert.ok(LEAGUE_CFG.facilityCostByLevel.every((c, i, a) => i === 0 || c > a[i - 1]), 'levels get dearer');
});

test('min bid increment is sane at the lot scale', () => {
  assert.equal(LEAGUE_CFG.bidIncrementMin, 1_000_000);
  assert.ok(LEAGUE_CFG.bidIncrementMin <= ELITE_MV * 0.01, 'fine-grained on an elite lot');
  assert.ok(LEAGUE_CFG.bidIncrementMin >= 500_000, 'not absurd at the millions scale');
});
