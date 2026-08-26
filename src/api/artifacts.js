/**
 * Artifacts over HTTP — the operator's surface: browse recorded capabilities, replay
 * one with typed params, and perform the one human act the system never grants itself:
 * promoting a draft to approved (which is what admits it to the agent-facing catalog
 * and unlocks unattended replay for risky capabilities).
 *
 * Hands off to: schema/store.js, api/run-replay.js.
 */

import { Router } from 'express';
import { generatePlaywrightTest } from '../agent/codegen.js';
import { CAPABILITY_STATUSES } from '../schema/enums.js';
import { deleteCapability, listCapabilities, loadCapability, updateCapability } from '../schema/store.js';
import { runReplay } from './run-replay.js';
import { runStabilityCheck } from './stability.js';

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
 * Deterministic replay. Body: { params: {...}, version?: n }
 * Responds with the full four-way outcome — BUSINESS_OUTCOME is a 200, because it is
 * an answer, not an error.
 */
router.post('/:id/replay', async (req, res, next) => {
  try {
    const { params = {}, version } = req.body ?? {};
    const capability = await loadCapability(req.params.id, version);
    res.json(await runReplay(capability, params));
  } catch (err) {
    next(err);
  }
});

/**
 * A standalone Playwright script generated from the recording, for a human to read or
 * hand-adapt outside this system. Text, not JSON — it's a file to save and run.
 */
router.get('/:id/codegen', async (req, res, next) => {
  try {
    const version = req.query.version ? Number(req.query.version) : undefined;
    const capability = await loadCapability(req.params.id, version);
    res
      .type('text/javascript')
      .set('Content-Disposition', `attachment; filename="${capability.id}.spec.js"`)
      .send(generatePlaywrightTest(capability));
  } catch (err) {
    err.status = 404;
    next(err);
  }
});

/**
 * Multi-run stability: replay the same capability N times in a row and report how many
 * held. Body: { params: {...}, runs?: n (default 5), version?: n }
 *
 * Each run is a full replay through the normal gate — a risky, unapproved draft refuses
 * here exactly like it would on a single replay, on the first run.
 */
router.post('/:id/stability', async (req, res, next) => {
  try {
    const { params = {}, runs = 5, version } = req.body ?? {};
    const capability = await loadCapability(req.params.id, version);
    res.json(await runStabilityCheck(capability, params, { runs: Number(runs) }));
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

/**
 * Delete a capability — the recording only, never the run that produced it.
 *
 * An approved capability is refused. Approval is what admits it to the agent catalog, so
 * it has to be the thing withdrawn first: revoke, then delete. That makes the gate mean
 * something on the way out as well as on the way in, and it means nothing an agent may be
 * calling right now can disappear on a single click.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const version = req.query.version ? Number(req.query.version) : undefined;

    let capability;
    try {
      capability = await loadCapability(req.params.id, version);
    } catch (err) {
      err.status = 404;
      throw err;
    }

    if (capability.status === 'approved') {
      return res.status(409).json({
        error: `"${capability.id}" is approved and callable by agents. Revoke it first, then delete.`,
      });
    }

    const { run_id } = deleteCapability(capability.id, capability.version);
    res.json({ id: capability.id, version: capability.version, deleted: true, evidence_kept: run_id });
  } catch (err) {
    next(err);
  }
});

export default router;
