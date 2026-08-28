/**
 * The fixed vocabularies the whole system agrees on.
 *
 * These are deliberately small and closed. Every one of them is a place where an open
 * string would let nondeterminism back in — a replay that matched checkpoints "fuzzily",
 * or an outcome taxonomy that grew a fifth ambiguous case, would defeat the point.
 *
 * Hands off to: schema/capability.js, engine/replay.js.
 */

/**
 * What an action primitive can do. The LLM never invents an action; it only ever
 * chooses one of these, and replay executes the same five.
 */
export const ACTION_TYPES = ['navigate', 'click', 'type', 'read', 'wait_for'];

/**
 * Checkpoint condition vocabulary. Intentionally boring and exact-match — a fuzzy or
 * model-scored matcher would smuggle nondeterminism into the no-LLM path.
 */
export const CONDITION_TYPES = [
  'text_visible',
  'text_absent',
  'url_contains',
  'element_exists',
  // `value_equals` exists because the other four cannot assert a form control's value.
  // A <select>'s chosen <option> is never reported visible by a browser, so text_visible
  // and element_exists both fail on it however the selector is written — which left a
  // dropdown step with no way to prove it worked. Exact string comparison against
  // inputValue(), so it stays as deterministic as the rest of the vocabulary.
  'value_equals',
  // The status line of the document on screen. A legacy target states a runtime fault
  // twice — in the status and in the page — and the status is the better of the two to
  // classify on: it cannot be matched by accident the way a phrase can, and it does not
  // move when the wording does. Value is one code, or several separated by commas.
  'http_status',
];

/** How a locator candidate finds its element, ordered here by preferred robustness. */
export const LOCATOR_KINDS = ['role', 'label', 'placeholder', 'text', 'css'];

/**
 * Safe vs risky. Safe actions are reversible reads and navigation; risky actions
 * create or modify state. Risky steps require confirmation during discovery, and a
 * risky capability cannot replay unattended until a human approves it.
 */
export const RISK_LEVELS = ['safe', 'risky'];

/** Draft capabilities are never invoked unattended. Promotion to approved is human-gated. */
export const CAPABILITY_STATUSES = ['draft', 'approved'];

/**
 * The replay result contract.
 *
 * The distinction that matters most in this system is BUSINESS_OUTCOME vs HARD_FAILURE.
 * "No such member" is a legitimate answer the caller asked for — collapsing it into an
 * error is the single most common design mistake in this problem space, so it gets its
 * own first-class outcome rather than an exception with a special message.
 */
export const OUTCOME_TYPES = [
  /** Checkpoint verified and declared outputs extracted. */
  'SUCCESS',
  /** A legitimate non-happy-path the caller needs to know about. Not an error. */
  'BUSINESS_OUTCOME',
  /** A known, declared interstitial that was handled. Execution continued. */
  'RECOVERABLE',
  /** Nothing matched. Stop and surface step, expectation, observation, screenshot. */
  'HARD_FAILURE',
  /**
   * The flow reached a state a person has to resolve — a supervisor override, an
   * authority this operator does not hold. Distinct from HARD_FAILURE because nothing
   * is broken, and from BUSINESS_OUTCOME because it is not an answer the caller can act
   * on: the work is real and unfinished, and someone else has to finish it.
   */
  'ESCALATED',
];

/** Who performed an action. Every evidence line carries one of these. */
export const ACTORS = ['llm', 'replay', 'human'];
