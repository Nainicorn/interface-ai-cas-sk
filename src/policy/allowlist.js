/**
 * The allowlist gate: what the system is permitted to do, and where.
 *
 * checkAllowed() is called as the FIRST LINE of every action primitive, so it applies
 * identically to the LLM path, the deterministic replay path, and the human operator
 * path. There is deliberately no privileged route around it — if a reviewer can find a
 * way to act on the page without passing through here, the safety claim is false.
 *
 * Policy only. Where an app LIVES is config/app-config.js's job; what may be done to it
 * is this file's. The two are separate so that resolving a target can never be mistaken
 * for approving an action on it.
 *
 * Hands off to: engine/actions.js (the only caller of checkAllowed).
 */

/** Raised when an action is refused by policy. Never caught and retried — it's a stop. */
export class PolicyViolation extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'PolicyViolation';
    this.detail = detail;
  }
}

/**
 * Reduce a URL to the path this system reasons about, rejecting anything off-origin.
 *
 * The origin check is the gate's hardest edge: an app's config names exactly one origin,
 * and no prefix list can widen it. A link that navigates off-site stops the run rather
 * than quietly driving a surface nobody approved.
 *
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
 * Two independent checks, because they fail for different reasons and a caller should be
 * able to tell them apart in the log:
 *   1. Is this action TYPE allowed at all for this app?
 *   2. Is the current route inside an allowed prefix, on the app's own origin?
 *
 * @param {object} args
 * @param {object} args.target resolved config from config/app-config.js
 * @param {string} args.action one of ACTION_TYPES
 * @param {string} [args.url] current or destination URL / route; omitted for actions
 *   that operate on the page already loaded
 * @throws {PolicyViolation}
 */
export function checkAllowed({ target, action, url }) {
  const allowedActions = target.allowlist?.action_types ?? [];
  if (!allowedActions.includes(action)) {
    throw new PolicyViolation(`Action "${action}" is not permitted on app "${target.app_id}".`, {
      app_id: target.app_id,
      action,
      allowed_actions: allowedActions,
    });
  }

  if (url === undefined || url === null) return true;

  const route = routeOf(target, url);
  const prefixes = target.allowlist?.route_prefixes ?? [];
  const permitted = prefixes.some((prefix) => route === prefix || route.startsWith(prefix));

  if (!permitted) {
    throw new PolicyViolation(`Route "${route}" is outside the allowlist for app "${target.app_id}".`, {
      app_id: target.app_id,
      action,
      route,
      allowed_prefixes: prefixes,
    });
  }

  return true;
}
