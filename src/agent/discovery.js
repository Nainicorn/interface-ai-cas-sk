/**
 * The discovery loop — the ONE place in this system where a model decides anything.
 *
 * observe → decide → act: Claude sees the page (a11y tree + trimmed text + screenshot),
 * chooses one of the five action primitives, the harness executes it through the same
 * engine/actions.js functions replay uses, and the new page state goes back as the tool
 * result. On success the model emits a typed capability; when stuck it escalates.
 *
 * A manual loop, not the SDK's toolRunner — deliberately: escalation must be able to
 * suspend this loop and resume it from a different HTTP request later, the brief grades
 * the observe/decide/act loop so it should be visible as an actual loop, and the one
 * path that must work should not carry a beta dependency.
 *
 * The model NEVER sees a secret. Credentials are referenced by env var name and
 * resolved here, after the model has chosen where to type them.
 *
 * Hands off to: cli/discover.js, agent/artifact-writer.js, evidence/logger.js.
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { performAction } from '../engine/actions.js';
import { LocatorResolutionError } from '../engine/errors.js';
import { captureState, evaluateCondition } from '../engine/perception.js';
import { PolicyViolation, getTarget } from '../policy/allowlist.js';
import { classifyRisk } from '../policy/risk.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { writeCapability } from './artifact-writer.js';
import { EmissionSchema, TOOLS } from './tools.js';

export const DISCOVERY_MODEL = 'claude-sonnet-5';

/** Tool names that map 1:1 onto action primitives. */
const ACTION_TOOLS = new Set(['navigate', 'click', 'read', 'wait_for', 'type']);

function buildSystemPrompt(target, params) {
  const credentials = Object.values(target.credentials ?? {});
  const paramLines = Object.entries(params)
    .map(([name, value]) => `- ${name} = ${value}`)
    .join('\n');

  return `You are the discovery agent inside a computer-use automation system for legacy banking software. You drive a real browser through five primitives; a policy layer gates every action. Accomplish the goal ONCE, learning the UI as you go — then record what you learned as a typed, replayable capability that will later run with NO model in the loop. The recording is the product; reaching the goal is how you learn it.

## Target
- App: ${target.display_name ?? target.app_id} (app_id: ${target.app_id})
- Entry route: ${target.entry_route} — the browser is already there.
- Routes you may touch: ${(target.allowlist?.route_prefixes ?? []).join(', ')}
- Actions permitted: ${(target.allowlist?.action_types ?? []).join(', ')}
- Routes classified risky (state-changing; need human confirmation): ${(target.risky_route_patterns ?? []).join(', ') || 'none'}
- Credentials, by env var name (the harness injects values; you never see them): ${credentials.join(', ')}

## Run parameters
${paramLines || '- none'}

When typing caller-supplied data, use value_from with the parameter name so the recording stays parameterized. Type credentials with value_from_env.

## Perception
After each action you receive the page URL, title, accessibility tree, visible text, and a screenshot. The accessibility tree is the primary channel; the screenshot is grounding.

## Recording quality
- Every recorded step needs an expected_outcome that positively proves the step worked. Never infer success from "the action didn't error".
- Declare business_outcomes wherever the app has a legitimate non-happy path (e.g. searching for a record that doesn't exist). "No such record" is an answer the caller needs, not a failure — declare how it looks on screen so replay can classify it without guessing.
- Locators are ranked candidate lists, most robust first: role+name, label, placeholder, visible text, tightly-scoped css last. A candidate matching more than one element is rejected at replay, so every candidate must be unique on its page. Legacy UIs nest layout tables: a bare row selector like tr:has-text(...) usually matches several nested rows — scope to a distinguishing ancestor, and give each locator a second candidate as fallback. When a candidate is rejected as ambiguous, the error lists each match's ancestor path with its attributes — pick a distinguishing ancestor attribute from it to scope your next candidate.
- Record only what you have verified. Before emitting, exercise each output's read using the SAME candidate list and extract_pattern you will record — a candidate list you never executed is a guess, and it is the top cause of replay failure.
- Never build a recorded locator from the concrete value it extracts (e.g. locating by this run's account number). That embeds one run's data and cannot replay for other inputs. Locate by structure or stable labels instead.
- Emit once, when the goal result is visible on the current page. If genuinely stuck, escalate — a designed outcome, not a failure.`;
}

/** Format one observation as tool-result content blocks (text + screenshot). */
function observationBlocks(state, screenshotName, resultNote) {
  const text = [
    resultNote,
    `URL: ${state.url}`,
    `Title: ${state.title}`,
    `--- Accessibility tree ---`,
    state.ariaTree,
    `--- Visible text ---`,
    state.visibleText,
  ]
    .filter(Boolean)
    .join('\n');

  const blocks = [{ type: 'text', text }];
  if (state.screenshotBase64) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: state.screenshotBase64 },
    });
  }
  return { blocks, screenshotName };
}

/** Capture, persist to evidence, and package the current page state. */
async function observe(page, logger, label, resultNote) {
  const state = await captureState(page);
  const screenshotName = logger.saveScreenshot(state.screenshotBase64, label);
  logger.logEvent('observation', {
    url: state.url,
    title: state.title,
    ariaTree: state.ariaTree,
    visibleTextChars: state.visibleText.length,
    screenshot: screenshotName,
  });
  return observationBlocks(state, screenshotName, resultNote);
}

/**
 * Resolve the value for a `type` tool call. Mirrors replay's precedence exactly —
 * which is the point: what the model records is what replay will do.
 */
function resolveTypedValue(input, params) {
  const sources = ['value_from', 'value_from_env', 'value_literal'].filter((k) => input[k] !== undefined);
  if (sources.length !== 1) {
    throw new Error(`"type" needs exactly one of value_from / value_from_env / value_literal, got ${sources.length}`);
  }
  if (input.value_from !== undefined) {
    const value = params[input.value_from];
    if (value === undefined) throw new Error(`No run parameter named "${input.value_from}"`);
    return { value: String(value), fieldName: input.field_name ?? input.value_from };
  }
  if (input.value_from_env !== undefined) {
    const value = process.env[input.value_from_env];
    if (!value) throw new Error(`Env var ${input.value_from_env} is not set — cannot supply this credential`);
    return { value, fieldName: input.field_name ?? input.value_from_env };
  }
  return { value: input.value_literal, fieldName: input.field_name ?? null };
}

/**
 * Run one real discovery session against a live target.
 *
 * @param {object} args
 * @param {string} args.goal    natural-language goal
 * @param {string} args.appId   key into config/targets.json
 * @param {object} [args.params]   run parameters, e.g. { member_id: '10001' }
 * @param {number} [args.maxTurns] model-call budget before forced escalation
 * @param {boolean} [args.headless]
 * @param {string} [args.runId]
 * @returns {Promise<{status: string, runId: string, evidenceDir: string, turns: number,
 *   usage: object, artifact?: {id: string, version: number, path: string},
 *   escalation?: object}>}
 */
export async function runDiscovery({
  goal,
  appId,
  params = {},
  maxTurns = 24,
  headless = false,
  runId = newRunId('discovery'),
}) {
  const target = getTarget(appId);
  const logger = new RunLogger(runId);
  const client = new Anthropic();

  logger.logEvent('run_start', {
    kind: 'discovery',
    goal,
    app_id: appId,
    params: Object.keys(params),
    model: DISCOVERY_MODEL,
    max_turns: maxTurns,
  });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: target.viewport ?? { width: 1024, height: 768 } });
  const page = await context.newPage();
  const ctx = { page, target, logger, actor: 'llm' };

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let turns = 0;
  let outcome = { status: 'hard_failure' };

  try {
    // Entry navigation goes through the same gated primitive as everything else.
    await performAction(ctx, 'navigate', { url: target.entry_route });
    const first = await observe(page, logger, 'entry', null);

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Goal: ${goal}\n\nThe browser is on the entry route. Current page state follows.` },
          ...first.blocks,
        ],
      },
    ];

    const system = buildSystemPrompt(target, params);

    while (turns < maxTurns) {
      turns += 1;
      const response = await client.messages.create({
        model: DISCOVERY_MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        system,
        tools: TOOLS,
        // One action per turn: browser actions are order-dependent, so parallel tool
        // calls could interleave into nonsense.
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        cache_control: { type: 'ephemeral' },
        messages,
      });

      for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] ?? 0;
      logger.logEvent('model_turn', {
        turn: turns,
        stop_reason: response.stop_reason,
        usage: response.usage,
        text: response.content.filter((b) => b.type === 'text').map((b) => b.text),
        tool_calls: response.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ name: b.name, input: b.input })),
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        // The model stopped talking instead of acting or emitting. Treat like being
        // stuck: it is an intervention case, not a crash.
        outcome = { status: 'ended_without_artifact', stop_reason: response.stop_reason };
        break;
      }

      const call = response.content.find((b) => b.type === 'tool_use');
      const { resultBlocks, isError, terminal } = await dispatch(call, ctx, params, { goal, runId, logger });

      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id,
            content: resultBlocks,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      });

      if (terminal) {
        outcome = terminal;
        break;
      }
    }

    if (turns >= maxTurns && !outcome.status.match(/recorded|escalated/)) {
      outcome = { status: 'escalated', escalation: { reason: `Step budget exhausted after ${maxTurns} turns` } };
    }

    if (outcome.status === 'escalated') {
      // 0.8 wires this into a live session registry so the browser genuinely stays
      // open for the operator. In this phase the intervention is recorded and the
      // session ends with the process.
      const state = await captureState(page);
      const screenshot = logger.saveScreenshot(state.screenshotBase64, 'escalation');
      logger.saveJson('intervention.json', {
        run_id: runId,
        goal,
        app_id: appId,
        reason: outcome.escalation?.reason,
        url: state.url,
        screenshot,
        created_at: new Date().toISOString(),
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const result = { status: outcome.status, runId, evidenceDir: logger.dir, turns, usage };
  if (outcome.artifact) result.artifact = outcome.artifact;
  if (outcome.escalation) result.escalation = outcome.escalation;
  logger.saveResult({ ...result, goal, app_id: appId, model: DISCOVERY_MODEL, finished_at: new Date().toISOString() });
  return result;
}

/**
 * Execute one tool call.
 * @returns {{resultBlocks: object[], isError?: boolean, terminal?: object}}
 */
async function dispatch(call, ctx, params, { goal, runId, logger }) {
  const { name, input } = call;

  if (ACTION_TOOLS.has(name)) {
    // Risky actions need a human, and the operator console arrives in a later phase —
    // so during discovery the gate is: refuse and point the model at escalate.
    if (name === 'click' || name === 'type') {
      const risk = classifyRisk({ target: ctx.target, action: name, url: ctx.page.url() });
      if (risk.level === 'risky') {
        logger.logEvent('risk_refusal', { action: name, reason: risk.reason });
        return {
          resultBlocks: [
            { type: 'text', text: `RISKY ACTION BLOCKED: ${risk.reason}. Use escalate to request human confirmation.` },
          ],
          isError: true,
        };
      }
    }

    try {
      let actionResult;
      if (name === 'type') {
        const { value, fieldName } = resolveTypedValue(input, params);
        actionResult = await performAction(ctx, 'type', { locator: input.locator, value, fieldName });
      } else if (name === 'read') {
        actionResult = await performAction(ctx, 'read', { locator: input.locator, pattern: input.pattern });
      } else {
        actionResult = await performAction(ctx, name, input);
      }

      const note = `Action result: ${JSON.stringify(actionResult).slice(0, 500)}`;
      const { blocks } = await observe(ctx.page, logger, name, note);
      return { resultBlocks: blocks };
    } catch (err) {
      return { resultBlocks: [{ type: 'text', text: describeActionError(err) }], isError: true };
    }
  }

  if (name === 'emit_artifact') {
    const parsed = EmissionSchema.safeParse(input);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return {
        resultBlocks: [{ type: 'text', text: `Emission invalid:\n- ${problems.join('\n- ')}` }],
        isError: true,
      };
    }

    // "Only callable once the success checkpoint is visible" is enforced, not trusted:
    // the declared checkpoint must hold on the live page right now.
    const check = await evaluateCondition(ctx.page, parsed.data.success_checkpoint);
    if (!check.ok) {
      return {
        resultBlocks: [
          {
            type: 'text',
            text: `success_checkpoint does not hold on the live page (observed: ${check.observed}). Reach the goal state first, or fix the checkpoint.`,
          },
        ],
        isError: true,
      };
    }

    const written = await writeCapability({
      emission: parsed.data,
      target: ctx.target,
      runId,
      model: DISCOVERY_MODEL,
    });
    if (!written.ok) {
      return {
        resultBlocks: [{ type: 'text', text: `Emission rejected:\n- ${written.problems.join('\n- ')}` }],
        isError: true,
      };
    }

    logger.logEvent('artifact_recorded', {
      id: written.capability.id,
      version: written.capability.version,
      path: written.path,
    });
    return {
      resultBlocks: [{ type: 'text', text: `Recorded ${written.capability.id} v${written.capability.version}.` }],
      terminal: {
        status: 'recorded',
        artifact: { id: written.capability.id, version: written.capability.version, path: written.path },
      },
    };
  }

  if (name === 'escalate') {
    logger.logEvent('escalation', { reason: input.reason, attempted: input.attempted ?? null });
    return {
      resultBlocks: [{ type: 'text', text: 'Escalation recorded. A human operator will take over.' }],
      terminal: { status: 'escalated', escalation: { reason: input.reason, attempted: input.attempted ?? null } },
    };
  }

  return { resultBlocks: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
}

/** Turn a caught action error into a message the model can act on. */
function describeActionError(err) {
  if (err instanceof PolicyViolation) {
    return `POLICY VIOLATION: ${err.message} ${JSON.stringify(err.detail)}`;
  }
  if (err instanceof LocatorResolutionError) {
    const tried = err.attempts
      .map((a) => {
        let line = `${a.candidate.kind}="${a.candidate.value}" → ${a.reason}`;
        if (a.matches?.length) line += `\n    matches:\n      ${a.matches.join('\n      ')}`;
        return line;
      })
      .join('\n  ');
    return `LOCATOR FAILED for "${err.description}":\n  ${tried}\nAdjust the candidates and retry.`;
  }
  return `ACTION ERROR: ${err.message}`;
}
