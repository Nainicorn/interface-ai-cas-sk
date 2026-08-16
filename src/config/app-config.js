/**
 * App configs: artifacts/<app>/config.json, authored by the user.
 *
 * This is target resolution, not enforcement — it answers "what am I driving, where does
 * it live, and what is it permitted to do". The gate that reads the permissions assembled
 * here lives in policy/allowlist.js, so resolving a target is never mistaken for
 * approving an action on it.
 *
 * artifacts/ holds what an app IS (gitignored — it carries credentials); evidence/ holds
 * what its runs DID. The recorded capability is written to the evidence run folder that
 * produced it, so nothing machine-generated lands here.
 *
 * Hands off to: engine/actions.js, engine/replay.js, agent/discovery.js, cli/*.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES } from '../schema/enums.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS_DIR = path.resolve(here, '../../artifacts');

/**
 * The permissions a config file gets when it does not state its own.
 *
 * `route_prefixes: ['/']` is the whole of the app's own origin and nothing else — the
 * origin itself is not widenable by any prefix (policy/allowlist.js enforces that), so
 * the default is "this app, all of it", never "the web". Every app created through the
 * console gets this block written into its config file literally, so narrowing it is
 * editing a visible value rather than discovering an undocumented one.
 */
export const DEFAULT_ALLOWLIST = { route_prefixes: ['/'], action_types: [...ACTION_TYPES] };

/** "Some App" -> "some_app". The slug is the folder name and the app id; one name, not two. */
export const slugify = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** artifacts/<app>/config.json — exported because the API writes through the same path. */
export const configPath = (appId) => path.join(ARTIFACTS_DIR, appId, 'config.json');

/** Raised when an app has no config file. Surfaces as a 404 rather than a crash. */
export class UnknownApp extends Error {
  constructor(appId, known) {
    super(`No config for app "${appId}". Run: npm run create -- --name "${appId}"`);
    this.name = 'UnknownApp';
    this.status = 404;
    this.detail = { app_id: appId, known };
  }
}

/**
 * Shape the file into the target object the engine expects.
 *
 * `base_url` and `entry_route` are derived from the single `url` key rather than
 * configured separately — one less thing to drift out of sync with the app actually
 * being driven.
 *
 * Credentials keep their env-name indirection: the config's literal values are pushed
 * into process.env under derived names, and only the NAMES travel into the prompt and
 * the recording. The model chooses where a password goes; it never learns what it is.
 *
 * Those derived names are also unioned into `redact_fields`, because the name is what
 * the replay path passes to the logger — so the value behind it is redacted by the same
 * rule whether it was called "password" or "MY_APP_PASSWORD".
 */
function toTarget(appId, raw) {
  const url = new URL(raw.url);
  const envPrefix = appId.toUpperCase();
  const credentials = {};
  const credentialFields = [];

  for (const field of ['username', 'password']) {
    if (!raw[field]) continue;
    const envName = `${envPrefix}_${field.toUpperCase()}`;
    process.env[envName] ??= raw[field];
    credentials[field] = envName;
    credentialFields.push(envName, field);
  }

  return {
    app_id: appId,
    name: raw.name ?? appId,
    display_name: raw.name ?? appId,
    goal: raw.goal ?? null,
    base_url: url.origin,
    entry_route: `${url.pathname}${url.search}`,
    entry_url: raw.url,
    credentials,
    allowlist: {
      route_prefixes: raw.allowlist?.route_prefixes ?? DEFAULT_ALLOWLIST.route_prefixes,
      action_types: raw.allowlist?.action_types ?? DEFAULT_ALLOWLIST.action_types,
    },
    risky_route_patterns: raw.risky_route_patterns ?? [],
    redact_fields: [...new Set([...(raw.redact_fields ?? []), ...credentialFields])],
  };
}

/** Every configured app, keyed by app id — one subfolder of artifacts/ each. */
export function loadTargets() {
  if (!existsSync(ARTIFACTS_DIR)) return {};
  const entries = {};
  for (const entry of readdirSync(ARTIFACTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = configPath(entry.name);
    if (!existsSync(file)) continue;
    try {
      entries[entry.name] = toTarget(entry.name, JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // A malformed config is not a configured app. `discover` reports it properly.
    }
  }
  return entries;
}

/**
 * Resolve one app's config, by id or by display name.
 * @throws {UnknownApp}
 */
export function getTarget(appId) {
  const id = existsSync(configPath(appId)) ? appId : slugify(appId);
  if (!existsSync(configPath(id))) throw new UnknownApp(appId, Object.keys(loadTargets()));
  return toTarget(id, JSON.parse(readFileSync(configPath(id), 'utf8')));
}

/** Absolute URL for a target-relative route. */
export function resolveUrl(target, route) {
  return new URL(route ?? '/', target.base_url).toString();
}
