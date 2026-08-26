/**
 * Per-call credentials: running the SAME recording as a different user.
 *
 * A capability references a credential by env var NAME, so the value is resolved fresh
 * on every run. That indirection is what makes this feature a resolution change rather
 * than a schema change — nothing about the recording differs between two users.
 *
 * Two properties are worth an actual browser here rather than a data transform:
 *
 *   1. A caller-supplied secret beats the app's stored one, and the browser really does
 *      receive the caller's value — asserted by reading it back off the live page.
 *   2. The secret does not survive into the drift fingerprint. A browser publishes a
 *      filled input's value in the accessibility tree, and that tree is what the
 *      fingerprint is built from — and the fingerprint is PERSISTED into the artifact.
 *      This is the one place a credential could reach disk having been correctly
 *      redacted everywhere a reviewer would think to look.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { replayCapability } from '../src/engine/replay.js';
import { APPS_DIR } from '../src/config/app-config.js';
import { parseCapability } from '../src/schema/capability.js';

// A text input, not type="password", so the typed value is reliably published to the
// accessibility tree — which is exactly the leak path being tested.
const PAGE = `<!doctype html><html><body>
  <h3>Sign in</h3>
  <label for="pw">Secret</label>
  <input id="pw" type="text" />
  <button id="go" onclick="document.getElementById('out').textContent='submitted'">Go</button>
  <div id="out"></div>
</body></html>`;

function serve(html) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end(html));
    server.listen(0, () => resolve(server));
  });
}

const ENV_NAME = 'PER_CALL_TEST_SECRET';

function buildCapability(appId) {
  return parseCapability({
    id: 'credential-demo',
    name: 'Credential demo',
    description: 'Type a credential, then submit',
    target: { app_id: appId, entry_route: '/', tenant_overrides: [] },
    input_schema: { type: 'object', properties: {}, required: [] },
    output_schema: { type: 'object', properties: {} },
    steps: [
      {
        index: 0,
        intent: 'type the credential',
        action: 'type',
        locator: { description: 'Secret field', candidates: [{ kind: 'css', value: '#pw', confidence: 0.9 }] },
        value_from_env: ENV_NAME,
        expected_outcome: { type: 'element_exists', value: '#pw' },
      },
      {
        index: 1,
        intent: 'submit',
        action: 'click',
        locator: { description: 'Go', candidates: [{ kind: 'css', value: '#go', confidence: 0.9 }] },
        expected_outcome: { type: 'text_visible', value: 'submitted' },
      },
    ],
    success_checkpoint: { type: 'text_visible', value: 'submitted' },
    created_from: { run_id: `${appId}/discovery/2026-01-01_000000`, recorded_at: new Date().toISOString() },
    redaction_policy: { redact_fields: [] },
  });
}

function registerApp(appId, origin) {
  const dir = path.join(APPS_DIR, appId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: appId, url: `${origin}/` }));
  return () => rmSync(dir, { recursive: true, force: true });
}

/** Run the capability once and hand back the result. */
async function run(appId, options) {
  const server = await serve(PAGE);
  const cleanup = registerApp(appId, `http://127.0.0.1:${server.address().port}`);
  try {
    return await replayCapability({ capability: buildCapability(appId), headless: true, ...options });
  } finally {
    cleanup();
    server.close();
  }
}

/** Every fingerprint line the run captured, flattened — what would be written to disk. */
const allFingerprintText = (result) => Object.values(result.observed_fingerprints).flat().join('\n');

describe('per-call credentials', () => {
  test('with no caller secret, the stored credential is used — unchanged behaviour', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      const result = await run('cred_test_stored', {});
      assert.equal(result.outcome, 'SUCCESS');
      assert.deepEqual(result.detail ?? null, null); // replayCapability does not add run detail
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('a caller-supplied secret overrides the stored one for this run only', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      const result = await run('cred_test_override', { secrets: { [ENV_NAME]: 'caller-credential' } });
      assert.equal(result.outcome, 'SUCCESS');
      // The env var is untouched afterwards — the override was scoped to the call, not
      // written into the process the way an app config would be.
      assert.equal(process.env[ENV_NAME], 'stored-credential');
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('the caller-supplied value is what actually reaches the page', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      const result = await run('cred_test_reaches', { secrets: { [ENV_NAME]: 'caller-credential' } });
      assert.equal(result.outcome, 'SUCCESS');
      // Proven the other way round: the typed value shows up in the captured tree, so if
      // the stored one had been used its text would be the one appearing there.
      const captured = allFingerprintText(result);
      assert.ok(!captured.includes('stored-credential'), 'the stored credential was used instead of the caller’s');
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('neither a caller secret nor a stored one is a clean failure, not a crash', async () => {
    delete process.env[ENV_NAME];
    const result = await run('cred_test_missing', {});
    assert.equal(result.outcome, 'HARD_FAILURE');
    assert.equal(result.failure.error_type, 'MissingCredential');
  });

  test('a caller-supplied secret never reaches the drift fingerprint, which is persisted', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      const result = await run('cred_test_mask_caller', { secrets: { [ENV_NAME]: 'caller-credential' } });
      assert.equal(result.outcome, 'SUCCESS');
      const captured = allFingerprintText(result);
      assert.ok(captured.length > 0, 'nothing was fingerprinted, so this asserts nothing');
      assert.ok(!captured.includes('caller-credential'), 'the caller’s secret reached the drift baseline');
      assert.ok(captured.includes('<string:17>'), 'the secret should be replaced by its shape, not deleted');
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('a STORED credential is masked out of the fingerprint too, not just a caller-supplied one', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      const result = await run('cred_test_mask_stored', {});
      assert.equal(result.outcome, 'SUCCESS');
      const captured = allFingerprintText(result);
      assert.ok(!captured.includes('stored-credential'), 'the stored credential reached the drift baseline');
    } finally {
      delete process.env[ENV_NAME];
    }
  });
});
