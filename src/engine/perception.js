/**
 * Perception: turning a live page into something a model (or a checkpoint) can reason about.
 *
 * The accessibility tree is the PRIMARY channel, not the DOM and not the screenshot.
 * That is a deliberate bet on the brief's constraint that the real targets have no clean
 * DOM: the a11y tree is what a screen reader sees, it exists on legacy web apps and on
 * native desktop apps alike, and it survives the markup churn that breaks CSS selectors.
 * Swapping Playwright for an OS accessibility API later changes this file and nothing else.
 *
 * The screenshot is grounding, not the source of truth — and it is expensive, so the
 * viewport is capped by target config rather than sent at native resolution.
 *
 * Hands off to: agent/discovery.js (observations), engine/replay.js (checkpoints).
 */

/** Cap on visible-text length fed back to the model, to keep per-step tokens bounded. */
const MAX_TEXT_CHARS = 4000;

/**
 * Capture everything we know about the current page state.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {boolean} [options.screenshot] capture a PNG (base64). Costs image tokens.
 * @returns {Promise<{url: string, title: string, ariaTree: string, visibleText: string,
 *   screenshotBase64: string|null, capturedAt: string}>}
 */
export async function captureState(page, { screenshot = true } = {}) {
  const [url, title] = [page.url(), await page.title().catch(() => '')];

  // ariaSnapshot() is the public, stable API for the a11y tree. It yields a compact
  // YAML-ish outline of roles and accessible names — far cheaper in tokens than HTML
  // and far more stable than a DOM dump.
  const ariaTree = await page
    .locator('body')
    .ariaSnapshot()
    .catch((err) => `<a11y snapshot unavailable: ${err.message}>`);

  const rawText = await page.locator('body').innerText().catch(() => '');
  const visibleText = rawText.length > MAX_TEXT_CHARS
    ? `${rawText.slice(0, MAX_TEXT_CHARS)}\n…[truncated ${rawText.length - MAX_TEXT_CHARS} chars]`
    : rawText;

  let screenshotBase64 = null;
  if (screenshot) {
    const buffer = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
    screenshotBase64 = buffer ? buffer.toString('base64') : null;
  }

  return { url, title, ariaTree, visibleText, screenshotBase64, capturedAt: new Date().toISOString() };
}

/**
 * Evaluate one checkpoint condition against the live page.
 *
 * Exact, closed-vocabulary matching only — see schema/enums.js CONDITION_TYPES for why.
 * Returns a result object rather than throwing, because callers need the observed value
 * to build a debuggable failure report.
 *
 * @returns {Promise<{ok: boolean, observed: string}>}
 */
export async function evaluateCondition(page, condition) {
  const { type, value, timeout_ms: timeoutMs = 5000 } = condition;

  switch (type) {
    case 'url_contains': {
      // Poll rather than read once: a click that triggers navigation resolves slightly
      // after the action returns, and a single read would race it.
      const deadline = Date.now() + timeoutMs;
      let current = page.url();
      while (Date.now() < deadline) {
        current = page.url();
        if (current.includes(value)) return { ok: true, observed: current };
        await page.waitForTimeout(100);
      }
      return { ok: false, observed: current };
    }

    case 'text_visible': {
      try {
        await page.getByText(value).first().waitFor({ state: 'visible', timeout: timeoutMs });
        return { ok: true, observed: `found "${value}"` };
      } catch {
        return { ok: false, observed: `"${value}" not visible within ${timeoutMs}ms` };
      }
    }

    case 'text_absent': {
      const count = await page.getByText(value).count().catch(() => 0);
      return count === 0
        ? { ok: true, observed: `"${value}" absent as expected` }
        : { ok: false, observed: `"${value}" present ${count} time(s)` };
    }

    case 'element_exists': {
      try {
        await page.locator(value).first().waitFor({ state: 'visible', timeout: timeoutMs });
        return { ok: true, observed: `selector "${value}" matched` };
      } catch {
        return { ok: false, observed: `selector "${value}" matched nothing within ${timeoutMs}ms` };
      }
    }

    default:
      return { ok: false, observed: `Unknown condition type "${type}"` };
  }
}
