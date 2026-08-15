/**
 * Run report projection + the path-safety guards on the evidence-serving routes.
 * Pure file reading against a scratch evidence folder — no server, no browser.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildRunReport, isSafeRunId, isSafeScreenshotName, listScreenshots } from '../src/evidence/report.js';

describe('path safety', () => {
  it('accepts real run ids and screenshot names', () => {
    assert.equal(isSafeRunId('20260814-205335-discovery'), true);
    assert.equal(isSafeScreenshotName('000-entry.png'), true);
    assert.equal(isSafeScreenshotName('012-click-search.png'), true);
  });

  it('rejects traversal and anything off-scheme', () => {
    for (const id of ['../evidence', 'a/b', '..', '.hidden', '']) {
      assert.equal(isSafeRunId(id), false, `run id "${id}" must be rejected`);
    }
    for (const name of ['../x.png', 'a/b.png', '..%2fx.png', 'x.png', '000-entry.png.sh', '000-entry.jpg']) {
      assert.equal(isSafeScreenshotName(name), false, `screenshot "${name}" must be rejected`);
    }
  });
});

describe('report projection', () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cas-report-'));
  const runId = '20260101-000000-discovery';
  const dir = path.join(baseDir, runId);
  mkdirSync(dir, { recursive: true });

  const bigTree = 'x'.repeat(5000);
  writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    [
      JSON.stringify({ ts: 't0', type: 'run_start', kind: 'discovery', goal: 'test goal' }),
      JSON.stringify({ ts: 't1', type: 'observation', url: '/login', title: 'Login', ariaTree: bigTree, screenshot: '000-entry.png' }),
      JSON.stringify({ ts: 't2', type: 'action', actor: 'llm', action: 'click', detail: { note: 'y'.repeat(900) }, result: 'ok' }),
      '{"torn":',
    ].join('\n'),
  );
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'recorded', turns: 3 }));
  writeFileSync(path.join(dir, '000-entry.png'), Buffer.from([0x89, 0x50]));
  writeFileSync(path.join(dir, 'not-a-screenshot.png'), Buffer.from([0x89, 0x50]));

  it('drops the size bombs and truncates long strings', () => {
    const report = buildRunReport(runId, { baseDir });
    const observation = report.events.find((e) => e.type === 'observation');
    assert.equal(observation.ariaTree, undefined, 'ariaTree must not reach the page');
    assert.equal(observation.screenshot, '000-entry.png');
    const action = report.events.find((e) => e.type === 'action');
    assert.ok(action.detail.note.length < 600, 'long strings are truncated');
  });

  it('survives a torn tail line and a mid-write result.json', () => {
    const report = buildRunReport(runId, { baseDir });
    assert.equal(report.events.length, 3, 'the torn line is skipped, the rest kept');
    assert.equal(report.result.status, 'recorded');
  });

  it('lists only scheme-conforming screenshots, sorted', () => {
    assert.deepEqual(listScreenshots(runId, { baseDir }), ['000-entry.png']);
  });

  it('returns null for an unknown or unsafe run id', () => {
    assert.equal(buildRunReport('no-such-run', { baseDir }), null);
    assert.equal(buildRunReport('../etc', { baseDir }), null);
  });
});
