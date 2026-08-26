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
 * Compact structural signature for one matched element: its ancestor chain with
 * significant attributes, plus a snippet of its text.
 *
 * Exists because ambiguity is only fixable with information the a11y tree does not
 * carry. Legacy UIs nest layout tables whose rows all "contain" the same text; the
 * attribute that distinguishes the real target (a border, a name, a class) lives in
 * the DOM. Sampling it into the attempt record is what lets the discovery model scope
 * its next candidate — and what makes a replay HARD_FAILURE debuggable from the
 * evidence folder alone.
 */
async function sampleMatches(locator, matchCount, limit = 3) {
  const samples = [];
  for (let i = 0; i < Math.min(matchCount, limit); i += 1) {
    const signature = await locator
      .nth(i)
      .evaluate((el) => {
        const describe = (node) => {
          let s = node.tagName.toLowerCase();
          for (const attr of ['id', 'class', 'name', 'border', 'role', 'action', 'type']) {
            const value = node.getAttribute?.(attr);
            if (value) s += `[${attr}="${value}"]`;
          }
          return s;
        };
        const chain = [];
        let node = el;
        while (node && node.tagName && chain.length < 7) {
          chain.unshift(describe(node));
          node = node.parentElement;
        }
        const text = (el.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        return `${chain.join(' > ')}${text ? ` — "${text}"` : ''}`;
      })
      .catch(() => '<signature unavailable>');
    samples.push(signature);
  }
  return samples;
}

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
 * @param {boolean} [options.requireEnabled] reject a match that is present but disabled.
 *   Set by the primitives that INTERACT (click, type); left off for `read`, where a
 *   greyed-out field still has a value worth reading.
 * @returns {Promise<{locator: import('playwright').Locator, candidate: object, attempts: object[]}>}
 * @throws {LocatorResolutionError} when no candidate resolves uniquely
 */
export async function resolveLocator(page, strategy, { timeoutMs = 3000, requireEnabled = false } = {}) {
  const attempts = [];
  // Tracks whether any candidate has actually TOUCHED the page yet — deliberately not
  // attempts.length, which also counts candidates rejected before any wait happened. A
  // malformed first candidate used to consume the "first" slot and silently downgrade the
  // next one from the full budget to 250ms on a page that had not settled.
  let waited = false;

  for (const candidate of strategy.candidates) {
    let locator;
    try {
      locator = buildLocator(page, candidate);
    } catch (err) {
      attempts.push({ candidate, matchCount: 0, reason: `Invalid candidate: ${err.message}` });
      continue;
    }

    // Give only the first candidate that reaches the page a real wait budget. Once the
    // page has settled, later candidates are evaluated immediately — otherwise a step
    // with five candidates would pay the timeout five times over on a genuine failure.
    const budget = waited ? 250 : timeoutMs;
    waited = true;
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
      // Ambiguity is a failure, never a coin flip. See the header note. The samples
      // show WHERE each match sits so the caller can scope a better candidate.
      attempts.push({
        candidate,
        matchCount,
        reason: `Ambiguous: matched ${matchCount} elements; refusing to guess`,
        matches: await sampleMatches(locator, matchCount),
      });
      continue;
    }

    const isVisible = await locator.isVisible().catch(() => false);
    if (!isVisible) {
      attempts.push({ candidate, matchCount, reason: 'Matched exactly one element, but it is not visible' });
      continue;
    }

    // A greyed-out Submit button is not a usable target. Without this the click lands on
    // a disabled control, does nothing, and surfaces later as a confusing "checkpoint
    // failed" rather than the true reason — which is the difference between a report an
    // operator can act on and one they cannot.
    if (requireEnabled) {
      const isEnabled = await locator.isEnabled().catch(() => false);
      if (!isEnabled) {
        attempts.push({ candidate, matchCount, reason: 'Matched exactly one element, but it is disabled' });
        continue;
      }
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
