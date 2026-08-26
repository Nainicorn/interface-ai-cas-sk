/**
 * The recovery table: a small, explicit list of known interstitials and how to clear them.
 *
 * This is the RECOVERABLE branch of the outcome contract, and its most important
 * property is what it is NOT: it is not the model improvising a fix. Every entry is
 * hand-declared, matched by an exact condition, capped in attempts, and logged. Replay
 * must never call an LLM — including for recovery — so recovery has to be a lookup
 * table rather than a judgement call.
 *
 * Entries are checked BEFORE a step's action (clear the blocker, then act) and again
 * after a checkpoint fails (maybe a banner appeared mid-flow).
 *
 * Hands off to: engine/replay.js.
 */

/**
 * @typedef {object} RecoveryRule
 * @property {string} code            stable identifier for the log
 * @property {string[]} app_ids       which targets this applies to; ['*'] for all
 * @property {object} detect          a Condition — see schema/enums.js CONDITION_TYPES
 * @property {object} action          { type: 'click'|'reload', locator?, }
 * @property {string} description
 */

/** @type {RecoveryRule[]} */
export const RECOVERY_RULES = [
  {
    code: 'DISMISS_NOTICE_BANNER',
    app_ids: ['*'],
    detect: { type: 'element_exists', value: 'button:has-text("Dismiss")', timeout_ms: 500 },
    action: {
      type: 'click',
      locator: {
        description: 'Dismiss button on a blocking notice',
        candidates: [{ kind: 'role', role: 'button', value: 'Dismiss', confidence: 0.9 }],
      },
    },
    description: 'Clear a modal notice that covers the working area.',
  },
  {
    code: 'RELOAD_ON_GATEWAY_ERROR',
    app_ids: ['*'],
    detect: { type: 'text_visible', value: '502 Bad Gateway', timeout_ms: 500 },
    action: { type: 'reload' },
    description: 'Transient upstream error. One reload, then give up.',
  },
];

/** Rules applicable to a given target. */
export function rulesFor(appId) {
  return RECOVERY_RULES.filter((rule) => rule.app_ids.includes('*') || rule.app_ids.includes(appId));
}

/**
 * Try every applicable recovery rule once.
 *
 * Bounded by construction: each rule fires at most once per call, and replay calls this
 * at most once per step. There is no loop that could spin trying to recover forever.
 *
 * @returns {Promise<Array<{code: string, description: string}>>} recoveries actually applied
 */
export async function attemptRecovery(ctx, { evaluateCondition, click }) {
  const applied = [];

  for (const rule of rulesFor(ctx.target.app_id)) {
    const { ok } = await evaluateCondition(ctx.page, rule.detect);
    if (!ok) continue;

    // Only a rule that actually DID something counts as applied. Pushing unconditionally
    // meant an unrecognised action type was a silent no-op that still reported itself as
    // a recovery — and replay would then classify the run RECOVERABLE on the strength of
    // nothing having happened.
    if (rule.action.type === 'reload') {
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
    } else if (rule.action.type === 'click') {
      await click(ctx, { locator: rule.action.locator });
    } else {
      continue;
    }

    applied.push({ code: rule.code, description: rule.description });
  }

  return applied;
}
