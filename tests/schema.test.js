/**
 * The capability contract, at its boundary.
 *
 * The schema is the focal point of the design, so the things worth asserting are the
 * places it refuses: a recording that would replay unpredictably should fail on write,
 * not halfway through a replay.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCapability, safeParseCapability } from '../src/schema/capability.js';
import { ParameterValidationError, validateParams } from '../src/schema/validate-params.js';

/** The smallest recording the schema accepts, as a base for mutation. */
const capability = () => ({
  id: 'lookup-balance',
  name: 'Look up balance',
  description: 'Reads a member savings balance',
  target: { app_id: 'core-banking', entry_route: '/login' },
  input_schema: { type: 'object', properties: { member_id: { type: 'string' } }, required: ['member_id'] },
  output_schema: { type: 'object', properties: { balance: { type: 'string' } } },
  steps: [
    {
      index: 0,
      intent: 'Open the member search',
      action: 'navigate',
      url: '/members',
      expected_outcome: { type: 'url_contains', value: '/members' },
    },
  ],
  success_checkpoint: { type: 'text_visible', value: 'Balance' },
  created_from: { run_id: 'core-banking/discovery/2026-01-01_000000', recorded_at: '2026-01-01T00:00:00Z' },
  redaction_policy: { redact_fields: [] },
});

describe('capability schema', () => {
  test('accepts a minimal valid recording and applies its defaults', () => {
    const parsed = parseCapability(capability());
    assert.equal(parsed.version, 1);
    assert.equal(parsed.status, 'draft', 'a recording must be born a draft — approval is a human act');
    assert.equal(parsed.risk_level, 'safe');
    assert.deepEqual(parsed.confidence, { runs: 0, successes: 0, last_outcome: null, updated_at: null });
  });

  test('rejects an id that is not kebab-case — the id is a path and a tool name', () => {
    assert.equal(safeParseCapability({ ...capability(), id: 'Lookup Balance' }).success, false);
  });

  test('rejects a recording with no steps', () => {
    assert.equal(safeParseCapability({ ...capability(), steps: [] }).success, false);
  });

  test('rejects an action outside the five primitives', () => {
    const bad = capability();
    bad.steps[0].action = 'scroll';
    assert.equal(safeParseCapability(bad).success, false);
  });

  test('rejects a checkpoint condition outside the closed vocabulary', () => {
    const bad = capability();
    bad.success_checkpoint = { type: 'looks_about_right', value: 'Balance' };
    assert.equal(safeParseCapability(bad).success, false, 'a fuzzy matcher would smuggle nondeterminism into replay');
  });

  test('every step must assert an expected outcome', () => {
    const bad = capability();
    delete bad.steps[0].expected_outcome;
    assert.equal(safeParseCapability(bad).success, false, 'an unasserted step is a guess');
  });

  test('a bad recording fails with a field-level path, so it is debuggable', () => {
    const result = safeParseCapability({ ...capability(), id: 'Nope Nope' });
    assert.deepEqual(result.error.issues[0].path, ['id']);
  });
});

describe('parameter validation', () => {
  const schema = {
    type: 'object',
    properties: { member_id: { type: 'string' }, branch: { type: 'string' } },
    required: ['member_id'],
    additionalProperties: false,
  };

  test('accepts declared params', () => {
    assert.doesNotThrow(() => validateParams(schema, { member_id: '10001' }));
  });

  test('refuses a missing required param before the browser launches', () => {
    assert.throws(() => validateParams(schema, {}), ParameterValidationError);
  });

  test('refuses an undeclared param rather than silently ignoring it', () => {
    assert.throws(() => validateParams(schema, { member_id: '1', sneaky: 'x' }), ParameterValidationError);
  });
});
