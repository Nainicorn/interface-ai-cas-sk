/**
 * The control plane: one Express app serving the operator console (static) and the
 * API the console drives. Port 3000 by default; the target app is a separate process
 * reached only through a real browser — never from here.
 *
 * Hands off to: api/runs.js, api/artifacts.js, api/escalation.js, public/.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyViolation, loadTargets } from '../policy/allowlist.js';
import artifactsRouter from './artifacts.js';
import escalationRouter from './escalation.js';
import runsRouter from './runs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(here, '../../public')));

/** Targets the console can offer — config minus anything sensitive-adjacent. */
app.get('/api/targets', (_req, res) => {
  const targets = Object.values(loadTargets()).map((t) => ({
    app_id: t.app_id,
    display_name: t.display_name ?? t.app_id,
    entry_route: t.entry_route,
    allowlist: t.allowlist,
    risky_route_patterns: t.risky_route_patterns ?? [],
  }));
  res.json(targets);
});

app.use('/api/runs', runsRouter);
app.use('/api/artifacts', artifactsRouter);
app.use('/api/escalations', escalationRouter);

/** Uniform error shape. A PolicyViolation is a refusal (403), not a server fault. */
app.use((err, _req, res, _next) => {
  const status = err instanceof PolicyViolation ? 403 : err.status ?? 500;
  res.status(status).json({ error: err.message, detail: err.detail ?? null });
});

import { reconcileAtBoot } from '../db/sqlite.js';

const { orphanedRuns, orphanedInterventions } = reconcileAtBoot();
if (orphanedRuns || orphanedInterventions) {
  console.log(`Reconciled ${orphanedRuns} orphaned run(s), ${orphanedInterventions} intervention(s) from a previous process.`);
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Control plane listening on :${port} — open the operator console in a browser.`);
});
