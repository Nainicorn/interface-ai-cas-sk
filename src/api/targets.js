/**
 * App listing and editing for the console sidebar.
 *
 * Apps live as artifacts/<app>/config.json, so editing one from the UI is a file write,
 * not a registration API — reading the file back is the source of truth either way.
 *
 * Hands off to: config/app-config.js.
 */

import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACTS_DIR, configPath, loadTargets, slugify } from '../config/app-config.js';

const router = Router();

/** The five keys a config file holds. Anything else in the body is ignored. */
const FIELDS = ['name', 'url', 'goal', 'username', 'password'];

/**
 * Resolve an app id to its config path, refusing anything that isn't a plain slug.
 * The id reaches this from a URL segment, so "../.." must never become a file write.
 */
function configPathFor(appId) {
  if (!appId || slugify(appId) !== appId) return null;
  const file = configPath(appId);
  return path.resolve(path.dirname(file)) === path.resolve(ARTIFACTS_DIR, appId) ? file : null;
}

router.get('/', (_req, res) => {
  res.json(
    Object.values(loadTargets()).map((t) => ({
      app_id: t.app_id,
      display_name: t.display_name,
      base_url: t.base_url,
      entry_route: t.entry_route,
      goal: t.goal,
    })),
  );
});

/**
 * The raw config for one app, for the edit form.
 * `password` is returned as a boolean, never a value — the form shows "set" and only
 * sends a new one when the user types one.
 */
router.get('/:appId', (req, res) => {
  const file = configPathFor(req.params.appId);
  if (!file || !existsSync(file)) return res.status(404).json({ error: 'No such app' });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  res.json({
    app_id: req.params.appId,
    name: raw.name ?? '',
    url: raw.url ?? '',
    goal: raw.goal ?? '',
    username: raw.username ?? '',
    has_password: Boolean(raw.password),
  });
});

/**
 * Create an app. The slug of the name becomes both the filename and the app id, so
 * there is one identifier rather than two that can disagree.
 */
router.post('/', (req, res) => {
  const { name, url } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'A name is required' });

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return res.status(400).json({ error: `Not a usable URL: ${url ?? '(none)'}` });
  }

  const appId = slugify(name);
  if (!appId) return res.status(400).json({ error: 'That name has no letters or digits in it' });

  const file = configPathFor(appId);
  if (!file) return res.status(400).json({ error: 'That name is not usable as a filename' });
  if (existsSync(file)) return res.status(409).json({ error: `An app called "${name}" already exists` });

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        name: name.trim(),
        url,
        goal: req.body.goal ?? '',
        username: req.body.username ?? '',
        password: req.body.password ?? '',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  res.status(201).json({ app_id: appId, base_url: origin });
});

/**
 * Update an app's config file. Blank `password` keeps the stored one, so saving the
 * form without retyping a secret does not wipe it.
 */
router.put('/:appId', (req, res) => {
  const file = configPathFor(req.params.appId);
  if (!file || !existsSync(file)) return res.status(404).json({ error: 'No such app' });

  const current = JSON.parse(readFileSync(file, 'utf8'));
  const body = req.body ?? {};

  if (body.url) {
    try {
      new URL(body.url);
    } catch {
      return res.status(400).json({ error: `Not a usable URL: ${body.url}` });
    }
  }

  const next = { ...current };
  for (const field of FIELDS) {
    if (body[field] === undefined) continue;
    if (field === 'password' && body[field] === '') continue; // blank means "unchanged"
    next[field] = body[field];
  }

  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  res.json({ app_id: req.params.appId, saved: true });
});

/**
 * Delete an app: its whole artifacts/<app>/ folder. The evidence folders are left alone
 * deliberately — recorded runs are the deliverable, and removing an app is not a reason
 * to destroy the proof that it once ran.
 */
router.delete('/:appId', (req, res) => {
  const file = configPathFor(req.params.appId);
  if (!file || !existsSync(file)) return res.status(404).json({ error: 'No such app' });
  rmSync(path.dirname(file), { recursive: true });
  res.json({ app_id: req.params.appId, deleted: true });
});

export default router;
