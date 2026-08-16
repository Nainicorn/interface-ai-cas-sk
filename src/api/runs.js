/**
 * Run lifecycle over HTTP: start a discovery run, watch its progress, read its report.
 *
 * POST fires the discovery loop as a background task and returns immediately — the
 * loop can outlive any single HTTP request precisely because escalation may park it
 * for minutes while a human works. The console then polls GET for status, and the
 * report page reads the run's evidence through /report and /screenshots/:name.
 *
 * Hands off to: agent/discovery.js, evidence/runs.js, evidence/logger.js, evidence/report.js.
 */

import { Router } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runDiscovery } from '../agent/discovery.js';
import { getSession, stopRun } from '../agent/escalation.js';
import { getRun, listRuns, updateRun } from '../evidence/runs.js';
import { EVIDENCE_DIR, newRunId } from '../evidence/logger.js';
import { buildRunReport, isSafeRunId, isSafeScreenshotName } from '../evidence/report.js';
import { getTarget, loadTargets } from '../config/app-config.js';

const router = Router();

router.post('/', (req, res) => {
  const { goal, app_id: appId, params = {}, max_turns: maxTurns, headless = false } = req.body ?? {};
  if (!goal || !appId) {
    return res.status(400).json({ error: 'Required: goal, app_id' });
  }
  const target = getTarget(appId); // throws UnknownApp → 404 for an unconfigured target

  const runId = newRunId(target.app_id, 'discovery');

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

/** Stop a run: close its browser, release any pending pause, mark it stopped. */
router.post('/:id/stop', async (req, res, next) => {
  try {
    const row = getRun(req.params.id);
    if (!row) return res.status(404).json({ error: 'No such run' });
    if (!['running', 'paused'].includes(row.status)) {
      return res.status(409).json({ error: `Run is already ${row.status}` });
    }
    res.json(await stopRun(req.params.id, { reason: req.body?.reason ?? 'Stopped by operator' }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res) => {
  const row = getRun(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such run' });
  const live = getSession(row.id);
  res.json(live ? { ...row, live: true, owner: live.owner, intervention_id: live.interventionId } : { ...row, live: false });
});

/** Everything the report page renders: run row + target summary + evidence projection. */
router.get('/:id/report', (req, res) => {
  const { id } = req.params;
  const row = getRun(id);
  if (!row || !isSafeRunId(id)) return res.status(404).json({ error: 'No such run' });

  const target = loadTargets()[row.app_id] ?? null; // null-safe: the app may be gone
  const report = buildRunReport(id) ?? { result: null, screenshots: [], events: [] };
  const live = getSession(id);
  res.json({
    run: live ? { ...row, live: true, owner: live.owner } : { ...row, live: false },
    target: target
      ? { app_id: target.app_id, display_name: target.display_name, base_url: target.base_url, goal: target.goal ?? null }
      : null,
    ...report,
  });
});

/** One evidence screenshot by name. Both segments are strictly pattern-matched. */
router.get('/:id/screenshots/:name', (req, res) => {
  const { id, name } = req.params;
  if (!isSafeRunId(id) || !isSafeScreenshotName(name)) return res.status(400).end();
  const file = path.join(EVIDENCE_DIR, id, name);
  // Belt and braces on top of the pattern checks.
  if (!path.resolve(file).startsWith(path.resolve(EVIDENCE_DIR, id) + path.sep)) return res.status(400).end();
  if (!existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

/** Latest evidence screenshot for a run — the console's "what is it looking at" view. */
router.get('/:id/screenshot', (req, res) => {
  if (!isSafeRunId(req.params.id)) return res.status(400).end();
  const dir = path.join(EVIDENCE_DIR, req.params.id);
  if (!existsSync(dir)) return res.status(404).end();
  const latest = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().at(-1);
  if (!latest) return res.status(404).end();
  res.sendFile(path.join(dir, latest));
});

export default router;
