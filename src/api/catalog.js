/**
 * The agent-facing surface: a catalog of callable capabilities, and invocation by name.
 *
 * This is deliberately NOT api/capabilities.js with a different URL. That route is the
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
 * The two exported helpers below are the surface itself; the routes are a thin HTTP
 * skin over them. api/chat.js calls the helpers directly rather than looping back
 * through localhost, so the chatbot and an outside HTTP caller pass through one gate
 * and not two implementations of it.
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
 * Every capability an agent may call, newest contract per id.
 *
 * `appId` narrows it to one target. That is not cosmetic filtering: a chatbot pointed at
 * a bank must not be able to reach for a capability recorded against a different app
 * just because the description sounded close, and the narrowing has to happen before the
 * model sees the list rather than after it has chosen.
 */
export async function listAgentCatalog(appId = null) {
  const all = await listCapabilities();
  return all
    .filter((c) => checkAgentInvocable(c).allowed)
    .filter((c) => !appId || c.app_id === appId)
    .map(toCatalogEntry);
}

/**
 * Invoke one capability by name. Throws a 403-carrying error if the gate refuses.
 *
 * Every agent-side caller goes through here, so "approved" is checked in exactly one
 * place and a refusal reads identically whether it came from HTTP or the chatbot.
 */
export async function invokeByName(id, params = {}, { caller = 'agent' } = {}) {
  const capability = await loadCapability(id);
  const gate = checkAgentInvocable(capability);
  if (!gate.allowed) {
    const err = new Error(gate.reason);
    err.status = 403;
    throw err;
  }
  return runReplay(capability, params, { caller });
}

/**
 * The catalog. Empty until a human approves something — that is the intended first
 * impression, not an empty-state bug. `?app_id=` narrows it to one target.
 */
router.get('/', async (req, res, next) => {
  try {
    res.json(await listAgentCatalog(req.query.app_id ?? null));
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
 * The result goes back verbatim: BUSINESS_OUTCOME is a 200, because "no such
 * member" is the answer the caller asked for, not an error it should retry.
 */
router.post('/:id/invoke', async (req, res, next) => {
  try {
    const { params = {} } = req.body ?? {};
    // Tagged at the surface, not guessed downstream: reaching this route IS what
    // makes a run agent-invoked.
    res.json(await invokeByName(req.params.id, params, { caller: 'agent' }));
  } catch (err) {
    next(err);
  }
});

export default router;
