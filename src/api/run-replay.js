/**
 * One replay, fully accounted for: the approval gate, a run row, an evidence folder, and
 * the persisted result. Every caller goes through here — the operator surface
 * (api/capabilities.js), the agent-facing surface (api/catalog.js), and the CLI — so a
 * replay is gated and auditable identically whoever triggered it.
 *
 * Hands off to: policy/risk.js, engine/replay.js, evidence/runs.js, evidence/logger.js.
 */

import { replayCapability } from '../engine/replay.js';
import { createRun, updateRun } from '../evidence/runs.js';
import { redactObject } from '../policy/redact.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { ApprovalRequired, checkUnattendedAllowed } from '../policy/risk.js';

/**
 * One line saying why a replay failed, for the run row.
 *
 * `failure` comes in two shapes: a thrown error carries `message`, while a
 * checkpoint that simply did not hold carries `expected` / `observed` and no
 * message at all. Projecting only `message` recorded the second kind as a bare
 * step number — a HARD_FAILURE with no reason, which is precisely the case the
 * result contract exists to make debuggable.
 */
function describeFailure(failure) {
  if (!failure) return null;

  const said = failure.message
    ? failure.message
    : failure.expected
      ? `expected ${JSON.stringify(failure.expected)}, observed ${JSON.stringify(failure.observed ?? null)}`
      : 'no reason recorded';

  return {
    step: failure.step,
    intent: failure.intent ?? null,
    message: said,
    url: failure.url ?? null,
    screenshot: failure.screenshot ?? null,
  };
}

/**
 * Who asked for this replay. Recorded on the run so the Runs table can say it:
 * an autonomous agent calling an approved capability and an operator clicking
 * Replay produce identical evidence otherwise, and "an agent did this on its own"
 * is exactly the thing a reviewer wants to see distinguished.
 */
export const CALLERS = ['operator', 'agent', 'cli'];

/**
 * @param {object} capability a validated Capability from the store
 * @param {object} params caller-supplied inputs
 * @param {{headless?: boolean, runId?: string, caller?: 'operator'|'agent'|'cli',
 *   tenantId?: string|null}} [options]
 * @returns {Promise<object>} the four-way result, tagged with run_id / capability / version
 * @throws {ApprovalRequired} when a risky capability has not been approved
 */
export async function runReplay(
  capability,
  params = {},
  { headless = true, runId, caller = 'operator', tenantId = null, secrets = null } = {},
) {
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
  createRun({
    id,
    kind: 'replay',
    appId: capability.target.app_id,
    status: 'running',
    // Written at creation, not at completion: a run that never finishes should
    // still say who started it.
    detail: {
      caller: CALLERS.includes(caller) ? caller : 'operator',
      tenant_id: tenantId,
      secrets_overridden: secrets ? Object.keys(secrets) : [],
    },
  });
  const logger = new RunLogger(id);

  const result = await replayCapability({
    capability,
    params,
    // Per-call credentials. Never written to the run record — only the NAMES are, above,
    // so a reviewer can see a credential was overridden without the value being kept.
    secrets,
    headless,
    logger,
    tenantId,
  });

  updateRun(id, {
    status: result.outcome,
    detail: {
      capability: capability.id,
      version: capability.version,
      outcome: result.outcome,
      // The run row carries what the caller got, so the Runs view is self-sufficient —
      // but redacted on the way in. A capability is free to declare an output that reads
      // a sensitive field, and nothing stopped that value being written here in the
      // clear. The CALLER still receives it in full below; only the persisted copy is
      // reduced to a shape, because evidence outlives the request that asked for it.
      outputs:
        result.outputs && Object.keys(result.outputs).length
          ? redactObject(result.outputs, capability.redaction_policy)
          : null,
      business_outcome: result.business_outcome ?? null,
      failed_step: describeFailure(result.failure),
    },
  });

  return { run_id: id, capability: capability.id, version: capability.version, ...result, evidence_dir: logger.dir };
}
