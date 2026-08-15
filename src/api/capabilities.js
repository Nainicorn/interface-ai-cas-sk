/**
 * The agent-facing capability surface — the system's stated purpose, demonstrated.
 *
 *   GET  /api/capabilities             the catalog: approved capabilities only, each
 *                                      shaped like a callable tool (name, description,
 *                                      input_schema, output_schema, confidence)
 *   GET  /api/capabilities/:id         one capability's full contract
 *   POST /api/capabilities/:id/invoke  invoke by name with typed args → four-way result
 *
 * Deliberately thin: load → approval gate → the same audited replay the console uses.
 * Draft capabilities are invisible here however safe they are — what an autonomous
 * agent may discover and call is an explicit human grant (see policy/risk.js).
 *
 * Hands off to: schema/store.js, policy/risk.js, api/run-replay.js.
 */

import { Router } from 'express';
import { checkAgentInvocable } from '../policy/risk.js';
import { listCapabilities, loadCapability } from '../schema/store.js';
import { runReplay } from './run-replay.js';

const router = Router();

/**
 * A catalog entry is shaped like a tool definition on purpose: `name`, `description`,
 * and `input_schema` are exactly what a function-calling agent needs to decide whether
 * and how to call — the rest tells it what comes back and how reliably.
 */
function catalogEntry(summary) {
  return {
    name: summary.id,
    description: summary.description,
    input_schema: summary.input_schema,
    output_schema: summary.output_schema,
    version: summary.version,
    risk_level: summary.risk_level,
    confidence: summary.confidence,
  };
}

router.get('/', async (_req, res, next) => {
  try {
    const all = await listCapabilities();
    res.json(all.filter((c) => checkAgentInvocable(c).allowed).map(catalogEntry));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    let capability;
    try {
      capability = await loadCapability(req.params.id);
    } catch (err) {
      err.status = 404;
      throw err;
    }
    const gate = checkAgentInvocable(capability);
    if (!gate.allowed) return res.status(403).json({ error: gate.reason });
    res.json(capability);
  } catch (err) {
    next(err);
  }
});

/**
 * Invoke by name. Body: { params: {...}, version?: n }
 * The result is the same contract replay always returns — BUSINESS_OUTCOME is a 200,
 * because it is an answer, not an error. Parameter problems surface as a HARD_FAILURE
 * at the pre-flight step, exactly as they do on every other replay path.
 */
router.post('/:id/invoke', async (req, res, next) => {
  try {
    const { params = {}, version, persona } = req.body ?? {};

    let capability;
    try {
      capability = await loadCapability(req.params.id, version ? Number(version) : undefined);
    } catch (err) {
      err.status = 404;
      throw err;
    }

    const gate = checkAgentInvocable(capability);
    if (!gate.allowed) return res.status(403).json({ error: gate.reason });

    res.json(await runReplay(capability, params, { persona }));
  } catch (err) {
    next(err);
  }
});

export default router;
