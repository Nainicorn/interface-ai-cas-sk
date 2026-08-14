/**
 * Artifact schema and store. These run with no browser and no network.
 *
 * The roundtrip test is the load-bearing one: everything downstream assumes an artifact
 * that was saved can be read back and executed, so the boundary is checked in both
 * directions rather than only on the way in.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { parseCapability, safeParseCapability } from '../src/schema/capability.js';
import { ARTIFACTS_DIR, listVersions, loadCapability, nextVersion, saveCapability } from '../src/schema/store.js';
import { validateParams, ParameterValidationError } from '../src/schema/validate-params.js';
import { buildLookupSavingsBalance } from './fixtures/lookup-savings-balance.js';

const TEST_ID = 'test-lookup-savings-balance';

after(async () => {
  await rm(path.join(ARTIFACTS_DIR, TEST_ID), { recursive: true, force: true });
});

describe('capability schema', () => {
  it('accepts a well-formed capability', () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    assert.equal(capability.id, 'lookup-savings-balance');
    assert.equal(capability.steps.length, 8);
    assert.equal(capability.risk_level, 'safe');
  });

  it('applies declared defaults', () => {
    const capability = parseCapability(buildLookupSavingsBalance());
    // timeout_ms and `exact` are defaulted by the schema, not written by the recorder.
    assert.equal(typeof capability.steps[0].expected_outcome.timeout_ms, 'number');
    assert.equal(capability.steps[1].locator.candidates[0].exact, false);
  });

  it('rejects a capability with no steps', () => {
    const bad = { ...buildLookupSavingsBalance(), steps: [] };
    assert.equal(safeParseCapability(bad).success, false);
  });

  it('rejects an unknown action type', () => {
    const bad = buildLookupSavingsBalance();
    bad.steps[0].action = 'teleport';
    assert.equal(safeParseCapability(bad).success, false);
  });

  it('rejects a locator strategy with zero candidates', () => {
    const bad = buildLookupSavingsBalance();
    bad.steps[1].locator.candidates = [];
    assert.equal(safeParseCapability(bad).success, false);
  });

  it('requires a kebab-case id', () => {
    const bad = { ...buildLookupSavingsBalance(), id: 'Not Kebab Case' };
    assert.equal(safeParseCapability(bad).success, false);
  });
});

describe('artifact store', () => {
  it('round-trips a capability through disk unchanged', async () => {
    const original = parseCapability(buildLookupSavingsBalance({ id: TEST_ID }));
    await saveCapability(original, { overwrite: true });
    const loaded = await loadCapability(TEST_ID);
    assert.deepEqual(loaded, original);
  });

  it('tracks versions and refuses to clobber one', async () => {
    await saveCapability(buildLookupSavingsBalance({ id: TEST_ID, version: 1 }), { overwrite: true });
    await saveCapability(buildLookupSavingsBalance({ id: TEST_ID, version: 2 }), { overwrite: true });

    assert.deepEqual(await listVersions(TEST_ID), [1, 2]);
    assert.equal(await nextVersion(TEST_ID), 3);

    // Evidence records reference a specific version, so overwriting is an error.
    await assert.rejects(
      () => saveCapability(buildLookupSavingsBalance({ id: TEST_ID, version: 2 })),
      /already exists/,
    );
  });

  it('loads the latest version when none is specified', async () => {
    const loaded = await loadCapability(TEST_ID);
    assert.equal(loaded.version, 2);
  });
});

describe('parameter validation', () => {
  const schema = buildLookupSavingsBalance().input_schema;

  it('accepts valid parameters', () => {
    assert.deepEqual(validateParams(schema, { member_id: '10001' }), { member_id: '10001' });
  });

  it('rejects a missing required parameter', () => {
    assert.throws(() => validateParams(schema, {}), ParameterValidationError);
  });

  it('rejects the wrong type', () => {
    assert.throws(() => validateParams(schema, { member_id: 10001 }), /must be a string/);
  });

  it('enforces the pattern carried over from Zod', () => {
    assert.throws(() => validateParams(schema, { member_id: 'abc' }), /pattern/);
  });

  it('rejects unexpected parameters', () => {
    assert.throws(
      () => validateParams(schema, { member_id: '10001', drop_table: 'x' }),
      /not an accepted parameter/,
    );
  });
});
