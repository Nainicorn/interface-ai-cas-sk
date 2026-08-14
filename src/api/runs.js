/**
 * Run lifecycle over HTTP: start a discovery run, watch its progress.
 *
 * POST fires the discovery loop as a background task and returns immediately — the
 * loop can outlive any single HTTP request precisely because escalation may park it
 * for minutes while a human works. The console then polls GET for status.
 *
 * Hands off to: agent/discovery.js, db/sqlite.js, evidence/logger.js.
 */

import { Router } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runDiscovery } from '../agent/discovery.js';
import { getSession } from '../agent/escalation.js';
import { getRun, listRuns, updateRun } from '../db/sqlite.js';
import { EVIDENCE_DIR, newRunId } from '../evidence/logger.js';
import { getTarget } from '../policy/allowlist.js';

const router = Router();

router.post('/', (req, res) => {
  const { goal, app_id: appId, params = {}, max_turns: maxTurns, headless = false } = req.body ?? {};
  if (!goal || !appId) {
    return res.status(400).json({ error: 'Required: goal, app_id' });
  }
  getTarget(appId); // throws PolicyViolation → 403 for an unconfigured target

  const runId = newRunId('discovery');

  // Background task, deliberately not awaited. Server mode pauses on escalation so a
  // human can take the live session and hand it back.
  runDiscovery({ goal, appId, params, maxTurns, headless, runId, onEscalation: 'pause' }).catch((err) => {
    console.error(`run ${runId} failed:`, err);
    try {
      updateRun(runId, { status: 'failed', detail: { error: err.message } });
    } catch {
      /* run row may not exist if startup itself failed */
    }
  });

  res.status(202).json({ run_id: runId });
});

router.get('/', (_req, res) => {
  const rows = listRuns().map((row) => {
    const live = getSession(row.id);
    return live ? { ...row, live: true, owner: live.owner } : { ...row, live: false };
  });
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = getRun(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such run' });
  const live = getSession(row.id);
  res.json(live ? { ...row, live: true, owner: live.owner, intervention_id: live.interventionId } : { ...row, live: false });
});

/** Latest evidence screenshot for a run — the console's "what is it looking at" view. */
router.get('/:id/screenshot', (req, res) => {
  const dir = path.join(EVIDENCE_DIR, req.params.id);
  if (!existsSync(dir)) return res.status(404).end();
  const latest = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().at(-1);
  if (!latest) return res.status(404).end();
  res.sendFile(path.join(dir, latest));
});

export default router;
