/**
 * Assisted fallback: a single, bounded, policy-checked LLM call to suggest a replacement
 * locator when a step's recorded candidates all fail to resolve.
 *
 * This is the one piece of the system that reintroduces non-determinism into replay, so
 * every property below is deliberate:
 *
 *   - OFF by default. A caller opts in per replay (see api/run-replay.js's
 *     `assistedFallback` option) — turning it on is never something that just happens.
 *   - AT MOST ONE call, for the WHOLE replay, not per step. engine/replay.js enforces
 *     this with a used-once flag; a recording having a bad day never becomes an
 *     open-ended retry loop.
 *   - SCOPED to a locator suggestion only. The tool schema below lets the model return
 *     nothing but an alternative LocatorStrategy — it cannot propose a different action,
 *     url, or checkpoint, and the response is re-validated against that same schema
 *     before anything acts on it. A malformed or hallucinated reply is treated as no
 *     suggestion, never forced through.
 *   - Whatever the model suggests is retried through the exact same action primitives
 *     (engine/actions.js) as everything else, so checkAllowed() still runs — there is no
 *     privileged path for an assisted fix to act outside the allowlist.
 *   - Logged as its own evidence event (`assisted_fallback`), distinct from a
 *     recovery-table hit, so a reviewer can always tell "a fixed rule caught this" apart
 *     from "the model improvised."
 *
 * engine/replay.js never imports this file or the Anthropic SDK — this module is handed
 * to replay as an opaque callback, so tests/invariants.test.js's determinism claim stays
 * literally true whether or not a caller opts in.
 *
 * Hands off to: engine/replay.js (via the `fallback` callback), api/run-replay.js.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { LocatorStrategySchema } from '../schema/capability.js';

export const FALLBACK_MODEL = 'claude-sonnet-5';

const SuggestionSchema = z.object({
  locator: LocatorStrategySchema,
  reasoning: z.string().min(1).describe('Why this element is likely the right one, in one sentence'),
});

const SUGGEST_LOCATOR_TOOL = {
  name: 'suggest_locator',
  description:
    'Propose ONE alternative locator strategy for the element this step is trying to act on. ' +
    'You are not deciding what happens next in the flow — only how to find the SAME element ' +
    'the step already declared. Do not suggest a different action, url, or goal.',
  input_schema: z.toJSONSchema(SuggestionSchema, { target: 'draft-7' }),
};

/**
 * Ask the model for one replacement locator, given why the recorded candidates failed.
 *
 * @param {object} args
 * @param {object} args.step the step whose locator could not be resolved
 * @param {Array<object>} args.attempts every candidate that was tried and why it lost
 * @param {string} args.ariaTree the current page's accessibility tree
 * @returns {Promise<{locator: object, reasoning: string}|null>} null on any failure to
 *   get a usable suggestion — a network error, a declined response, or one that fails
 *   validation are all treated identically: no suggestion.
 */
export async function suggestLocator({ step, attempts, ariaTree }) {
  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.create({
      model: FALLBACK_MODEL,
      max_tokens: 1024,
      system:
        'A recorded browser-automation step just failed to find its target element. You get ' +
        'exactly one attempt to suggest a better way to find the SAME element — you are not ' +
        'deciding what happens next in the flow, only proposing an alternative locator.',
      tools: [SUGGEST_LOCATOR_TOOL],
      tool_choice: { type: 'tool', name: 'suggest_locator' },
      messages: [
        {
          role: 'user',
          content:
            `Step intent: ${step.intent}\n` +
            `Looking for: ${step.locator?.description ?? '(no locator description recorded)'}\n\n` +
            `Candidates already tried and why each failed:\n${JSON.stringify(attempts, null, 2)}\n\n` +
            `Current page accessibility tree:\n${ariaTree}`,
        },
      ],
    });
  } catch {
    return null; // a network/API failure here is "no suggestion", never a crash of the replay
  }

  const call = response.content.find((block) => block.type === 'tool_use');
  if (!call) return null;

  const parsed = SuggestionSchema.safeParse(call.input);
  return parsed.success ? parsed.data : null;
}
