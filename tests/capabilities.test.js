/**
 * Stretch goals: confidence write-back and the agent-facing approval gate.
 * No browser, no network — these are contract tests over the store and the policy.
 *
 * The gate test worth reading: a DRAFT is refused on the agent surface even though it
 * is safe and would replay fine from the operator console. Advertised-to-agents is a
 * strictly smaller set than replayable, and that asymmetry is the design.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkAgentInvocable, checkUnattendedAllowed } from '../src/policy/risk.js';
import { parseCapability } from '../src/schema/capability.js';
import { ARTIFACTS_DIR, loadCapability, recordReplayOutcome, saveCapability } from '../src/schema/store.js';
import { buildLookupSavingsBalance } from './fixtures/lookup-savings-balance.js';

const TEST_ID = 'test-confidence-write-back';

after(async () => {
  await rm(path.join(ARTIFACTS_DIR, TEST_ID), { recursive: true, force: true });
});

describe('confidence write-back', () => {
  it('starts at zero and counts a SUCCESS', async () => {
    await saveCapability(buildLookupSavingsBalance({ id: TEST_ID, version: 1 }), { overwrite: true });

    await recordReplayOutcome(TEST_ID, 1, 'SUCCESS');
    const capability = await loadCapability(TEST_ID, 1);
    assert.deepEqual(
      { runs: capability.confidence.runs, successes: capability.confidence.successes },
      { runs: 1, successes: 1 },
    );
    assert.equal(capability.confidence.last_outcome, 'SUCCESS');
    assert.ok(capability.confidence.updated_at);
  });

  it('counts a BUSINESS_OUTCOME as executed-as-designed', async () => {
    await recordReplayOutcome(TEST_ID, 1, 'BUSINESS_OUTCOME');
    const capability = await loadCapability(TEST_ID, 1);
    assert.deepEqual(
      { runs: capability.confidence.runs, successes: capability.confidence.successes },
      { runs: 2, successes: 2 },
    );
  });

  it('counts a HARD_FAILURE as a run but not a success', async () => {
    await recordReplayOutcome(TEST_ID, 1, 'HARD_FAILURE');
    const capability = await loadCapability(TEST_ID, 1);
    assert.deepEqual(
      { runs: capability.confidence.runs, successes: capability.confidence.successes },
      { runs: 3, successes: 2 },
    );
    assert.equal(capability.confidence.last_outcome, 'HARD_FAILURE');
  });

  it('survives a round-trip — the updated artifact still validates', async () => {
    // recordReplayOutcome goes through saveCapability, which parses on the way in;
    // this asserts the loaded result is still a fully valid capability.
    const capability = await loadCapability(TEST_ID, 1);
    assert.equal(capability.id, TEST_ID);
    assert.ok(capability.steps.length > 0);
  });
});

describe('agent-invocable gate', () => {
  it('refuses a draft — even a safe one that could replay from the console', () => {
    // The shared fixture is approved so replay tests pass the unattended gate;
    // rebuild it as the draft every fresh recording starts as.
    const draft = { ...parseCapability(buildLookupSavingsBalance()), status: 'draft' };
    assert.equal(draft.risk_level, 'safe');

    // Replayable by the operator…
    assert.equal(checkUnattendedAllowed(draft).allowed, true);
    // …but invisible to agents until a human approves it.
    const verdict = checkAgentInvocable(draft);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /approved/);
  });

  it('admits an approved capability', () => {
    const approved = { ...parseCapability(buildLookupSavingsBalance()), status: 'approved' };
    assert.equal(checkAgentInvocable(approved).allowed, true);
  });
});
