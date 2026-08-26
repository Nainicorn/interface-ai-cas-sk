/**
 * Multi-run stability's aggregation, on canned outcomes — no browser, no store, no
 * network. The looping half (runStabilityCheck calling runReplay N times) is exercised
 * live by `npm run stability`, same as replay's own browser path is exercised by
 * `npm run replay` rather than by this suite.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeStability } from '../src/api/stability.js';

const outcome = (outcome, run_id) => ({ outcome, run_id });

describe('stability', () => {
  test('all held counts as 100%', () => {
    const summary = summarizeStability([outcome('SUCCESS', 'a'), outcome('SUCCESS', 'b')]);
    assert.equal(summary.stability_pct, 100);
    assert.equal(summary.held, 2);
    assert.equal(summary.runs, 2);
  });

  test('BUSINESS_OUTCOME and RECOVERABLE both count as held, only HARD_FAILURE does not', () => {
    const summary = summarizeStability([
      outcome('SUCCESS', 'a'),
      outcome('BUSINESS_OUTCOME', 'b'),
      outcome('RECOVERABLE', 'c'),
      outcome('HARD_FAILURE', 'd'),
    ]);
    assert.equal(summary.held, 3);
    assert.equal(summary.stability_pct, 75);
    assert.deepEqual(summary.breakdown, { SUCCESS: 1, BUSINESS_OUTCOME: 1, RECOVERABLE: 1, HARD_FAILURE: 1 });
  });

  test('a fully flaky recording rounds to a readable percentage, not a repeating decimal', () => {
    const summary = summarizeStability([outcome('SUCCESS', 'a'), outcome('HARD_FAILURE', 'b'), outcome('HARD_FAILURE', 'c')]);
    assert.equal(summary.stability_pct, 33.3);
  });

  test('zero runs is 0%, not NaN', () => {
    assert.equal(summarizeStability([]).stability_pct, 0);
  });

  test('carries the run ids through, so a result links back to its evidence folder', () => {
    const summary = summarizeStability([outcome('SUCCESS', 'app/replay/2026-01-01_000000')]);
    assert.deepEqual(summary.run_ids, ['app/replay/2026-01-01_000000']);
  });
});
