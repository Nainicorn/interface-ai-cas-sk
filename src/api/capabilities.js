/**
 * The agent-facing surface: a catalog of callable capabilities, and invocation by name.
 *
 * This is deliberately NOT api/artifacts.js with a different URL. That route is the
 * operator's — it shows drafts, it can promote and demote, it exists to be browsed by a
 * person. This one is what an autonomous caller sees, and it is strictly narrower:
 *
 *   - Only approved capabilities exist here at all. A draft is not "listed but refused",
 *     it is invisible, because a catalog an agent cannot act on is noise in its context.
 *   - Entries are shaped like tool definitions (name, description, input_schema) because
 *     that is what a function-calling agent needs to decide whether and how to call one.
 *   - Invocation runs the same deterministic replay the console runs, through the same
 *     gate and the same evidence trail.
 *
 * Hands off to: schema/store.js, policy/risk.js, api/run-replay.js.
 */

import { Router } from 'express';
import { checkAgentInvocable } from '../policy/risk.js';
import { listCapabilities, loadCapability } from '../schema/store.js';
import { runReplay } from './run-replay.js';

const router = Router();

/**
 * One catalog entry: the contract, and nothing about how the flow is implemented.
 *
 * A caller decides from name/description/input_schema; the recorded steps are an
 * implementation detail it has no business reasoning about. `reliability` is the rolling
 * confidence signal, exposed so an agent can prefer a capability with a track record.
 */
function toCatalogEntry(summary) {
  const { runs = 0, successes = 0, last_outcome = null } = summary.confidence ?? {};
  return {
    id: summary.id,
    name: summary.name,
    version: summary.version,
    description: summary.description,
    input_schema: summary.input_schema,
    output_schema: summary.output_schema,
    risk_level: summary.risk_level,
    app_id: summary.app_id,
    reliability: { runs, successes, last_outcome },
  };
}

/**
 * The catalog. Empty until a human approves something — that is the intended first
 * impression, not an empty-state bug.
 */
router.get('/', async (_req, res, next) => {
  try {
    const all = await listCapabilities();
    res.json(all.filter((c) => checkAgentInvocable(c).allowed).map(toCatalogEntry));
  } catch (err) {
    next(err);
  }
});

/** One entry, for a caller that already knows the name. 404 if it is not approved. */
router.get('/:id', async (req, res, next) => {
  try {
    const capability = await loadCapability(req.params.id);
    const gate = checkAgentInvocable(capability);
    // 404 rather than 403: an unapproved capability does not exist on this surface.
    if (!gate.allowed) return res.status(404).json({ error: `No such capability "${req.params.id}"` });
    res.json(toCatalogEntry({ ...capability, app_id: capability.target.app_id }));
  } catch (err) {
    err.status = 404;
    next(err);
  }
});

/**
 * Invoke by name with typed args. Body: { params: {...} }
 *
 * The four-way result goes back verbatim: BUSINESS_OUTCOME is a 200, because "no such
 * member" is the answer the caller asked for, not an error it should retry.
 */
router.post('/:id/invoke', async (req, res, next) => {
  try {
    const capability = await loadCapability(req.params.id);
    const gate = checkAgentInvocable(capability);
    if (!gate.allowed) return res.status(403).json({ error: gate.reason });

    const { params = {} } = req.body ?? {};
    res.json(await runReplay(capability, params));
  } catch (err) {
    next(err);
  }
});

export default router;
