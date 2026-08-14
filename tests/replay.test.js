/**
 * Deterministic replay against the live target. Real browser, real HTTP, NO LLM.
 *
 * This is the test that carries the central claim: once a flow is recorded, invoking it
 * is a typed function call. Nothing here imports the Anthropic SDK, and none of it costs
 * an API token.
 *
 * Requires the sibling mock-bank app on :3001 (`npm run target`). Skips cleanly if it
 * is not running rather than failing, so `npm test` stays useful without it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replayCapability } from '../src/engine/replay.js';
import { parseCapability } from '../src/schema/capability.js';
import { buildLookupSavingsBalance } from './fixtures/lookup-savings-balance.js';

const TARGET = 'http://localhost:3001';

// Fake, published credentials for the local fixture — documented in the mock-bank
// README and in .env.example. Defaulted here so `npm test` works on a clean checkout;
// a real target would supply these through the environment only.
process.env.MOCK_BANK_USERNAME ??= 'teller01';
process.env.MOCK_BANK_PASSWORD ??= 'demo-password';

/**
 * Probe the target at MODULE scope, not in before().
 *
 * `it(name, { skip: ... })` evaluates its options when the test is registered, which
 * happens while the describe callback runs — strictly before any before() hook. A probe
 * in before() would therefore always report "not running" and skip everything.
 */
const targetUp = await fetch(`${TARGET}/health`, { signal: AbortSignal.timeout(2000) })
  .then((response) => response.ok)
  .catch(() => false);

// Restore seeded records so balances start at their baseline.
if (targetUp) await fetch(`${TARGET}/reset`).catch(() => {});
else {
  console.log(`\n  ⚠  mock-bank not reachable at ${TARGET} — replay tests skipped.`);
  console.log('     Start it with: npm run target\n');
}

const live = () => (targetUp ? false : 'mock-bank is not running on :3001');

describe('deterministic replay', () => {
  it('SUCCESS: returns typed outputs for a real member', { skip: live() }, async () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    const result = await replayCapability({ capability, params: { member_id: '10001' } });

    assert.equal(result.outcome, 'SUCCESS', JSON.stringify(result.failure, null, 2));
    assert.equal(result.outputs.account_number, 'SAV-10001-01');
    assert.equal(result.outputs.savings_balance, '18320.40');
    assert.equal(result.business_outcome, null);
    assert.equal(result.failure, null);
    assert.equal(result.steps.length, 8);
  });

  it('SUCCESS: is repeatable — same inputs, same outputs', { skip: live() }, async () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    const first = await replayCapability({ capability, params: { member_id: '10001' } });
    const second = await replayCapability({ capability, params: { member_id: '10001' } });

    assert.equal(first.outcome, 'SUCCESS');
    assert.equal(second.outcome, 'SUCCESS');
    assert.deepEqual(first.outputs, second.outputs);
  });

  it(
    'BUSINESS_OUTCOME: a missing element can be the answer, not a locator fault',
    { skip: live() },
    async () => {
      // Member 10002 exists but holds no savings account, so the row the read step
      // targets is simply not on the page. Without the declared business outcome this
      // would surface as a LocatorResolutionError — a hard failure for what is really
      // a perfectly good answer to the caller's question.
      const capability = parseCapability(buildLookupSavingsBalance());
      const result = await replayCapability({ capability, params: { member_id: '10002' } });

      assert.equal(result.outcome, 'BUSINESS_OUTCOME');
      assert.equal(result.business_outcome.code, 'NO_SAVINGS_ACCOUNT');
      assert.equal(result.business_outcome.step, 6);
      assert.equal(result.failure, null);
    },
  );

  it(
    'BUSINESS_OUTCOME: "no such member" is an answer, not a crash',
    { skip: live() },
    async () => {
      const capability = parseCapability(buildLookupSavingsBalance());
      const result = await replayCapability({ capability, params: { member_id: '99999' } });

      // The distinction the whole outcome contract exists for.
      assert.equal(result.outcome, 'BUSINESS_OUTCOME');
      assert.notEqual(result.outcome, 'HARD_FAILURE');
      assert.equal(result.business_outcome.code, 'MEMBER_NOT_FOUND');
      assert.equal(result.business_outcome.step, 5);
      assert.ok(result.business_outcome.message.includes('valid result'));
      assert.equal(result.failure, null);
    },
  );

  it('HARD_FAILURE: an unresolvable locator reports every candidate tried', { skip: live() }, async () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    // Break both candidates on the Search button, leaving nothing to fall back to.
    capability.steps[5].locator.candidates = [
      { kind: 'role', role: 'button', value: 'Nonexistent Button', exact: false, confidence: 0.9 },
      { kind: 'css', value: 'button#definitely-not-here', exact: false, confidence: 0.5 },
    ];

    const result = await replayCapability({ capability, params: { member_id: '10001' } });

    assert.equal(result.outcome, 'HARD_FAILURE');
    assert.equal(result.failure.error_type, 'LocatorResolutionError');
    assert.equal(result.failure.step, 5);
    // A debuggable failure names what was expected, what was seen, and what was tried.
    assert.equal(result.failure.observed.length, 2);
    assert.ok(result.failure.url.includes('/search'));
    assert.ok(result.failure.screenshot_base64);
  });

  it('ranked candidates: replay survives losing the preferred locator', { skip: live() }, async () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    // Kill the first candidate on every step that has a fallback. The recording should
    // degrade to the next candidate rather than failing — the entire argument for
    // ranked locators rather than a single selector.
    for (const step of capability.steps) {
      if (step.locator && step.locator.candidates.length > 1) {
        step.locator.candidates[0] = {
          kind: 'css',
          value: '#this-selector-was-removed-by-a-ui-revision',
          exact: false,
          confidence: 0.9,
        };
      }
    }

    const result = await replayCapability({ capability, params: { member_id: '10001' } });
    assert.equal(result.outcome, 'SUCCESS', JSON.stringify(result.failure, null, 2));
    assert.equal(result.outputs.savings_balance, '18320.40');
  });
});

describe('replay pre-flight gates', () => {
  it('rejects invalid parameters before opening a browser', async () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    const result = await replayCapability({ capability, params: { member_id: 'not-numeric' } });

    assert.equal(result.outcome, 'HARD_FAILURE');
    assert.equal(result.failure.step, 'pre-flight');
    assert.equal(result.failure.error_type, 'ParameterValidationError');
    assert.equal(result.steps.length, 0);
  });

  it('refuses to run a risky capability that is still in draft', async () => {
    const capability = parseCapability({
      ...buildLookupSavingsBalance(),
      risk_level: 'risky',
      status: 'draft',
    });
    const result = await replayCapability({ capability, params: { member_id: '10001' } });

    assert.equal(result.outcome, 'HARD_FAILURE');
    assert.equal(result.failure.error_type, 'ApprovalRequired');
    assert.match(result.failure.message, /draft/);
  });

  it('refuses a capability pointing at an unconfigured app', async () => {
    const capability = parseCapability({
      ...buildLookupSavingsBalance(),
      target: { app_id: 'never-approved', entry_route: '/login', tenant_overrides: [] },
    });
    const result = await replayCapability({ capability, params: { member_id: '10001' } });

    assert.equal(result.outcome, 'HARD_FAILURE');
    assert.equal(result.failure.error_type, 'PolicyViolation');
  });
});
