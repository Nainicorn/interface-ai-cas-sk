/**
 * The control plane: one Express app serving the operator console (static) and the
 * API the console drives. Port 3000 by default; the target app is a separate process
 * reached only through a real browser — never from here.
 *
 * Hands off to: api/runs.js, api/artifacts.js, api/capabilities.js, api/escalation.js,
 * ui/.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import artifactsRouter from './artifacts.js';
import capabilitiesRouter from './capabilities.js';
import escalationRouter from './escalation.js';
import runsRouter from './runs.js';
import targetsRouter from './targets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(here, '../../ui')));

app.use('/api/targets', targetsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/artifacts', artifactsRouter); // the operator's surface: drafts included
app.use('/api/capabilities', capabilitiesRouter); // the agent's surface: approved only
app.use('/api/escalations', escalationRouter);

/** Uniform error shape. Errors carry their own status; anything else is a server fault. */
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message, detail: err.detail ?? null });
});

import { reconcileAtBoot } from '../evidence/runs.js';

const { orphanedRuns, orphanedInterventions } = reconcileAtBoot();
if (orphanedRuns || orphanedInterventions) {
  console.log(`Reconciled ${orphanedRuns} orphaned run(s), ${orphanedInterventions} intervention(s) from a previous process.`);
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Control plane listening on :${port} — open the operator console in a browser.`);
});
