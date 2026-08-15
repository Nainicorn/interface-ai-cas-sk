/**
 * Target configuration and the allowlist gate.
 *
 * checkAllowed() is called as the FIRST LINE of every action primitive, so it applies
 * identically to the LLM path, the deterministic replay path, and the human operator
 * path. There is deliberately no privileged route around it — if a reviewer can find a
 * way to act on the page without passing through here, the safety claim is false.
 *
 * Hands off to: engine/actions.js (the only caller of checkAllowed).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.resolve(here, '../../config/targets.json');

/** Raised when an action is refused by policy. Never caught and retried — it's a stop. */
export class PolicyViolation extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'PolicyViolation';
    this.detail = detail;
  }
}

let cache = null;

/**
 * Load config/targets.json. Keys beginning with "_" are documentation, not targets.
 * Cached after first read; pass { reload: true } in tests.
 */
export function loadTargets({ reload = false } = {}) {
  if (cache && !reload) return cache;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  cache = Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => !key.startsWith('_'))
      .map(([appId, config]) => [appId, { app_id: appId, ...config }]),
  );
  return cache;
}

/**
 * Resolve one target's config.
 * @throws {PolicyViolation} for an unknown app_id — an unconfigured target is not a
 *   404, it's a refusal to act on a surface nobody has approved.
 */
export function getTarget(appId, options = {}) {
  const targets = loadTargets(options);
  const target = targets[appId];
  if (!target) {
    throw new PolicyViolation(`Unknown app_id "${appId}". Add it to config/targets.json first.`, {
      app_id: appId,
      known: Object.keys(targets),
    });
  }
  return target;
}

/** Absolute URL for a target-relative route. */
export function resolveUrl(target, route) {
  return new URL(route, target.base_url).toString();
}

/**
 * Reduce a URL to the path this system reasons about, rejecting anything off-origin.
 * @throws {PolicyViolation} when the URL points at a different host than the target
 */
export function routeOf(target, urlOrRoute) {
  const base = new URL(target.base_url);
  let parsed;
  try {
    parsed = new URL(urlOrRoute, target.base_url);
  } catch {
    throw new PolicyViolation(`Not a usable URL: ${urlOrRoute}`, { url: urlOrRoute });
  }

  if (parsed.origin !== base.origin) {
    throw new PolicyViolation(
      `Off-origin navigation blocked: ${parsed.origin} is not ${base.origin}`,
      { app_id: target.app_id, attempted: parsed.toString(), allowed_origin: base.origin },
    );
  }
  return parsed.pathname;
}

/**
 * The gate. Throws if this action is not permitted on this target.
 *
 * Two independent checks, because they fail for different reasons and a caller
 * should be able to tell them apart in the log:
 *   1. Is this action TYPE allowed at all for this app?
 *   2. Is the current route inside an allowed prefix?
 *
 * @param {object} args
 * @param {object} args.target   resolved target config
 * @param {string} args.action   one of ACTION_TYPES
 * @param {string} [args.url]    current or destination URL / route
 * @throws {PolicyViolation}
 */
export function checkAllowed({ target, action, url }) {
  const allowedActions = target.allowlist?.action_types ?? [];
  if (!allowedActions.includes(action)) {
    throw new PolicyViolation(
      `Action "${action}" is not permitted on app "${target.app_id}".`,
      { app_id: target.app_id, action, allowed_actions: allowedActions },
    );
  }

  if (url === undefined || url === null) return true;

  const route = routeOf(target, url);
  const prefixes = target.allowlist?.route_prefixes ?? [];
  const permitted = prefixes.some((prefix) => route === prefix || route.startsWith(prefix));

  if (!permitted) {
    throw new PolicyViolation(
      `Route "${route}" is outside the allowlist for app "${target.app_id}".`,
      { app_id: target.app_id, action, route, allowed_prefixes: prefixes },
    );
  }

  return true;
}
