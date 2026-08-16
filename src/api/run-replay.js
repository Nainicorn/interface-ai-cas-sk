/**
 * One replay, fully accounted for: the approval gate, a run row, an evidence folder, and
 * the persisted result. Every caller goes through here — the operator surface
 * (api/artifacts.js), the agent-facing surface (api/capabilities.js), and the CLI — so a
 * replay is gated and auditable identically whoever triggered it.
 *
 * Hands off to: policy/risk.js, engine/replay.js, evidence/runs.js, evidence/logger.js.
 */

import { replayCapability } from '../engine/replay.js';
import { createRun, updateRun } from '../evidence/runs.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { ApprovalRequired, checkUnattendedAllowed } from '../policy/risk.js';

/**
 * @param {object} capability a validated Capability from the store
 * @param {object} params caller-supplied inputs
 * @param {{headless?: boolean, runId?: string}} [options]
 * @returns {Promise<object>} the four-way result, tagged with run_id / capability / version
 * @throws {ApprovalRequired} when a risky capability has not been approved
 */
export async function runReplay(capability, params = {}, { headless = true, runId } = {}) {
  // Before anything is written. A refusal must not leave a run row or an evidence
  // folder behind, because nothing was attempted.
  const gate = checkUnattendedAllowed(capability);
  if (!gate.allowed) {
    throw new ApprovalRequired(gate.reason, {
      capability: capability.id,
      version: capability.version,
      status: capability.status,
      risk_level: capability.risk_level,
    });
  }

  const id = runId ?? newRunId(capability.target.app_id, 'replay');
  createRun({ id, kind: 'replay', appId: capability.target.app_id, status: 'running' });
  const logger = new RunLogger(id);

  const result = await replayCapability({ capability, params, headless, logger });

  updateRun(id, {
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

  return { run_id: id, capability: capability.id, version: capability.version, ...result, evidence_dir: logger.dir };
}
