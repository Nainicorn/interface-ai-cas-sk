/**
 * UI drift detection, at its pure boundary: does two page states diverging enough
 * actually cross the line, and does normal noise (reordering, one new element) stay
 * under it. No browser needed — perception.js's captureState() is what produces the raw
 * ariaTree this operates on; fingerprint() and driftScore() are what interpret it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DRIFT_THRESHOLD, driftScore, fingerprint, isDrifted } from '../src/engine/drift.js';

// Sized like a real accessibility-tree snapshot, not a toy — a genuine page has enough
// stable chrome (nav, labels, footer) that one changed value should barely move the
// score. A 4-line fixture would exaggerate a single change into "meaningful drift" by
// pure denominator effects, which isn't representative of what this runs against.
const BALANCE_PAGE = `
- navigation "Main"
- link "Dashboard"
- link "Accounts"
- link "Transfers"
- link "Sign out"
- heading "Account Overview"
- text "Member: 10001"
- text "Branch: Riverside"
- button "View Balance"
- button "View Statements"
- text "Savings: $4,213.09"
- text "Checking: $890.14"
- text "Last login: 2026-08-20"
- contentinfo "footer"
- link "Privacy policy"
- link "Contact support"
`;

const BALANCE_PAGE_REORDERED = `
- text "Savings: $4,213.09"
- link "Sign out"
- navigation "Main"
- text "Checking: $890.14"
- link "Dashboard"
- heading "Account Overview"
- link "Accounts"
- button "View Statements"
- link "Transfers"
- text "Member: 10001"
- text "Branch: Riverside"
- button "View Balance"
- link "Privacy policy"
- text "Last login: 2026-08-20"
- contentinfo "footer"
- link "Contact support"
`;

const BALANCE_PAGE_NEW_AMOUNT = BALANCE_PAGE.replace('Savings: $4,213.09', 'Savings: $6,004.50');

const CHECKOUT_PAGE = `
- navigation "Main"
- link "Cart"
- link "Sign out"
- heading "Checkout"
- textbox "Card number"
- textbox "Expiry"
- textbox "CVC"
- button "Place order"
- button "Apply coupon"
- text "Items: 3"
- text "Subtotal: $58.20"
- text "Tax: $4.66"
- contentinfo "footer"
- link "Terms of sale"
`;

describe('drift fingerprinting', () => {
  test('an identical page has zero drift', () => {
    assert.equal(driftScore(fingerprint(BALANCE_PAGE), fingerprint(BALANCE_PAGE)), 0);
  });

  test('the same elements in a different order is not drift — that is the whole point of the set', () => {
    const score = driftScore(fingerprint(BALANCE_PAGE), fingerprint(BALANCE_PAGE_REORDERED));
    assert.equal(score, 0);
    assert.equal(isDrifted(score), false);
  });

  test('one changed value among several stable lines stays under the threshold', () => {
    const score = driftScore(fingerprint(BALANCE_PAGE), fingerprint(BALANCE_PAGE_NEW_AMOUNT));
    assert.ok(score > 0, 'a genuinely different line should register as SOME difference');
    assert.ok(score < DRIFT_THRESHOLD, `expected noise-level drift, got ${score}`);
    assert.equal(isDrifted(score), false);
  });

  test('a completely different page crosses the threshold', () => {
    const score = driftScore(fingerprint(BALANCE_PAGE), fingerprint(CHECKOUT_PAGE));
    assert.ok(score > DRIFT_THRESHOLD, `expected meaningful drift, got ${score}`);
    assert.equal(isDrifted(score), true);
  });

  test('two empty snapshots are identical, not NaN', () => {
    assert.equal(driftScore(fingerprint(''), fingerprint('')), 0);
  });

  test('fingerprint ignores blank lines and surrounding whitespace', () => {
    assert.deepEqual(fingerprint('  a  \n\n  b\n'), ['a', 'b']);
  });
});
