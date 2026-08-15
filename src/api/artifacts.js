/**
 * Artifacts over HTTP — the operator's surface: browse recorded capabilities, replay
 * one with typed params, and perform the one human act the system never grants itself:
 * promoting a draft to approved (which is what admits it to the agent-facing catalog
 * and unlocks unattended replay for risky capabilities).
 *
 * Hands off to: schema/store.js, api/run-replay.js, policy/risk.js (the gates that read `status`).
 */

import { Router } from 'express';
import { CAPABILITY_STATUSES } from '../schema/enums.js';
import { listCapabilities, loadCapability, updateCapability } from '../schema/store.js';
import { runReplay } from './run-replay.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listCapabilities());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const version = req.query.version ? Number(req.query.version) : undefined;
    res.json(await loadCapability(req.params.id, version));
  } catch (err) {
    err.status = 404;
    next(err);
  }
});

/**
 * Deterministic replay. Body: { params: {...}, version?: n, persona?: name }
 * Responds with the full four-way outcome — BUSINESS_OUTCOME is a 200, because it is
 * an answer, not an error.
 */
router.post('/:id/replay', async (req, res, next) => {
  try {
    const { params = {}, version, persona } = req.body ?? {};
    const capability = await loadCapability(req.params.id, version);
    res.json(await runReplay(capability, params, { persona }));
  } catch (err) {
    next(err);
  }
});

/**
 * The approval gate's human half. Body: { status: 'approved'|'draft', version?: n }
 *
 * Recording always produces a draft; THIS is the only way anything becomes approved.
 * Demotion back to draft is allowed on purpose — a capability whose confidence decays
 * should be pullable from the agent catalog without deleting its history.
 */
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, version } = req.body ?? {};
    if (!CAPABILITY_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${CAPABILITY_STATUSES.join(', ')}` });
    }

    let capability;
    try {
      capability = await loadCapability(req.params.id, version ? Number(version) : undefined);
    } catch (err) {
      err.status = 404;
      throw err;
    }

    const { capability: updated } = await updateCapability(capability.id, capability.version, { status });
    res.json({ id: updated.id, version: updated.version, status: updated.status });
  } catch (err) {
    next(err);
  }
});

export default router;
