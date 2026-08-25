/**
 * App listing and editing for the console sidebar.
 *
 * Apps live as config/<app>/config.json, so editing one from the UI is a file write,
 * not a registration API — reading the file back is the source of truth either way.
 *
 * Hands off to: config/app-config.js.
 */

import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_DIR,
  DEFAULT_ALLOWLIST,
  configPath,
  loadTargets,
  slugify,
} from '../config/app-config.js';
import { getSession } from '../agent/escalation.js';
import { EVIDENCE_DIR } from '../evidence/logger.js';
import { listRuns } from '../evidence/runs.js';
import { listRecordings } from '../schema/store.js';

const router = Router();

/**
 * The keys a config file holds. Anything else in the body is ignored.
 *
 * The last three are the app's policy: which routes and action types are permitted,
 * which routes mutate state, and which field names must never have their values logged.
 * They are editable through this route on purpose — an allowlist that only a developer
 * with a text editor can narrow is not a control an operator actually has.
 */
const FIELDS = [
  'name',
  'url',
  'goal',
  'username',
  'password',
  'allowlist',
  'risky_route_patterns',
  'redact_fields',
];

/**
 * Resolve an app id to its config path, refusing anything that isn't a plain slug.
 * The id reaches this from a URL segment, so "../.." must never become a file write.
 */
function configPathFor(appId) {
  if (!appId || slugify(appId) !== appId) return null;
  const file = configPath(appId);
  return path.resolve(path.dirname(file)) === path.resolve(CONFIG_DIR, appId) ? file : null;
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
    allowlist: raw.allowlist ?? null,
    risky_route_patterns: raw.risky_route_patterns ?? [],
    redact_fields: raw.redact_fields ?? [],
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
        // Written literally rather than left to a runtime default: the permissions an
        // app runs under should be readable in its config file, not inferred from code.
        allowlist: req.body.allowlist ?? DEFAULT_ALLOWLIST,
        risky_route_patterns: req.body.risky_route_patterns ?? [],
        redact_fields: req.body.redact_fields ?? [],
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
 * Delete an app and everything it produced: its `config/<app>/` config AND its
 * `evidence/<app>/` runs, capabilities included.
 *
 * The cascade is deliberate. Deleting an app used to leave its evidence behind on the
 * argument that recorded runs are the deliverable — but that left orphan folders no
 * surface could reach: the console scopes every view to a registered app, so those runs
 * were unreachable and un-deletable, visible only on disk. An app you removed should
 * leave nothing behind. Git history is where deleted evidence is recovered from, and the
 * console names what will go before it asks.
 *
 * A live run blocks the delete rather than being force-killed — its browser needs closing
 * first, which is what Stop is for.
 */
router.delete('/:appId', (req, res) => {
  const file = configPathFor(req.params.appId);
  if (!file || !existsSync(file)) return res.status(404).json({ error: 'No such app' });

  const live = listRuns().find((r) => r.app_id === req.params.appId && getSession(r.id));
  if (live) {
    return res.status(409).json({ error: `Run ${live.id} is still live — stop it first.` });
  }
  // Count before deleting, so the response can say what actually went.
  const runs = listRuns().filter((r) => r.app_id === req.params.appId);
  const capabilities = listRecordings().filter((r) => r.runId.startsWith(`${req.params.appId}/`)).length;

  rmSync(path.dirname(file), { recursive: true, force: true });
  rmSync(path.join(EVIDENCE_DIR, req.params.appId), { recursive: true, force: true });

  res.json({
    app_id: req.params.appId,
    deleted: true,
    runs_deleted: runs.length,
    capabilities_deleted: capabilities,
  });
});

export default router;
