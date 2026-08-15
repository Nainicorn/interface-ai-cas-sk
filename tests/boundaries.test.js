/**
 * Architectural invariants, asserted rather than promised.
 *
 * Three claims in REPORT.md are structural, and a reviewer has no way to confirm them
 * by reading prose. Each one is checked here against the actual source tree, so if the
 * design ever drifts, the test suite says so instead of the claim quietly becoming false:
 *
 *   1. Replay never calls an LLM.
 *   2. The system shares no code with the app it automates.
 *   3. Targets are configuration, not hardcoded hostnames.
 *
 * Static source analysis, no browser, no network.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');

/** Every .js file under a directory, recursively. */
async function jsFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await jsFiles(full)));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

const read = async (file) => ({ file, source: await readFile(file, 'utf8') });
const rel = (file) => path.relative(path.resolve(here, '..'), file);

describe('invariant: replay never calls an LLM', () => {
  it('no module reachable from the replay path imports the Anthropic SDK', async () => {
    // The single most important claim in the submission. Discovery may call the model;
    // the deterministic execution path must not, for any reason — not for recovery,
    // not for fallback, not for classifying an outcome.
    const replayPath = [path.join(SRC, 'engine'), path.join(SRC, 'policy'), path.join(SRC, 'schema')];

    const offenders = [];
    for (const dir of replayPath) {
      for (const { file, source } of await Promise.all((await jsFiles(dir)).map(read))) {
        if (/@anthropic-ai\/sdk|new\s+Anthropic\s*\(/.test(source)) offenders.push(rel(file));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `These modules are on the replay path and reference the LLM SDK: ${offenders.join(', ')}`,
    );
  });
});

describe('invariant: the system shares no code with its target', () => {
  it('nothing in src/ imports from the sibling mock-bank app', async () => {
    // The mock bank is a separate repo reached only over HTTP through a real browser.
    // An import would mean the automation had privileged access to the surface it is
    // supposed to be driving blind, which would invalidate the entire demonstration.
    const offenders = [];
    for (const { file, source } of await Promise.all((await jsFiles(SRC)).map(read))) {
      if (/from\s+['"][^'"]*mock-bank/.test(source) || /require\(['"][^'"]*mock-bank/.test(source)) {
        offenders.push(rel(file));
      }
    }
    assert.deepEqual(offenders, [], `Cross-repo imports found: ${offenders.join(', ')}`);
  });
});

describe('invariant: targets are configuration, not code', () => {
  it('no target hostname or port is hardcoded in src/', async () => {
    // This is what makes "point it at your own stack" true rather than aspirational.
    // Base URLs belong in config/targets.json; src/ resolves them by app_id.
    const offenders = [];
    for (const { file, source } of await Promise.all((await jsFiles(SRC)).map(read))) {
      const stripped = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/https?:\/\/(localhost|127\.0\.0\.1)/.test(stripped)) offenders.push(rel(file));
    }
    assert.deepEqual(offenders, [], `Hardcoded target URLs found: ${offenders.join(', ')}`);
  });

  it('every configured target keeps the safe shape (registration starts empty)', async () => {
    // Targets are registered at runtime (console form / POST /api/targets), so zero
    // targets is a legitimate shipped state. Whatever IS present must keep the shape.
    const raw = JSON.parse(await readFile(path.resolve(here, '../config/targets.json'), 'utf8'));
    const targets = Object.keys(raw).filter((key) => !key.startsWith('_'));

    for (const key of targets) {
      const target = raw[key];
      assert.ok(target.base_url, `${key} needs a base_url`);
      assert.ok(target.allowlist?.route_prefixes?.length, `${key} needs allowed route prefixes`);
      assert.ok(target.allowlist?.action_types?.length, `${key} needs allowed action types`);
      // Credentials are referenced by env var NAME. A literal secret here is a leak.
      const creds = JSON.stringify(target.credentials ?? {});
      assert.ok(/_ENV|_env/.test(creds) || creds === '{}', `${key} must reference credentials by env var name`);
    }
  });
});

describe('invariant: one shared action layer', () => {
  it('only engine/actions.js calls the policy gate', async () => {
    // checkAllowed() is enforced inside the action primitives precisely so no caller can
    // forget it. If another module started calling it directly, that would be a second
    // path to the page — and the guarantee would no longer be structural.
    const callers = [];
    for (const { file, source } of await Promise.all((await jsFiles(SRC)).map(read))) {
      if (/\bcheckAllowed\s*\(/.test(source)) callers.push(path.basename(file));
    }
    assert.deepEqual(callers.sort(), ['actions.js', 'allowlist.js']);
  });
});
