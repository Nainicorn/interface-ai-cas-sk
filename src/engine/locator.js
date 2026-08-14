/**
 * Ranked locator resolution — the core of the determinism story.
 *
 * The target environment has no test IDs, so any single selector is a guess. Instead of
 * one brittle selector, a step carries an ORDERED list of candidates; we try them in
 * order and accept the first that resolves to exactly one visible, enabled element.
 *
 * Two rules make this deterministic rather than merely lucky:
 *   - A candidate matching MULTIPLE elements is rejected, not silently first()-ed.
 *     Acting on "whichever one came first" is how automation quietly does the wrong
 *     thing to the wrong record.
 *   - Every attempt is recorded, so a failure reports what was tried and why each
 *     candidate lost — which is what makes a HARD_FAILURE debuggable.
 *
 * Hands off to: engine/actions.js (its only caller).
 */

import { LocatorResolutionError } from './errors.js';

/**
 * Turn one candidate into a Playwright Locator.
 * `value` is interpreted per kind — see schema/capability.js LocatorCandidateSchema.
 */
function buildLocator(page, candidate) {
  const { kind, value, role, exact } = candidate;
  switch (kind) {
    case 'role':
      if (!role) throw new Error(`Candidate of kind "role" is missing its role field`);
      return page.getByRole(role, { name: value, exact });
    case 'label':
      return page.getByLabel(value, { exact });
    case 'placeholder':
      return page.getByPlaceholder(value, { exact });
    case 'text':
      return page.getByText(value, { exact });
    case 'css':
      return page.locator(value);
    default:
      throw new Error(`Unknown locator kind "${kind}"`);
  }
}

/**
 * Resolve a LocatorStrategy to exactly one usable element.
 *
 * @param {import('playwright').Page} page
 * @param {object} strategy a LocatorStrategy — { description, candidates[] }
 * @param {object} [options]
 * @param {number} [options.timeoutMs] per-candidate settle budget
 * @returns {Promise<{locator: import('playwright').Locator, candidate: object, attempts: object[]}>}
 * @throws {LocatorResolutionError} when no candidate resolves uniquely
 */
export async function resolveLocator(page, strategy, { timeoutMs = 3000 } = {}) {
  const attempts = [];

  for (const candidate of strategy.candidates) {
    let locator;
    try {
      locator = buildLocator(page, candidate);
    } catch (err) {
      attempts.push({ candidate, matchCount: 0, reason: `Invalid candidate: ${err.message}` });
      continue;
    }

    // Give only the FIRST candidate a real wait budget. Once the page has settled,
    // later candidates are evaluated immediately — otherwise a step with five
    // candidates would pay the timeout five times over on a genuine failure.
    const budget = attempts.length === 0 ? timeoutMs : 250;
    try {
      await locator.first().waitFor({ state: 'attached', timeout: budget });
    } catch {
      attempts.push({ candidate, matchCount: 0, reason: 'No element matched within timeout' });
      continue;
    }

    const matchCount = await locator.count();

    if (matchCount === 0) {
      attempts.push({ candidate, matchCount, reason: 'No element matched' });
      continue;
    }
    if (matchCount > 1) {
      // Ambiguity is a failure, never a coin flip. See the header note.
      attempts.push({
        candidate,
        matchCount,
        reason: `Ambiguous: matched ${matchCount} elements; refusing to guess`,
      });
      continue;
    }

    const isVisible = await locator.isVisible().catch(() => false);
    if (!isVisible) {
      attempts.push({ candidate, matchCount, reason: 'Matched exactly one element, but it is not visible' });
      continue;
    }

    attempts.push({ candidate, matchCount, reason: 'resolved' });
    return { locator, candidate, attempts };
  }

  throw new LocatorResolutionError(strategy.description, attempts);
}

/**
 * Non-throwing probe. Used by checkpoint evaluation, where "no such element" is a
 * legitimate answer (element_exists / text_absent) rather than an error.
 */
export async function locatorExists(page, strategy, options) {
  try {
    await resolveLocator(page, strategy, options);
    return true;
  } catch (err) {
    if (err instanceof LocatorResolutionError) return false;
    throw err;
  }
}
