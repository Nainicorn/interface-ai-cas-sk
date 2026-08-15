/**
 * One replay, fully accounted for: a run row, an evidence folder, and the persisted
 * result. Shared by the operator surface (api/artifacts.js) and the agent-facing
 * surface (api/capabilities.js), so a replay is equally auditable whoever triggered it.
 *
 * Hands off to: engine/replay.js, db/sqlite.js, evidence/logger.js.
 */

import { replayCapability } from '../engine/replay.js';
import { createRun, updateRun } from '../db/sqlite.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { getTarget } from '../policy/allowlist.js';
import { applyPersona } from '../policy/personas.js';

/**
 * @param {object} capability a validated Capability from the store
 * @param {object} params    caller-supplied inputs
 * @param {{persona?: string}} [options] which registered login to run as
 * @returns {Promise<object>} the four-way result, tagged with run_id / capability / version
 */
export async function runReplay(capability, params = {}, { persona } = {}) {
  const target = getTarget(capability.target.app_id);
  // Inject the chosen login's values into the target's declared env names before the
  // browser launches; the engine keeps resolving value_from_env exactly as before.
  const appliedPersona = applyPersona(target, persona);

  const runId = newRunId('replay');
  createRun({ id: runId, kind: 'replay', appId: capability.target.app_id, status: 'running' });
  const logger = new RunLogger(runId);
  if (appliedPersona) logger.logEvent('run_start', { kind: 'replay', persona: appliedPersona });

  const result = await replayCapability({ capability, params, headless: true, logger });

  logger.saveResult({ run_id: runId, capability: capability.id, version: capability.version, ...result });
  updateRun(runId, {
    status: result.outcome,
    detail: {
      capability: capability.id,
      version: capability.version,
      outcome: result.outcome,
      persona: appliedPersona,
      // The run row carries what the caller got, so the Runs view is self-sufficient.
      outputs: result.outputs && Object.keys(result.outputs).length ? result.outputs : null,
      business_outcome: result.business_outcome ?? null,
      failed_step: result.failure ? { step: result.failure.step, message: result.failure.message } : null,
    },
  });

  return { run_id: runId, capability: capability.id, version: capability.version, ...result };
}
