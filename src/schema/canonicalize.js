/**
 * Route canonicalization: suggest the reusable pattern behind a concrete recorded URL.
 *
 * `/members/12345` and `/members/98111` are the same flow with a different member id;
 * `suggestRoutePattern` turns either into `/members/:id` so a human comparing two
 * recordings — or deciding whether a second tenant needs a fresh recording at all — can
 * see that at a glance.
 *
 * Deliberately a SUGGESTION, never applied automatically: nothing in this codebase
 * rewrites a step's recorded url from this. Auto-rewriting risks turning a route segment
 * that is genuinely fixed (a product SKU that happens to be all digits, say) into a
 * placeholder no one asked for — that call belongs to whoever is reviewing the capability.
 *
 * Hands off to: cli/canonicalize.js.
 */

/** A path segment that looks like an instance-specific id rather than a fixed route word. */
function looksLikeId(segment) {
  return /^\d+$/.test(segment) || /^[0-9a-f]{8,}$/i.test(segment);
}

/**
 * @param {string} route a path, e.g. "/members/12345/accounts/9981"
 * @returns {string} the same path with id-shaped segments replaced by ":id"
 */
export function suggestRoutePattern(route) {
  return route
    .split('/')
    .map((segment) => (looksLikeId(segment) ? ':id' : segment))
    .join('/');
}

/**
 * Every navigate step's url, plus the entry route, alongside its suggested pattern.
 * Skips anything that suggests no change — a route with no id-shaped segment is already
 * as canonical as it gets, and repeating it back would just be noise.
 *
 * @param {object} capability a validated Capability
 * @returns {Array<{source: string, route: string, pattern: string}>}
 */
export function suggestCapabilityPatterns(capability) {
  const routes = [
    { source: 'entry_route', route: capability.target.entry_route },
    ...capability.steps
      .filter((step) => step.action === 'navigate' && step.url)
      .map((step) => ({ source: `step ${step.index}`, route: step.url })),
  ];

  return routes
    .map(({ source, route }) => ({ source, route, pattern: suggestRoutePattern(route) }))
    .filter(({ route, pattern }) => route !== pattern);
}
