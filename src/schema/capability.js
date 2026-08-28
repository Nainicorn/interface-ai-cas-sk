/**
 * The capability schema — the contract at the centre of this system.
 *
 * A capability is NOT a transcript of what the model did. It is a typed, versioned,
 * reviewable description of a flow that an agent can call: what it needs, what it
 * returns, how each control is found, and how success is proven. The raw model
 * transcript lives separately in evidence/{run_id}/ and is deliberately decoupled.
 *
 * One Zod definition feeds four consumers: artifact validation on save/load, replay
 * parameter validation, Claude's tool input_schema, and the agent-facing catalog.
 *
 * Hands off to: schema/store.js (persistence), engine/replay.js (execution).
 */

import { z } from 'zod';
import {
  ACTION_TYPES,
  CAPABILITY_STATUSES,
  CONDITION_TYPES,
  LOCATOR_KINDS,
  RISK_LEVELS,
} from './enums.js';

/**
 * A checkpoint condition. Deliberately a closed vocabulary with exact matching —
 * see enums.js for why fuzziness is disallowed here.
 */
export const ConditionSchema = z.object({
  type: z.enum(CONDITION_TYPES),
  value: z.string().min(1).describe('Text to find, URL fragment, or a CSS selector'),
  timeout_ms: z.number().int().positive().max(30000).default(5000),
});

/**
 * One way to find an element.
 *
 * `value` is interpreted per `kind`: the accessible name for `role`, the label or
 * placeholder text for those kinds, the visible string for `text`, and a selector
 * for `css`. Keeping it one flat shape (rather than a discriminated union) keeps the
 * JSON readable in a diff, which matters because artifacts get reviewed by humans.
 */
export const LocatorCandidateSchema = z.object({
  kind: z.enum(LOCATOR_KINDS),
  value: z.string().min(1),
  role: z.string().optional().describe('ARIA role; required when kind is "role"'),
  exact: z.boolean().default(false),
  confidence: z.number().min(0).max(1).describe('Recorder\'s confidence this survives a UI revision'),
  note: z.string().optional().describe('Why this candidate exists, or when it is expected to break'),
});

/**
 * A ranked list of ways to find one element.
 *
 * Never a single selector. The target environment has no test IDs, so any one strategy
 * is a guess; the ordered list lets replay degrade instead of snapping. Candidates are
 * tried in array order and the first that resolves to exactly one visible, enabled
 * element wins.
 */
export const LocatorStrategySchema = z.object({
  description: z.string().min(1).describe('Human-readable: which control this is'),
  candidates: z.array(LocatorCandidateSchema).min(1),
});

/**
 * A declared non-happy-path for one step.
 *
 * This is what makes BUSINESS_OUTCOME a first-class result rather than a guess. The
 * recording states, per step, what a legitimate alternative result looks like on screen
 * and what code the caller should receive — so replay classifies it by matching a
 * declared rule, never by interpreting the page.
 */
export const BusinessOutcomeRuleSchema = z.object({
  code: z.string().min(1).describe('Stable machine code, e.g. MEMBER_NOT_FOUND'),
  detect: ConditionSchema,
  message: z.string().min(1).describe('Human-readable explanation for the caller'),

  /**
   * Optionally read the app's OWN wording for this outcome off the page.
   *
   * Detection wants a stable, generic anchor — this target renders one rejection banner
   * for every kind of invalid transaction — but a caller that is only told
   * TRANSACTION_REJECTED cannot act on it or explain it to anyone. The anchor classifies;
   * this says which line of the page carries the reason.
   *
   * Best-effort by construction: a detail that cannot be read is dropped, never allowed
   * to turn a classified outcome back into a failure.
   */
  detail: z
    .object({ locator: LocatorStrategySchema, pattern: z.string().optional() })
    .optional()
    .describe("Where the app states its own reason for this outcome"),
});

/**
 * One recorded step.
 *
 * `intent` carries the "why" so a human reviewer can read the artifact as a story;
 * everything else is what replay mechanically needs.
 */
export const StepSchema = z.object({
  index: z.number().int().nonnegative(),
  intent: z.string().min(1).describe('Why this step exists, in plain language'),
  action: z.enum(ACTION_TYPES),

  locator: LocatorStrategySchema.optional().describe('Required for click, type, read'),
  url: z.string().optional().describe('Relative path; required for navigate'),

  // Exactly one of these supplies the value for a `type` action. `value_from` binds to
  // an input parameter; `value_literal` is for non-sensitive constants the flow needs.
  // Secrets use neither — see `value_from_env`.
  value_from: z.string().optional().describe('Name of an input parameter'),
  value_literal: z.string().optional().describe('Literal constant; never a secret'),
  value_from_env: z
    .string()
    .optional()
    .describe('Env var NAME for a credential. The value is never stored or logged.'),

  expected_outcome: ConditionSchema.describe('Asserted after the action; never assumed'),
  business_outcomes: z.array(BusinessOutcomeRuleSchema).default([]),

  extract_as: z.string().optional().describe('Bind a value read from the page to this output name'),
  extract_pattern: z.string().optional().describe('Optional regex; first capture group wins'),

  risk: z.enum(RISK_LEVELS).default('safe'),
});

/**
 * A per-tenant diff over a base recording.
 *
 * Not built in this slice — it is here because the shape is the whole multi-tenant
 * argument. Hundreds of institutions run the same vendor product with different
 * branding and minor field renames; the design answer is one base capability plus a
 * small override layer, not one recording per tenant. Leaving the field out would make
 * that story retrofitted rather than designed.
 */
export const TenantOverrideSchema = z.object({
  tenant_id: z.string().min(1),
  base_url: z.string().optional(),
  step_overrides: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        locator: LocatorStrategySchema.optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  note: z.string().optional(),
});

/** Rolling reliability signal. Written by replay, read by the approval gate. */
export const ConfidenceSchema = z.object({
  runs: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  last_outcome: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});

/** A raw JSON Schema object, produced by z.toJSONSchema() at record time. */
const JsonSchemaObject = z.record(z.string(), z.unknown());

/**
 * The capability itself.
 *
 * `target.app_id` names the VENDOR PRODUCT, not a tenant and not a URL. That indirection
 * is what lets one recording serve many institutions running the same software, and it
 * is why the base URL lives in apps/<app>/config.json rather than in the recording.
 */
export const CapabilitySchema = z.object({
  schema_version: z.literal(1).default(1),

  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case'),
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  status: z.enum(CAPABILITY_STATUSES).default('draft'),
  description: z.string().min(1).describe('What a calling agent gets from this capability'),

  target: z.object({
    app_id: z.string().min(1).describe('App key; resolved via apps/<app>/config.json'),
    entry_route: z.string().min(1),
    tenant_overrides: z.array(TenantOverrideSchema).default([]),
  }),

  input_schema: JsonSchemaObject.describe('Typed parameters the caller supplies'),
  output_schema: JsonSchemaObject.describe('Typed shape the caller gets back'),

  risk_level: z.enum(RISK_LEVELS).default('safe'),
  steps: z.array(StepSchema).min(1),
  success_checkpoint: ConditionSchema.describe('Overall proof the goal was reached'),

  /**
   * Non-happy-paths that belong to the FLOW rather than to one step.
   *
   * A step-level rule has to name the step where the alternative shows, and that is
   * often not knowable when recording: "no such member" surfaces one step later than the
   * search, and an injected maintenance page or an expired session can land on any step
   * at all. Worse, a step-level rule is suppressed whenever that step's own checkpoint
   * also holds — which is exactly what a weak checkpoint like "the url still says
   * by=number" does on a page that found nothing.
   *
   * These are checked only when a step is about to be reported HARD_FAILURE, so they
   * cannot mask a step that succeeded, and they turn "the recording stopped working"
   * into "the app said no" wherever the flow can legitimately end early.
   */
  business_outcomes: z.array(BusinessOutcomeRuleSchema).default([])
    .describe('Flow-level non-happy-paths, checked before any step is called a failure'),

  created_from: z.object({
    run_id: z.string().min(1).describe('Links to evidence/{run_id}/, does not embed it'),
    model: z.string().nullable().default(null),
    recorded_at: z.string(),
  }),

  redaction_policy: z.object({
    redact_fields: z
      .array(z.string())
      .default([])
      .describe('Field names whose VALUES must never reach a log or artifact'),
  }),

  // Spelled out rather than `.default({})`: Zod 4 returns a default value as-is instead
  // of parsing it, so `{}` stayed `{}` and the first replay computed `undefined + 1`.
  confidence: ConfidenceSchema.default({ runs: 0, successes: 0, last_outcome: null, updated_at: null }),

});

/**
 * Validate an unknown object as a Capability.
 * @throws {z.ZodError} with a field-level path, so a bad artifact fails loudly at the
 *   boundary rather than halfway through a replay.
 */
export function parseCapability(input) {
  return CapabilitySchema.parse(input);
}

/** Non-throwing variant, for callers that want to report rather than crash. */
export function safeParseCapability(input) {
  return CapabilitySchema.safeParse(input);
}
