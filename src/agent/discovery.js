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
import { getTarget } from '../config/app-config.js';
import { RunLogger, newRunId } from '../evidence/logger.js';
import { createRun, updateRun } from '../evidence/runs.js';
import { writeCapability } from './artifact-writer.js';
import {
  guardedAgentAction,
  pauseForIntervention,
  registerSession,
  unregisterSession,
} from './escalation.js';
import { EmissionSchema, TOOLS } from './tools.js';

export const DISCOVERY_MODEL = 'claude-sonnet-5';

/** Thrown when an operator stops a parked run. Unwinds the loop; never a failure. */
export class RunStopped extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RunStopped';
  }
}

/** Tool names that map 1:1 onto action primitives. */
const ACTION_TOOLS = new Set(['navigate', 'click', 'read', 'wait_for', 'type']);

/** Extra model turns granted after a human unblocks a paused run. */
const RESUME_EXTRA_TURNS = 12;

function buildSystemPrompt(target, params) {
  const credentials = Object.values(target.credentials ?? {});
  const paramLines = Object.entries(params)
    .map(([name, value]) => `- ${name} = ${value}`)
    .join('\n');

  return `You are the discovery agent inside a computer-use automation system for legacy business software. You drive a real browser through five primitives. Accomplish the goal ONCE, learning the UI as you go — then record what you learned as a typed, replayable capability that will later run with NO model in the loop. The recording is the product; reaching the goal is how you learn it.

## Target
- App: ${target.display_name ?? target.app_id} (app_id: ${target.app_id})
- Entry route: ${target.entry_route} — the browser is already there.
- Stay on this origin: ${target.base_url}. Never navigate off it.
- Credentials, by env var name (the harness injects values; you never see them): ${credentials.join(', ') || 'none'}

## Run parameters
${paramLines || '- none'}

When typing caller-supplied data, use value_from with the parameter name so the recording stays parameterized. Type credentials with value_from_env.

## Perception
After each action you receive the page URL, title, accessibility tree, visible text, and a screenshot. The accessibility tree is the primary channel; the screenshot is grounding.

## Recording quality
- Every recorded step needs an expected_outcome that positively proves the step worked. Never infer success from "the action didn't error".
- Declare business_outcomes wherever the app has a legitimate non-happy path (e.g. searching for a record that doesn't exist). "No such record" is an answer the caller needs, not a failure — declare how it looks on screen so replay can classify it without guessing.
- Think past the one path you saw. For each step ask what a legitimate alternative result would look like — record missing, a sub-record the goal targets absent (e.g. the member holds no account of that type), validation rejected, permission denied — and declare those business_outcomes even if this run never hit them. Any legitimate state you leave undeclared will surface as a HARD_FAILURE at replay.
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
 * @param {string} args.appId   folder name under artifacts/
 * @param {object} [args.params]   run parameters, e.g. { member_id: '10001' }
 * @param {number} [args.maxTurns] model-call budget before forced escalation
 * @param {boolean} [args.headless]
 * @param {string} [args.runId]
 * @param {'finish'|'pause'} [args.onEscalation] what an escalation does. 'finish' ends
 *   the run with an intervention record (CLI mode — the process is about to exit).
 *   'pause' parks the loop with the browser open and awaits an operator resume
 *   (server mode — the handoff the brief asks for).
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
  runId,
  onEscalation = 'finish',
}) {
  const target = getTarget(appId);
  runId ??= newRunId(target.app_id, 'discovery'); // grouped by app on disk
  const logger = new RunLogger(runId);
  const client = new Anthropic();

  createRun({ id: runId, kind: 'discovery', appId, goal });
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
  const session = registerSession({ runId, goal, appId, params, browser, context, page, target, logger });

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

    while (true) {
      if (turns >= maxTurns) {
        const reason = `Step budget exhausted after ${maxTurns} turns`;
        if (onEscalation !== 'pause') {
          outcome = { status: 'escalated', escalation: { reason } };
          break;
        }
        const note = await parkForOperator(session, { reason, source: 'step_budget' });
        maxTurns += RESUME_EXTRA_TURNS;
        const obs = await observe(page, logger, 'resumed', null);
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: resumeMessage(note) },
            ...obs.blocks,
          ],
        });
      }
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

      // Escalation is handled in the loop, not in dispatch, because in 'pause' mode it
      // must suspend THIS loop mid-conversation and pick it back up on resume.
      if (call.name === 'escalate') {
        logger.logEvent('escalation', { reason: call.input.reason, attempted: call.input.attempted ?? null });
        if (onEscalation !== 'pause') {
          messages.push(toolResult(call.id, [{ type: 'text', text: 'Escalation recorded. A human operator will take over.' }]));
          outcome = { status: 'escalated', escalation: { reason: call.input.reason, attempted: call.input.attempted ?? null } };
          break;
        }
        const note = await parkForOperator(session, { reason: call.input.reason, source: 'model' });
        maxTurns += RESUME_EXTRA_TURNS;
        const obs = await observe(page, logger, 'resumed', null);
        messages.push(toolResult(call.id, [{ type: 'text', text: resumeMessage(note) }, ...obs.blocks]));
        continue;
      }

      const { resultBlocks, isError, terminal } = await dispatch(call, session, ctx, params, { goal, runId, logger });
      messages.push(toolResult(call.id, resultBlocks, isError));

      if (terminal) {
        outcome = terminal;
        break;
      }
    }

    if (outcome.status === 'escalated') {
      // Only reachable in 'finish' mode (CLI): the process is about to exit, so the
      // handoff cannot happen live — record the intervention context to evidence
      // instead. 'pause' mode escalations never exit the loop this way.
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
  } catch (err) {
    // An operator stop unwinds the loop through here. It is a decision, not a fault, so
    // it does not become a hard_failure — and stopRun() already wrote the run's status.
    if (!(err instanceof RunStopped)) throw err;
    outcome = { status: 'stopped', stop_reason: err.message };
  } finally {
    unregisterSession(runId);
    await browser.close().catch(() => {});
  }

  const result = { status: outcome.status, runId, evidenceDir: logger.dir, turns, usage };
  if (outcome.artifact) result.artifact = outcome.artifact;
  if (outcome.escalation) result.escalation = outcome.escalation;
  if (outcome.status === 'stopped') return result; // stopRun() owns the record
  updateRun(runId, {
    status: outcome.status,
    detail: {
      artifact: outcome.artifact ?? null,
      turns,
      usage,
      model: DISCOVERY_MODEL,
      evidence_dir: logger.dir,
      escalation: outcome.escalation ?? null,
      finished_at: new Date().toISOString(),
    },
  });
  return result;
}

/** Shorthand for the tool_result user message every dispatched call gets back. */
function toolResult(toolUseId, content, isError = false) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }],
  };
}

function resumeMessage(note) {
  return `A human operator intervened${note ? `: ${note}` : ''}. Control is back with you — continue from the current page state.`;
}

/**
 * Park the loop for a human. Returns the operator's note once resumed. The browser
 * and the whole conversation stay live across the wait; that is the entire point.
 */
async function parkForOperator(session, { reason, source }) {
  const { resumed } = await pauseForIntervention(session, { reason, source });
  const { note, stopped } = await resumed;
  // stopRun() settles the same promise resume() does; the loop must not carry on.
  if (stopped || session.stopped) throw new RunStopped(note ?? 'Stopped by operator');
  return note;
}

/**
 * Execute one tool call.
 * @returns {{resultBlocks: object[], isError?: boolean, terminal?: object}}
 */
async function dispatch(call, session, ctx, params, { goal, runId, logger }) {
  const { name, input } = call;

  if (ACTION_TOOLS.has(name)) {
    try {
      // Under the session lock, with an ownership check: while a human holds the
      // session, the agent physically cannot act on the page.
      const actionResult = await guardedAgentAction(session, () => {
        if (name === 'type') {
          const { value, fieldName } = resolveTypedValue(input, params);
          return performAction(ctx, 'type', { locator: input.locator, value, fieldName });
        }
        if (name === 'read') {
          return performAction(ctx, 'read', { locator: input.locator, pattern: input.pattern });
        }
        return performAction(ctx, name, input);
      });

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

  return { resultBlocks: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
}

/** Turn a caught action error into a message the model can act on. */
function describeActionError(err) {
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
