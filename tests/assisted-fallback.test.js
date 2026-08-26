/**
 * Assisted fallback's bounding properties, against a real (local, offline) page.
 *
 * This one needs a browser — the whole point is what happens when a REAL locator
 * resolution fails mid-replay, which is not something a pure data transform can stand
 * in for. Slower than the rest of the suite on purpose, the same way a genuine discovery
 * run has to be real rather than mocked: "fires at most once" is a safety property, and
 * the only honest way to check it is to actually make it fail twice and watch.
 *
 * No real model call — a stub fallback function plays the part of
 * agent/assisted-fallback.js's suggestLocator, so this suite has no network dependency
 * and no API key requirement.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { replayCapability } from '../src/engine/replay.js';
import { APPS_DIR } from '../src/config/app-config.js';
import { parseCapability } from '../src/schema/capability.js';

// The recording expects #old-a / #old-b; the live page renamed both ids — a stand-in for
// a button whose test-hook id changed since the capability was recorded.
const PAGE = `<!doctype html><html><body>
  <h3>Fallback demo</h3>
  <button id="new-a" onclick="document.getElementById('out').textContent='a-clicked'">A</button>
  <button id="new-b" onclick="document.getElementById('out').textContent='b-clicked'">B</button>
  <div id="out"></div>
</body></html>`;

function serve(html) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end(html));
    server.listen(0, () => resolve(server));
  });
}

/**
 * @param {string} appId
 * @param {{stepA?: string, stepB?: string}} [locators] which selector each step is
 *   recorded with — defaults to both being stale (`#old-*`), so a test that only wants
 *   ONE step broken can pass the other as the real `#new-*` id already on the page.
 */
function buildCapability(appId, { stepA = '#old-a', stepB = '#old-b' } = {}) {
  return parseCapability({
    id: 'fallback-demo',
    name: 'Fallback demo',
    description: 'Click A then B',
    target: { app_id: appId, entry_route: '/', tenant_overrides: [] },
    input_schema: { type: 'object', properties: {}, required: [] },
    output_schema: { type: 'object', properties: {} },
    steps: [
      {
        index: 0,
        intent: 'click A',
        action: 'click',
        locator: { description: 'Button A', candidates: [{ kind: 'css', value: stepA, confidence: 0.9 }] },
        expected_outcome: { type: 'text_visible', value: 'a-clicked' },
      },
      {
        index: 1,
        intent: 'click B',
        action: 'click',
        locator: { description: 'Button B', candidates: [{ kind: 'css', value: stepB, confidence: 0.9 }] },
        expected_outcome: { type: 'text_visible', value: 'b-clicked' },
      },
    ],
    success_checkpoint: { type: 'text_visible', value: 'b-clicked' },
    created_from: { run_id: `${appId}/discovery/2026-01-01_000000`, recorded_at: new Date().toISOString() },
    redaction_policy: { redact_fields: [] },
  });
}

/** Register a throwaway app config pointing at a local server; caller cleans it up. */
function registerApp(appId, origin) {
  const dir = path.join(APPS_DIR, appId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: appId, url: `${origin}/` }));
  return () => rmSync(dir, { recursive: true, force: true });
}

/** A stub playing agent/assisted-fallback.js's suggestLocator, with no model call. */
function stubFallback(suggestions, calls) {
  return async ({ step }) => {
    calls.push(step.index);
    const value = suggestions[step.index];
    if (!value) return null; // declines for steps with no configured suggestion
    return {
      locator: { description: 'suggested', candidates: [{ kind: 'css', value, confidence: 0.5 }] },
      reasoning: 'stub suggestion for test',
    };
  };
}

describe('assisted fallback', () => {
  test('off by default: an unresolved locator is a plain HARD_FAILURE, no callback needed', async () => {
    const server = await serve(PAGE);
    const appId = 'fallback_test_off';
    const cleanup = registerApp(appId, `http://127.0.0.1:${server.address().port}`);
    try {
      const result = await replayCapability({ capability: buildCapability(appId), headless: true });
      assert.equal(result.outcome, 'HARD_FAILURE');
      assert.equal(result.failure.step, 0);
      assert.deepEqual(result.assisted_fallbacks, []);
    } finally {
      cleanup();
      server.close();
    }
  });

  test('a correct suggestion recovers the step and is recorded as RECOVERABLE, not silently SUCCESS', async () => {
    const server = await serve(PAGE);
    const appId = 'fallback_test_recover';
    const cleanup = registerApp(appId, `http://127.0.0.1:${server.address().port}`);
    const calls = [];
    try {
      // Only step 0's recorded locator is stale; step 1's already matches the live page,
      // so this run exercises exactly one fallback attempt end to end, cleanly.
      const result = await replayCapability({
        capability: buildCapability(appId, { stepB: '#new-b' }),
        headless: true,
        assistedFallback: stubFallback({ 0: '#new-a' }, calls),
      });
      assert.equal(result.outcome, 'RECOVERABLE');
      assert.equal(calls.length, 1, 'fallback must fire at most once for the whole replay, not once per failing step');
      assert.equal(result.assisted_fallbacks.length, 1);
      assert.equal(result.assisted_fallbacks[0].step, 0);
    } finally {
      cleanup();
      server.close();
    }
  });

  test('fires at most once even when a SECOND step also fails to resolve', async () => {
    const server = await serve(PAGE);
    const appId = 'fallback_test_bounded';
    const cleanup = registerApp(appId, `http://127.0.0.1:${server.address().port}`);
    const calls = [];
    try {
      // Only step 0 gets a working suggestion; step 1's locator is left broken. If the
      // fallback were allowed to fire again for step 1, this run would recover fully —
      // instead it must still end as HARD_FAILURE on step 1, proving the budget is one
      // call for the whole replay, not one per step that fails.
      const result = await replayCapability({
        capability: buildCapability(appId),
        headless: true,
        assistedFallback: stubFallback({ 0: '#new-a' }, calls),
      });
      assert.equal(result.outcome, 'HARD_FAILURE');
      assert.equal(result.failure.step, 1);
      assert.equal(calls.length, 1, 'the second failing step must not get its own fallback attempt');
    } finally {
      cleanup();
      server.close();
    }
  });

  test('a declined suggestion (null) is treated as no recovery, never forced through', async () => {
    const server = await serve(PAGE);
    const appId = 'fallback_test_decline';
    const cleanup = registerApp(appId, `http://127.0.0.1:${server.address().port}`);
    const calls = [];
    try {
      const result = await replayCapability({
        capability: buildCapability(appId),
        headless: true,
        assistedFallback: stubFallback({}, calls), // no configured suggestions — always declines
      });
      assert.equal(result.outcome, 'HARD_FAILURE');
      assert.equal(calls.length, 1);
      assert.deepEqual(result.assisted_fallbacks, []);
    } finally {
      cleanup();
      server.close();
    }
  });
});
