/**
 * The control plane: one Express app serving the operator console (static) and the
 * API the console drives. Port 3000 by default; the target app is a separate process
 * reached only through a real browser — never from here.
 *
 * Hands off to: api/runs.js, api/capabilities.js, api/catalog.js, api/escalation.js,
 * ui/.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import capabilitiesRouter from './capabilities.js';
import catalogRouter from './catalog.js';
import chatRouter from './chat.js';
import escalationRouter from './escalation.js';
import runsRouter from './runs.js';
import appsRouter from './apps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(here, '../../ui')));

app.use('/api/apps', appsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/capabilities', capabilitiesRouter); // the operator's surface: drafts included
app.use('/api/catalog', catalogRouter); // the agent's surface: approved only
app.use('/api/chat', chatRouter); // the chatbot: a driver over the agent's surface
app.use('/api/escalations', escalationRouter);

/** Uniform error shape. Errors carry their own status; anything else is a server fault. */
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message, detail: err.detail ?? null });
});

import { reconcileAtBoot } from '../evidence/runs.js';

// reconcileAtBoot returns a count, not a record. Destructuring it as an object gave two
// undefineds and a message that could never print, which hid the fact that reconciliation
// was happening at all.
const reconciled = reconcileAtBoot();
if (reconciled > 0) {
  console.log(`Reconciled ${reconciled} run(s) left mid-flight by a previous process.`);
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Control plane listening on :${port} — open the operator console in a browser.`);
});
