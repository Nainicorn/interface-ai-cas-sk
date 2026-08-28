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
 * Substitute {{param}} references in a condition's value from the caller's inputs.
 *
 * A checkpoint on a parameterized control has nothing static to assert. "The branch the
 * caller asked for is selected" can only be proven against THAT caller's value, and
 * without this the model is pushed into inventing a checkpoint that passes whatever
 * happened — which is how a step that was never really verified gets recorded looking
 * verified. On this target every mutating form is driven by parameterized dropdowns, so
 * that gap covers most of the surface.
 *
 * Parameters only, never credentials. A checkpoint is written into the evidence trail,
 * and a secret interpolated into one would be persisted there in the clear.
 *
 * An unknown token is left standing rather than blanked, so a mismatch reports the token
 * that could not be resolved instead of an empty string nobody can trace back.
 */
export function resolveCondition(condition, params = {}) {
  if (!condition?.value?.includes('{{')) return condition;
  const value = condition.value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (token, name) =>
    (Object.hasOwn(params, name) ? String(params[name]) : token));
  return { ...condition, value };
}

/**
 * Split a value_equals condition into its selector and expected value.
 *
 * The separator is the first "=" that is not inside brackets or quotes. Taking the
 * first "=" outright looks fine until the selector is an attribute selector, and on a
 * legacy target with no test ids every selector is one: "input[name='q']=100987" split
 * naively yields the selector "input[name" and a CSS parse error at replay. Scanning for
 * depth-zero, unquoted "=" costs a dozen lines and makes the condition usable at all here.
 *
 * Exported because agent/codegen.js emits the same split into standalone Playwright, and
 * two implementations of it would be free to disagree.
 *
 * @returns {{selector: string, expected: string} | null} null when there is no separator
 */
export function splitValueEquals(value) {
  let depth = 0;
  let quote = null;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === ']' || ch === ')') {
      depth -= 1;
    } else if (ch === '=' && depth === 0 && i > 0) {
      return { selector: value.slice(0, i).trim(), expected: value.slice(i + 1).trim() };
    }
  }
  return null;
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
      // Polls rather than reading once. "The error message is gone" is usually asserted
      // straight after a click, and a single instant read races the re-render — it can
      // pass because the new DOM has not painted, or fail because the old one has not
      // been torn down. Same 100ms cadence as url_contains, for the same reason.
      //
      // A counting error is NOT treated as absence. Swallowing it produced
      // `ok: true, "absent as expected"` — an affirmative, confident-sounding pass
      // derived from a failure, in a system whose whole job is proving success.
      const deadline = Date.now() + timeoutMs;
      let observed = `"${value}" was never successfully checked`;
      for (;;) {
        try {
          const count = await page.getByText(value).count();
          if (count === 0) return { ok: true, observed: `"${value}" absent as expected` };
          observed = `"${value}" present ${count} time(s)`;
        } catch (err) {
          observed = `could not check for "${value}": ${err.message}`;
        }
        if (Date.now() >= deadline) return { ok: false, observed };
        await page.waitForTimeout(100).catch(() => {});
      }
    }

    case 'element_exists': {
      try {
        await page.locator(value).first().waitFor({ state: 'visible', timeout: timeoutMs });
        return { ok: true, observed: `selector "${value}" matched` };
      } catch {
        return { ok: false, observed: `selector "${value}" matched nothing within ${timeoutMs}ms` };
      }
    }

    // "<css selector> = <expected value>" — the only condition that can prove a form
    // control holds a particular value. Needed because a <select>'s chosen <option> is
    // never reported visible, so neither text_visible nor element_exists can assert a
    // dropdown however the selector is written.
    //
    // Polls, because the value is usually asserted immediately after the action that set
    // it. Exact comparison after trimming, so it stays as deterministic as the rest.
    case 'value_equals': {
      const split = splitValueEquals(value);
      if (!split) {
        return { ok: false, observed: `value_equals needs "<selector>=<expected>", got "${value}"` };
      }
      const { selector, expected } = split;

      const deadline = Date.now() + timeoutMs;
      let observed = `"${selector}" was never successfully read`;
      for (;;) {
        try {
          const actual = (await page.locator(selector).first().inputValue()).trim();
          if (actual === expected) return { ok: true, observed: `${selector} = "${actual}"` };
          observed = `${selector} = "${actual}", expected "${expected}"`;
        } catch (err) {
          observed = `could not read ${selector}: ${err.message}`;
        }
        if (Date.now() >= deadline) return { ok: false, observed };
        await page.waitForTimeout(100).catch(() => {});
      }
    }

    default:
      return { ok: false, observed: `Unknown condition type "${type}"` };
  }
}
