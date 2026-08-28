/**
 * Code generation: a capability turned into a standalone Playwright script.
 *
 * The one property that actually matters here is that the output is real, runnable
 * JavaScript — a generator that produces broken syntax is worse than no generator, since
 * it fails silently until someone tries to run it. `node --check` is the same check a
 * developer would run by hand, so that's what this asserts against.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseCapability } from '../src/schema/capability.js';
import { generatePlaywrightTest } from '../src/agent/codegen.js';
import { splitValueEquals } from '../src/engine/perception.js';

/** One capability exercising all five actions, including extraction and a fallback candidate. */
const capability = () =>
  parseCapability({
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
      {
        index: 1,
        intent: 'Search for the member',
        action: 'type',
        locator: {
          description: 'Member ID field',
          candidates: [
            { kind: 'label', value: 'Member ID', confidence: 0.9 },
            { kind: 'css', value: '#member-id', confidence: 0.4 },
          ],
        },
        value_from: 'member_id',
        expected_outcome: { type: 'text_visible', value: 'Search' },
      },
      {
        index: 2,
        intent: 'Open the search result',
        action: 'click',
        locator: { description: 'Result row', candidates: [{ kind: 'role', role: 'link', value: 'Open', confidence: 0.8 }] },
        expected_outcome: { type: 'element_exists', value: '.balance' },
      },
      {
        index: 3,
        intent: 'Read the balance',
        action: 'read',
        locator: { description: 'Balance figure', candidates: [{ kind: 'css', value: '.balance', confidence: 0.7 }] },
        extract_as: 'balance',
        extract_pattern: '\\$([0-9.,]+)',
        expected_outcome: { type: 'text_visible', value: 'Balance' },
        business_outcomes: [
          { code: 'MEMBER_NOT_FOUND', detect: { type: 'text_visible', value: 'No such member' }, message: 'No member with that id' },
        ],
      },
      {
        index: 4,
        intent: 'Wait for the page to settle',
        action: 'wait_for',
        expected_outcome: { type: 'text_absent', value: 'Loading…' },
      },
    ],
    success_checkpoint: { type: 'text_visible', value: 'Balance' },
    created_from: { run_id: 'core-banking/discovery/2026-01-01_000000', recorded_at: '2026-01-01T00:00:00Z' },
    redaction_policy: { redact_fields: [] },
  });

describe('code generation', () => {
  test('the generated file is syntactically valid JavaScript', () => {
    const code = generatePlaywrightTest(capability());
    const dir = mkdtempSync(path.join(tmpdir(), 'codegen-test-'));
    const file = path.join(dir, 'lookup-balance.spec.js');
    try {
      writeFileSync(file, code, 'utf8');
      assert.doesNotThrow(() => execFileSync('node', ['--check', file], { stdio: 'pipe' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('opens the entry route first, as replay does', () => {
    // engine/replay.js goes to the entry route before step 0, so a recording may start
    // with `type` rather than `navigate` — and this one does. A generated script that
    // skips the hop starts on about:blank and every locator times out, which is exactly
    // the bug this asserts against.
    const code = generatePlaywrightTest(capability());
    const goto = code.indexOf('page.goto(new URL("/login", BASE_URL)');
    const firstStep = code.indexOf('// Step 0');
    assert.ok(goto !== -1, 'the entry route is never opened');
    assert.ok(goto < firstStep, 'the entry route must be opened before the first step runs');
  });

  test('emits one step block per recorded step, in order', () => {
    const code = generatePlaywrightTest(capability());
    const indices = [...code.matchAll(/\/\/ Step (\d+) —/g)].map((m) => Number(m[1]));
    assert.deepEqual(indices, [0, 1, 2, 3, 4]);
  });

  test('a declared input is threaded through as a named placeholder, never inlined blind', () => {
    const code = generatePlaywrightTest(capability());
    assert.match(code, /member_id.*REPLACE_ME/s);
    assert.match(code, /INPUTS\["member_id"\]/);
  });

  test('a declared output is captured by name, with its extraction pattern applied', () => {
    const code = generatePlaywrightTest(capability());
    assert.match(code, /outputs\["balance"\] = extractPattern\(raw, "\\\\\$\(\[0-9\.,\]\+\)"\)/);
  });

  test('the unused locator candidate survives as a fallback comment, not silently dropped', () => {
    const code = generatePlaywrightTest(capability());
    assert.match(code, /fallback if this breaks: css "#member-id"/);
  });
});

describe('value_equals separator', () => {
  // A legacy target has no test ids, so every selector is an attribute selector and
  // every one of them contains an "=". Splitting on the first one truncated the
  // selector to "input[name" and every dropdown checkpoint failed to parse at replay.
  test('splits on the separator, not on an "=" inside the selector', () => {
    assert.deepEqual(splitValueEquals("select[name='branch']=MAIN-001"), {
      selector: "select[name='branch']",
      expected: 'MAIN-001',
    });
  });

  test('ignores "=" nested inside a functional pseudo-class', () => {
    assert.deepEqual(splitValueEquals("tr:has(td[data-role='id'])=100987"), {
      selector: "tr:has(td[data-role='id'])",
      expected: '100987',
    });
  });

  test('an expected value may itself contain "="', () => {
    assert.deepEqual(splitValueEquals("input[name='q']=a=b"), { selector: "input[name='q']", expected: 'a=b' });
  });

  test('an empty expected value is a real, parseable expectation', () => {
    assert.deepEqual(splitValueEquals("input[name='q']="), { selector: "input[name='q']", expected: '' });
  });

  test('no separator at all is reported rather than guessed at', () => {
    assert.equal(splitValueEquals('input[name=\'q\']'), null);
  });
});
