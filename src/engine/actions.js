/**
 * The action primitives. THE most important file in the system for the safety claim.
 *
 * Three callers use these and only these: the LLM discovery loop, the deterministic
 * replay executor, and the human operator console. There is no fourth path and no
 * privileged variant — the model does not get to "just click"; it chooses which of
 * these five functions to invoke, exactly as replay does.
 *
 * Every call is logged with its actor, so agent, replay, and human actions all land in
 * one evidence trail in one format.
 *
 * If a reviewer finds a second implementation of "click" anywhere in this repo, the
 * design claim in REPORT.md is false.
 *
 * checkAllowed() opens every function below, before the page is touched. Putting it here
 * rather than in the callers is the whole point: there is one gate and no caller can
 * forget to apply it. Actions that operate on the already-loaded page are checked against
 * the URL currently in the browser, so a mid-run redirect off the allowlist stops the
 * next action rather than being noticed after the fact.
 *
 * Hands off to: agent/discovery.js, engine/replay.js, agent/escalation.js.
 */

import { resolveUrl } from '../config/app-config.js';
import { checkAllowed } from '../policy/allowlist.js';
import { redact } from '../policy/redact.js';
import { resolveLocator } from './locator.js';

/**
 * @typedef {object} ActionContext
 * @property {import('playwright').Page} page
 * @property {object} target resolved config from apps/<app>/config.json
 * @property {{logStep: Function}} [logger] optional evidence logger
 * @property {'llm'|'replay'|'human'} actor who is performing this action
 */

/** Record one action to the evidence trail, if a logger is attached. */
function log(ctx, entry) {
  ctx.logger?.logStep({ actor: ctx.actor ?? 'replay', ...entry });
}

/**
 * Go to a route on the target.
 * @param {ActionContext} ctx
 * @param {{url: string}} args relative route or absolute URL on the target origin
 */
export async function navigate(ctx, { url }) {
  const absolute = resolveUrl(ctx.target, url);
  checkAllowed({ target: ctx.target, action: 'navigate', url: absolute });
  await ctx.page.goto(absolute, { waitUntil: 'domcontentloaded' });

  log(ctx, { action: 'navigate', detail: { url }, result: 'ok', landedOn: ctx.page.url() });
  return { url: ctx.page.url() };
}

/**
 * Click a control identified by a ranked locator strategy.
 * @param {ActionContext} ctx
 * @param {{locator: object}} args LocatorStrategy
 */
export async function click(ctx, { locator: strategy }) {
  checkAllowed({ target: ctx.target, action: 'click', url: ctx.page.url() });
  const { locator, candidate, attempts } = await resolveLocator(ctx.page, strategy, { requireEnabled: true });
  await locator.click();

  log(ctx, {
    action: 'click',
    detail: { description: strategy.description },
    locatorUsed: candidate,
    candidatesTried: attempts.length,
    result: 'ok',
  });
  return { clicked: strategy.description, via: candidate };
}

/**
 * Type into a field.
 *
 * `value` reaches the live page verbatim and the evidence trail only through redact():
 * the browser needs the real password, the transcript needs to know a field was filled
 * and roughly with what. A sensitive field logs its SHAPE (`<string:13>`), everything
 * else logs its value, because a replay that typed the wrong member ID is undebuggable
 * otherwise. The `redacted` flag is written either way so a reviewer can see the gate ran.
 *
 * A native <select> is filled by choosing an option rather than typing characters. That
 * is handled here rather than by adding a sixth primitive: `type` means "put this value
 * into this control", and picking an option is putting a value into a select. Keeping it
 * inside `type` is what lets the recorded vocabulary stay at exactly five — a dropdown
 * records, and replays, as an ordinary type step.
 *
 * Without this the five primitives simply cannot operate a dropdown: fill() throws on a
 * <select>, and clicking an <option> fails because a native option is never reported
 * visible in an automated browser. A discovery run against a form with a dropdown
 * escalates to a human every time.
 *
 * @param {ActionContext} ctx
 * @param {{locator: object, value: string, fieldName?: string}} args
 */
export async function typeText(ctx, { locator: strategy, value, fieldName }) {
  checkAllowed({ target: ctx.target, action: 'type', url: ctx.page.url() });
  const { locator, candidate, attempts } = await resolveLocator(ctx.page, strategy, { requireEnabled: true });
  const text = String(value ?? '');

  const tagName = await locator.evaluate((el) => el.tagName?.toLowerCase() ?? '').catch(() => '');
  if (tagName === 'select') {
    // By visible label first, since that is what a recording describes and what a person
    // sees; by underlying value as a fallback, for a form whose labels and values differ.
    await locator.selectOption({ label: text }).catch(() => locator.selectOption(text));
  } else {
    await locator.fill(text);
  }

  const logged = redact(value, fieldName, ctx.target);
  log(ctx, {
    action: 'type',
    detail: {
      description: strategy.description,
      field: fieldName ?? null,
      value: logged.value,
      redacted: logged.redacted,
      // Recorded so a reviewer can tell a dropdown selection from typed characters
      // without inferring it from the page.
      control: tagName === 'select' ? 'select' : 'text',
    },
    locatorUsed: candidate,
    candidatesTried: attempts.length,
    result: 'ok',
  });
  return { typedInto: strategy.description };
}

/**
 * Read text from the page, optionally pulling a substring out with a regex.
 *
 * @param {ActionContext} ctx
 * @param {{locator: object, pattern?: string}} args
 */
export async function readText(ctx, { locator: strategy, pattern }) {
  checkAllowed({ target: ctx.target, action: 'read', url: ctx.page.url() });
  const { locator, candidate, attempts } = await resolveLocator(ctx.page, strategy);
  const raw = (await locator.innerText()).trim();

  let extracted = raw;
  if (pattern) {
    const match = new RegExp(pattern).exec(raw);
    // First capture group when present, otherwise the whole match; null if no match,
    // so a caller can tell "read nothing" from "read an empty string".
    extracted = match ? (match[1] ?? match[0]) : null;
  }

  log(ctx, {
    action: 'read',
    detail: { description: strategy.description, pattern: pattern ?? null, chars: raw.length },
    locatorUsed: candidate,
    candidatesTried: attempts.length,
    result: extracted === null ? 'no-match' : 'ok',
  });
  return { raw, extracted };
}

/**
 * Wait for a declared condition to hold. The only primitive that does not touch the page.
 * @param {ActionContext} ctx
 * @param {{condition: object}} args
 */
export async function waitFor(ctx, { condition }) {
  checkAllowed({ target: ctx.target, action: 'wait_for', url: ctx.page.url() });
  const { evaluateCondition } = await import('./perception.js');
  const result = await evaluateCondition(ctx.page, condition);

  log(ctx, {
    action: 'wait_for',
    detail: { condition },
    result: result.ok ? 'ok' : 'timeout',
    observed: result.observed,
  });
  return result;
}

/**
 * Dispatch table, keyed by ACTION_TYPES.
 *
 * Both the LLM tool layer and the replay executor go through this map, which is what
 * guarantees they cannot drift apart: adding an action means adding it here once.
 */
export const ACTIONS = { navigate, click, type: typeText, read: readText, wait_for: waitFor };

/**
 * Invoke an action by name.
 * @throws {Error} on an unknown action name — the model cannot invent a sixth primitive.
 */
export async function performAction(ctx, actionName, args) {
  const fn = ACTIONS[actionName];
  if (!fn) throw new Error(`Unknown action "${actionName}". Known: ${Object.keys(ACTIONS).join(', ')}`);
  return fn(ctx, args);
}
