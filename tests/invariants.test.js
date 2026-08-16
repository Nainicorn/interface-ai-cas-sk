/**
 * The structural claims this system makes about itself.
 *
 * These are not unit tests of behaviour — they are the three sentences in README.md and
 * REPORT.md that would become false if someone edited the wrong file, asserted so that a
 * future change fails here instead of quietly making the write-up a lie.
 *
 * They read source text on purpose. "No LLM in replay" is a property of the file, and the
 * only honest way to check it is to look at the file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

/** Every .js under src/, recursively. */
function sourceFiles(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('replay imports no LLM SDK — the determinism claim is a property of the file', () => {
  const replay = read('engine/replay.js');
  assert.ok(
    !/from\s+['"]@anthropic-ai\/sdk['"]/.test(replay),
    'engine/replay.js imports the Anthropic SDK — deterministic replay is no longer deterministic',
  );

  // The whole no-LLM path, not just the entry file: anything replay reaches must be clean.
  for (const rel of ['engine/locator.js', 'engine/actions.js', 'engine/perception.js', 'schema/store.js']) {
    assert.ok(
      !/from\s+['"]@anthropic-ai\/sdk['"]/.test(read(rel)),
      `${rel} is on the replay path and imports the Anthropic SDK`,
    );
  }
});

test('the policy gate opens every action primitive — no caller can forget it', () => {
  const actions = read('engine/actions.js');

  // Each exported primitive must call checkAllowed before it touches the page.
  // All five, not the obvious three: `read` and `wait_for` are action types an operator
  // can untick, so a primitive that skips the gate makes that control a lie.
  for (const fn of ['navigate', 'click', 'typeText', 'readText', 'waitFor']) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}(`));
    const upToFirstAwait = body.slice(0, body.indexOf('await '));
    assert.match(
      upToFirstAwait,
      /checkAllowed\(/,
      `${fn}() acts on the page before calling checkAllowed — the gate is bypassable`,
    );
  }
});

test('one action layer — nothing outside actions.js drives the page', () => {
  // Playwright's page verbs may only be called by the primitives themselves (and the
  // browser launch in replay/discovery). A second implementation of "click" anywhere
  // else would make the shared-action-layer claim false.
  const offenders = sourceFiles()
    .filter((f) => !f.endsWith(path.join('engine', 'actions.js')))
    .filter((f) => !f.endsWith(path.join('engine', 'locator.js'))) // resolves, never acts
    .filter((f) => /\.(click|fill|selectOption|press)\(/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f));

  assert.deepEqual(offenders, [], `these files drive the page directly instead of going through actions.js: ${offenders}`);
});

test('the five primitives are exactly the five the schema allows', async () => {
  const { ACTIONS } = await import('../src/engine/actions.js');
  const { ACTION_TYPES } = await import('../src/schema/enums.js');
  assert.deepEqual(
    Object.keys(ACTIONS).sort(),
    [...ACTION_TYPES].sort(),
    'the dispatch table and the schema vocabulary have drifted apart',
  );
});
