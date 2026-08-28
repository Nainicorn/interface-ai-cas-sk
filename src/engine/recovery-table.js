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
    code: 'MERIDIAN_MAINTENANCE_INTERSTITIAL',
    app_ids: ['meridian'],
    detect: { type: 'http_status', value: '503', timeout_ms: 500 },
    action: {
      type: 'click',
      locator: {
        description: 'Continue past the maintenance interstitial',
        candidates: [
          { kind: 'role', role: 'link', value: 'Continue', confidence: 0.9 },
          { kind: 'text', value: 'Continue', confidence: 0.5 },
        ],
      },
    },
    description: 'Nightly batch window. The host offers a Continue link; take it and carry on.',
  },
  {
    code: 'MERIDIAN_APPLICATION_ERROR',
    app_ids: ['meridian'],
    detect: { type: 'http_status', value: '500', timeout_ms: 500 },
    action: { type: 'reload' },
    description: 'Unexpected application error. One reload, then it is a hard failure.',
  },
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

/**
 * @typedef {object} FaultRule
 * @property {string} code
 * @property {string[]} app_ids
 * @property {object} detect                    a Condition
 * @property {'BUSINESS_OUTCOME'|'ESCALATED'} outcome
 * @property {string} message
 * @property {'safe'|'risky'|'*'} [applies_to]  which capabilities this rule speaks for
 */

/**
 * Faults that are not recoverable, and what each one MEANS.
 *
 * The distinction this table encodes is the one the whole outcome contract rests on. A
 * 404 is an answer — the record is not there, and the caller needs to know that rather
 * than be told the automation broke. A 403 is not an answer: the work is real and
 * unfinished, and only someone with more authority can finish it.
 *
 * Declared per app rather than per capability because a runtime fault belongs to the
 * host, not to the flow that happened to be running: every capability against this
 * target meets the same six, and making each recording restate them would be seven
 * chances to get it wrong.
 *
 * A capability's own rules are consulted first, so a flow that has something more
 * specific to say about a status still wins.
 *
 * @type {FaultRule[]}
 */
export const FAULT_RULES = [
  {
    code: 'RECORD_NOT_FOUND',
    app_ids: ['meridian'],
    detect: { type: 'http_status', value: '404', timeout_ms: 500 },
    outcome: 'BUSINESS_OUTCOME',
    message: 'The requested member record could not be located on this host.',
  },
  {
    code: 'TRANSACTION_REJECTED',
    app_ids: ['meridian'],
    detect: { type: 'http_status', value: '400', timeout_ms: 500 },
    outcome: 'BUSINESS_OUTCOME',
    message: 'The transaction could not be completed as entered.',
  },
  {
    code: 'SUPERVISOR_OVERRIDE_REQUIRED',
    app_ids: ['meridian'],
    detect: { type: 'http_status', value: '403', timeout_ms: 500 },
    outcome: 'ESCALATED',
    message: 'The signed-on operator is not authorised for this function. A supervisor must complete it.',
  },
  {
    // Deliberately NOT recovered, and deliberately only for flows that change something.
    //
    // Re-authenticating and carrying on is safe for a read and reckless for a transfer:
    // the run cannot tell whether the post it was making landed before the session
    // dropped, and the cost of guessing wrong is a duplicate irreversible transaction.
    // So a mutating flow stops and hands over; the safe case is handled by restarting
    // the whole flow once, in engine/replay.js, where re-running from the top is
    // genuinely harmless.
    code: 'SESSION_EXPIRED_MID_TRANSACTION',
    app_ids: ['meridian'],
    detect: { type: 'http_status', value: '440', timeout_ms: 500 },
    outcome: 'ESCALATED',
    applies_to: 'risky',
    message:
      'The operator session expired part-way through a transaction. Whether it posted ' +
      'cannot be determined from here, so it needs a person to check before any retry.',
  },
];

/** Fault rules that apply to a given target and risk level. */
export function faultsFor(appId, riskLevel = 'safe') {
  return FAULT_RULES.filter(
    (rule) =>
      (rule.app_ids.includes('*') || rule.app_ids.includes(appId)) &&
      (!rule.applies_to || rule.applies_to === '*' || rule.applies_to === riskLevel),
  );
}
