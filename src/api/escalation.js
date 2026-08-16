/**
 * The operator's side of the handoff: see what is stuck, drive the live page, resume.
 *
 * Manual actions go through agent/escalation.js → engine/actions.js — the same gated
 * primitives the agent and replay use, logged into the same evidence trail with
 * actor 'human'. This surface is deliberately bare; the handoff underneath it is real.
 *
 * Hands off to: agent/escalation.js, evidence/runs.js.
 */

import { Router } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getSession, performManualAction, resumeRun } from '../agent/escalation.js';
import { getIntervention, listInterventions } from '../evidence/runs.js';
import { EVIDENCE_DIR } from '../evidence/logger.js';

const router = Router();

router.get('/', (req, res) => {
  const { status } = req.query;
  res.json(listInterventions(status ? { status } : {}));
});

router.get('/:id', (req, res) => {
  const row = getIntervention(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such intervention' });
  const live = getSession(row.run_id);
  res.json({ ...row, live: Boolean(live), owner: live?.owner ?? null });
});

/** The screenshot captured at the moment the run paused (or the latest human step). */
router.get('/:id/screenshot', (req, res) => {
  const row = getIntervention(req.params.id);
  if (!row?.context?.screenshot) return res.status(404).end();
  const file = path.join(EVIDENCE_DIR, row.run_id, row.context.screenshot);
  if (!existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

/**
 * One manual step on the paused run's live page.
 * Body: { action: 'click'|'type'|'navigate'|'read'|'wait_for', args: {...} }
 */
router.post('/:id/action', async (req, res, next) => {
  try {
    const row = getIntervention(req.params.id);
    if (!row) return res.status(404).json({ error: 'No such intervention' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'Intervention already resolved' });

    const { action, args } = req.body ?? {};
    if (!action || !args) return res.status(400).json({ error: 'Required: action, args' });

    const outcome = await performManualAction(row.run_id, { action, args });
    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

/** Hand control back. The parked discovery loop re-observes and continues. */
router.post('/:id/resume', (req, res, next) => {
  try {
    const row = getIntervention(req.params.id);
    if (!row) return res.status(404).json({ error: 'No such intervention' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'Intervention already resolved' });

    resumeRun(row.run_id, { note: req.body?.note ?? null });
    res.json({ resumed: true, run_id: row.run_id });
  } catch (err) {
    next(err);
  }
});

export default router;
