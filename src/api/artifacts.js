/**
 * Artifacts over HTTP: browse recorded capabilities and replay one with typed params.
 *
 * Replay here is the same no-LLM executor the CLI uses; the route just adds a run row
 * and an evidence folder so console-triggered replays are as auditable as any other.
 *
 * Hands off to: schema/store.js, engine/replay.js.
 */

import { Router } from 'express';
import { replayCapability } from '../engine/replay.js';
import { listCapabilities, loadCapability } from '../schema/store.js';
import { createRun, updateRun } from '../db/sqlite.js';
import { RunLogger, newRunId } from '../evidence/logger.js';

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

    const runId = newRunId('replay');
    createRun({ id: runId, kind: 'replay', appId: capability.target.app_id, status: 'running' });
    const logger = new RunLogger(runId);

    const result = await replayCapability({ capability, params, headless: true, logger });

    logger.saveResult({ run_id: runId, capability: capability.id, version: capability.version, ...result });
    updateRun(runId, {
      status: result.outcome,
      detail: { capability: capability.id, version: capability.version, outcome: result.outcome },
    });

    res.json({ run_id: runId, capability: capability.id, version: capability.version, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
