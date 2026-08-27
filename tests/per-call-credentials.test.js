/**
 * Per-call credentials: running the SAME recording as a different user.
 *
 * A capability references a credential by env var NAME, so the value is resolved fresh
 * on every run. That indirection is what makes this a resolution change rather than a
 * schema change — nothing about the recording differs between two users.
 *
 * What needs an actual browser here, rather than a data transform: that a caller-supplied
 * secret beats the app's stored one all the way through to the live page, that the
 * override is scoped to the call, and that a missing credential fails cleanly instead of
 * crashing. Masking a credential back out of captured page text is a pure function and is
 * tested as one, in tests/policy.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { replayCapability } from '../src/engine/replay.js';
import { APPS_DIR } from '../src/config/app-config.js';
import { parseCapability } from '../src/schema/capability.js';

// The page echoes the submitted value back, so a test can assert which credential
// actually reached the browser rather than trusting that resolution picked the right one.
const PAGE = `<!doctype html><html><body>
  <h3>Sign in</h3>
  <label for="pw">Secret</label>
  <input id="pw" type="text" />
  <button id="go" onclick="document.getElementById('out').textContent=document.getElementById('pw').value">Go</button>
  <div id="out"></div>
</body></html>`;

function serve(html) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end(html));
    server.listen(0, () => resolve(server));
  });
}

const ENV_NAME = 'PER_CALL_TEST_SECRET';

/** `expectEchoed` becomes the step-2 checkpoint, so the run only passes if THAT value landed. */
function buildCapability(appId, expectEchoed) {
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
        intent: 'submit and echo it back',
        action: 'click',
        locator: { description: 'Go', candidates: [{ kind: 'css', value: '#go', confidence: 0.9 }] },
        expected_outcome: { type: 'text_visible', value: expectEchoed },
      },
    ],
    success_checkpoint: { type: 'text_visible', value: expectEchoed },
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

async function run(appId, expectEchoed, options = {}) {
  const server = await serve(PAGE);
  const cleanup = registerApp(appId, `http://127.0.0.1:${server.address().port}`);
  try {
    return await replayCapability({ capability: buildCapability(appId, expectEchoed), headless: true, ...options });
  } finally {
    cleanup();
    server.close();
  }
}

describe('per-call credentials', () => {
  test('with no caller secret, the app’s stored credential is used', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      // The checkpoint demands the STORED value be echoed, so this only passes if it was
      // the one typed.
      const result = await run('cred_test_stored', 'stored-credential');
      assert.equal(result.outcome, 'SUCCESS');
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('a caller-supplied secret is the one that reaches the page', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      // Checkpoint demands the CALLER's value. If resolution had preferred the stored one
      // this fails, so the assertion is about the live page, not about internal wiring.
      const result = await run('cred_test_override', 'caller-credential', {
        secrets: { [ENV_NAME]: 'caller-credential' },
      });
      assert.equal(result.outcome, 'SUCCESS');
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('the override is scoped to the call — the environment is left alone', async () => {
    process.env[ENV_NAME] = 'stored-credential';
    try {
      await run('cred_test_scoped', 'caller-credential', { secrets: { [ENV_NAME]: 'caller-credential' } });
      assert.equal(process.env[ENV_NAME], 'stored-credential');
    } finally {
      delete process.env[ENV_NAME];
    }
  });

  test('neither a caller secret nor a stored one is a clean failure, not a crash', async () => {
    delete process.env[ENV_NAME];
    const result = await run('cred_test_missing', 'anything');
    assert.equal(result.outcome, 'HARD_FAILURE');
    assert.equal(result.failure.error_type, 'MissingCredential');
  });
});
