/**
 * Targets over HTTP: the list the console offers, runtime registration, edit, and
 * delete — "point it at your own app" from a form. Secrets never round-trip: the
 * projection exposes persona names/usernames and saved goals, never passwords, and
 * writes route values to the gitignored creds file via policy/register-target.js.
 *
 * Hands off to: policy/register-target.js, policy/personas.js, policy/allowlist.js.
 */

import { Router } from 'express';
import { loadTargets } from '../policy/allowlist.js';
import { listPersonas } from '../policy/personas.js';
import { deleteTarget, registerTarget, updateTarget } from '../policy/register-target.js';

const router = Router();

/** Saved goals as [{name, text}] — tolerating the legacy single `goal` field. */
function goalsOf(target) {
  const goals = Object.entries(target.goals ?? {}).map(([name, text]) => ({ name, text }));
  if (!goals.length && target.goal) goals.push({ name: 'default', text: target.goal });
  return goals;
}

/** Config minus anything sensitive-adjacent; base_url is committed config, so it ships. */
router.get('/', (_req, res) => {
  const targets = Object.values(loadTargets()).map((t) => ({
    app_id: t.app_id,
    display_name: t.display_name ?? t.app_id,
    base_url: t.base_url,
    entry_route: t.entry_route,
    goals: goalsOf(t),
    allowlist: t.allowlist,
    risky_route_patterns: t.risky_route_patterns ?? [],
    personas: listPersonas(t.app_id),
  }));
  res.json(targets);
});

/** Register an app at runtime. 201 { app_id, display_name, personas: [names] }. */
router.post('/', (req, res, next) => {
  try {
    const { app_id, target, personas } = registerTarget(req.body ?? {});
    res.status(201).json({ app_id, display_name: target.display_name, personas });
  } catch (err) {
    next(err);
  }
});

/** Edit an app. Submitted logins replace the set; empty password keeps the stored one. */
router.put('/:appId', (req, res, next) => {
  try {
    const { app_id, target, personas } = updateTarget(req.params.appId, req.body ?? {});
    res.json({ app_id, display_name: target.display_name, personas });
  } catch (err) {
    next(err);
  }
});

/** Delete an app (and its creds file). Its runs and artifacts stay on disk as records. */
router.delete('/:appId', (req, res, next) => {
  try {
    res.json(deleteTarget(req.params.appId));
  } catch (err) {
    next(err);
  }
});

export default router;
