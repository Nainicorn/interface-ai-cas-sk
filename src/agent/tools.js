/**
 * The model's tool surface: one tool per action primitive, plus emit_artifact and
 * escalate. This file defines SHAPES only — it performs nothing.
 *
 * Every input schema is generated from the same Zod definitions the artifact schema
 * uses (schema/capability.js). That is deliberate: the vocabulary the model speaks
 * during discovery IS the vocabulary the artifact stores and replay executes, so
 * nothing needs translating and nothing can drift.
 *
 * Hands off to: agent/discovery.js (dispatch), agent/artifact-writer.js (emission).
 */

import { z } from 'zod';
import {
  BusinessOutcomeRuleSchema,
  ConditionSchema,
  LocatorStrategySchema,
  StepSchema,
} from '../schema/capability.js';
import { RISK_LEVELS } from '../schema/enums.js';

/** Scalar types the input-parameter validator supports — keep the two in lockstep. */
const PARAM_TYPES = ['string', 'number', 'integer', 'boolean'];

/** One declared input parameter. The writer turns these into a JSON Schema. */
export const InputDeclSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case'),
  type: z.enum(PARAM_TYPES).default('string'),
  description: z.string().min(1),
  required: z.boolean().default(true),
  pattern: z.string().optional().describe('Regex the value must match, e.g. ^\\d+$'),
});

/** One declared output. Values are extracted from the page, so they are strings. */
export const OutputDeclSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case'),
  description: z.string().min(1),
});

/** What the model hands over when the goal is demonstrably achieved. */
export const EmissionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case')
    .describe('Stable capability id, e.g. lookup-savings-balance'),
  name: z.string().min(1),
  description: z.string().min(1).describe('What a calling agent gets from this capability'),
  inputs: z.array(InputDeclSchema).describe('Typed parameters a caller must supply'),
  outputs: z.array(OutputDeclSchema).describe('Named values the steps extract via extract_as'),
  risk_level: z.enum(RISK_LEVELS).default('safe'),
  steps: z
    .array(StepSchema)
    .min(1)
    .describe('The CLEAN replayable path: parameterized, dead ends dropped, indexes from 0'),
  success_checkpoint: ConditionSchema.describe('Overall proof the goal was reached'),
  business_outcomes: z
    .array(BusinessOutcomeRuleSchema)
    .default([])
    .describe(
      'Flow-level non-happy-paths: legitimate endings that can surface at more than one ' +
        'step, or one step later than the step that caused them. Checked only when a step ' +
        'is about to be reported as a failure.',
    ),
});

/** Inputs for the `type` tool. Exactly one value source; the harness resolves it. */
const TypeInputSchema = z.object({
  locator: LocatorStrategySchema,
  value_from: z.string().optional().describe('Name of a run parameter; the harness supplies its value'),
  value_from_env: z.string().optional().describe('Env var NAME of a credential; you never see the value'),
  value_literal: z.string().optional().describe('A non-sensitive constant'),
  field_name: z.string().optional().describe('Field name for the redaction policy, if not obvious'),
});

const toJson = (schema) => z.toJSONSchema(schema, { target: 'draft-7' });

/**
 * The tool list handed to the API. Descriptions state when to use each tool and what
 * comes back; the loop enforces the rules the descriptions promise.
 */
export const TOOLS = [
  {
    name: 'navigate',
    description:
      'Go to a route on the target app (relative path like /search). Use for entry points ' +
      'and known routes, not as a substitute for clicking through the UI. Returns the ' +
      'resulting page state.',
    input_schema: toJson(z.object({ url: z.string().describe('Relative route, e.g. /login') })),
  },
  {
    name: 'click',
    description:
      'Click one control, found via a RANKED list of locator candidates tried in order. ' +
      'A candidate must match exactly one visible element or it is rejected and the next ' +
      'is tried. Prefer role+name, then label, placeholder, visible text; css only as a ' +
      'scoped last resort. Give 2+ candidates when the page allows it. Returns the page ' +
      'state after the click.',
    input_schema: toJson(z.object({ locator: LocatorStrategySchema })),
  },
  {
    name: 'type',
    description:
      'Fill one form field. Supply exactly ONE value source: value_from (a run parameter ' +
      'name — use this for any caller-supplied data so the recording stays parameterized), ' +
      'value_from_env (a credential env var NAME — the secret never appears in the ' +
      'conversation), or value_literal (non-sensitive constants only).',
    input_schema: toJson(TypeInputSchema),
  },
  {
    name: 'read',
    description:
      'Read text from one element found via ranked candidates. Optional regex pattern: ' +
      'first capture group wins. Use to verify data is on screen and to test the exact ' +
      'locator+pattern you will record for each output before emitting the artifact.',
    input_schema: toJson(
      z.object({
        locator: LocatorStrategySchema,
        pattern: z.string().optional().describe('Regex; first capture group is the extracted value'),
      }),
    ),
  },
  {
    name: 'wait_for',
    description:
      'Wait until a condition holds (text_visible, text_absent, url_contains, ' +
      'element_exists). Use sparingly — actions already settle the page.',
    input_schema: toJson(z.object({ condition: ConditionSchema })),
  },
  {
    name: 'emit_artifact',
    description:
      'Record the capability. Call EXACTLY ONCE, only after the goal result is visible on ' +
      'the current page — the harness re-verifies success_checkpoint against the live page ' +
      'and rejects the emission if it does not hold. Steps must be the clean replayable ' +
      'path: caller data via value_from, credentials via value_from_env, an ' +
      'expected_outcome checkpoint on every step, business_outcomes declared wherever a ' +
      'legitimate non-happy-path exists (e.g. record not found), and extract_as on the ' +
      'steps that produce each declared output. Every recorded locator must be one you ' +
      'exercised live during this run — verify each output with the exact candidate list ' +
      'and pattern you record. If validation fails you get the errors back — fix and re-emit.',
    input_schema: toJson(EmissionSchema),
  },
  {
    name: 'escalate',
    description:
      'Hand control to a human operator, then CONTINUE once they hand it back. Use when ' +
      'a human can unblock you — a control cannot be found, the page is in an unexpected ' +
      'state, credentials are rejected, or a risky state-changing action needs ' +
      'confirmation. Not a failure — a designed outcome. If a human has already told you ' +
      'the goal cannot be done, call abandon instead of escalating again.',
    input_schema: toJson(
      z.object({
        reason: z.string().min(1).describe('What is blocking, specifically'),
        attempted: z.string().optional().describe('What you already tried'),
      }),
    ),
  },
  {
    name: 'abandon',
    description:
      'Declare the goal unreachable and END the run. Use when no human can unblock you ' +
      'and further attempts would be pointless: the operator has said there is no way ' +
      'forward, the feature does not exist in this app, or the goal contradicts what the ' +
      'app can do. This is a verdict, not a crash — the run records why, and no ' +
      'capability is written. Prefer escalate whenever a human could still help; use this ' +
      'when they cannot.',
    input_schema: toJson(
      z.object({
        reason: z.string().min(1).describe('Why the goal cannot be accomplished in this app'),
        attempted: z.string().optional().describe('What you tried before concluding this'),
      }),
    ),
  },
];
