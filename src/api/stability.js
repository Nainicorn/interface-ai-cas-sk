/**
 * Multi-run stability: replay the same capability N times and report how many held.
 *
 * Reuses runReplay() exactly as every other caller does — same approval gate, same
 * evidence trail, same run row, same fold into the capability's rolling confidence
 * signal. A stability check is N real, auditable replays, not a special-cased path.
 *
 * Hands off to: api/run-replay.js, api/capabilities.js, cli/stability.js.
 */

import { runReplay } from './run-replay.js';

/** A run "held" if the recording resolved to a declared outcome, not a hard failure. */
const HELD_OUTCOMES = new Set(['SUCCESS', 'BUSINESS_OUTCOME', 'RECOVERABLE']);

/** Roll a list of replay results into one stability signal. Pure, so it's easy to test. */
export function summarizeStability(results) {
  const breakdown = { SUCCESS: 0, BUSINESS_OUTCOME: 0, RECOVERABLE: 0, HARD_FAILURE: 0 };
  for (const r of results) breakdown[r.outcome] = (breakdown[r.outcome] ?? 0) + 1;

  const held = results.filter((r) => HELD_OUTCOMES.has(r.outcome)).length;
  return {
    runs: results.length,
    held,
    stability_pct: results.length ? Math.round((held / results.length) * 1000) / 10 : 0,
    breakdown,
    run_ids: results.map((r) => r.run_id),
  };
}

/**
 * Replay a capability `runs` times in a row and report the aggregate.
 * @param {object} capability a validated Capability from the store
 * @param {object} [params] caller-supplied inputs, reused for every run
 * @param {{runs?: number, headless?: boolean, caller?: 'operator'|'agent'|'cli'}} [options]
 * @returns {Promise<object>} { ...summarizeStability(), results }
 * @throws {ApprovalRequired} on the first run, same as a normal replay would
 */
export async function runStabilityCheck(capability, params = {}, { runs = 5, headless = true, caller = 'operator' } = {}) {
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    results.push(await runReplay(capability, params, { headless, caller }));
  }
  return { ...summarizeStability(results), results };
}
