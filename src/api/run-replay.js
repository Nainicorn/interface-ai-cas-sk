/**
 * One replay, fully accounted for: a run row, an evidence folder, and the persisted
 * result. Shared by the operator surface (api/artifacts.js) and the agent-facing
 * surface (api/capabilities.js), so a replay is equally auditable whoever triggered it.
 *
 * Hands off to: engine/replay.js, evidence/runs.js, evidence/logger.js.
 */

import { replayCapability } from '../engine/replay.js';
import { createRun, updateRun } from '../evidence/runs.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { getTarget } from '../config/app-config.js';

/**
 * @param {object} capability a validated Capability from the store
 * @param {object} params    caller-supplied inputs
 * @returns {Promise<object>} the four-way result, tagged with run_id / capability / version
 */
export async function runReplay(capability, params = {}) {
  const target = getTarget(capability.target.app_id);
  // Inject the chosen login's values into the target's declared env names before the
  // browser launches; the engine keeps resolving value_from_env exactly as before.

  const runId = newRunId(capability.target.app_id, 'replay');
  createRun({ id: runId, kind: 'replay', appId: capability.target.app_id, status: 'running' });
  const logger = new RunLogger(runId);

  const result = await replayCapability({ capability, params, headless: true, logger });

  updateRun(runId, {
    status: result.outcome,
    detail: {
      capability: capability.id,
      version: capability.version,
      outcome: result.outcome,
      // The run row carries what the caller got, so the Runs view is self-sufficient.
      outputs: result.outputs && Object.keys(result.outputs).length ? result.outputs : null,
      business_outcome: result.business_outcome ?? null,
      failed_step: result.failure ? { step: result.failure.step, message: result.failure.message } : null,
    },
  });

  return { run_id: runId, capability: capability.id, version: capability.version, ...result };
}
