/**
 * Deterministic replay — the production execution path.
 *
 * This file NEVER calls an LLM. Not to pick a locator, not to recover from an error,
 * not to classify a result. That is the central claim of the whole system: the model
 * discovers once, and everything after that is a typed function call. If an import of
 * the Anthropic SDK ever appears in this file, the thesis is broken.
 *
 * Every step resolves to exactly one of four outcomes, and the ordering of the checks
 * below is the part worth reading closely:
 *
 *   1. Declared business outcomes are checked FIRST. When "no such member" happens, the
 *      step's success checkpoint will also fail — so checking the checkpoint first would
 *      report a HARD_FAILURE for something that is a perfectly good answer. That
 *      inversion is the most common way this problem gets got wrong.
 *   2. Then the success checkpoint.
 *   3. Only if a checkpoint fails do we try the bounded recovery table, then re-check.
 *   4. Anything still unresolved is a HARD_FAILURE carrying step, expectation,
 *      observation, and every locator candidate that was tried.
 *
 * Hands off to: api/artifacts.js, api/capabilities.js, cli/replay.js.
 */

import { chromium } from 'playwright';
import { getTarget, resolveUrl } from '../config/app-config.js';
import { recordReplayOutcome } from '../schema/store.js';
import { validateParams } from '../schema/validate-params.js';
import { performAction, click } from './actions.js';
import { LocatorResolutionError, MalformedStep, MissingCredential } from './errors.js';
import { captureState, evaluateCondition } from './perception.js';
import { attemptRecovery } from './recovery-table.js';

/**
 * Work out what a `type` step should type.
 *
 * Three mutually exclusive sources, in precedence order. Credentials come from the
 * environment by NAME so that a secret never lives in the artifact — which is what lets
 * the same recording run against a different tenant with different credentials.
 */
function resolveStepValue(step, params) {
  if (step.value_from !== undefined) {
    const value = params[step.value_from];
    if (value === undefined) {
      throw new MalformedStep(step.index, `parameter "${step.value_from}" was not supplied`);
    }
    return { value: String(value), fieldName: step.value_from };
  }
  if (step.value_from_env !== undefined) {
    const value = process.env[step.value_from_env];
    if (!value) throw new MissingCredential(step.value_from_env);
    return { value, fieldName: step.value_from_env };
  }
  if (step.value_literal !== undefined) {
    return { value: step.value_literal, fieldName: null };
  }
  throw new MalformedStep(step.index, 'a "type" action needs value_from, value_from_env, or value_literal');
}

/** Build the argument object for one step's action primitive. */
function argsForStep(step, params) {
  switch (step.action) {
    case 'navigate':
      if (!step.url) throw new MalformedStep(step.index, '"navigate" requires a url');
      return { url: step.url };
    case 'click':
      if (!step.locator) throw new MalformedStep(step.index, '"click" requires a locator');
      return { locator: step.locator };
    case 'type': {
      if (!step.locator) throw new MalformedStep(step.index, '"type" requires a locator');
      const { value, fieldName } = resolveStepValue(step, params);
      return { locator: step.locator, value, fieldName };
    }
    case 'read':
      if (!step.locator) throw new MalformedStep(step.index, '"read" requires a locator');
      return { locator: step.locator, pattern: step.extract_pattern };
    case 'wait_for':
      return { condition: step.expected_outcome };
    default:
      throw new MalformedStep(step.index, `unknown action "${step.action}"`);
  }
}

/**
 * Check a step's declared business outcomes.
 * @returns {Promise<{code: string, message: string}|null>} the first rule that matched
 */
async function matchBusinessOutcome(page, step) {
  for (const rule of step.business_outcomes ?? []) {
    const { ok } = await evaluateCondition(page, rule.detect);
    if (ok) return { code: rule.code, message: rule.message };
  }
  return null;
}

/**
 * Execute a capability's steps against an already-open page.
 *
 * Separated from browser lifecycle so escalation can reuse it on a live session that is
 * already mid-flow, rather than being forced to start a fresh browser.
 *
 * @returns {Promise<object>} the structured replay result
 */
export async function executeSteps(ctx, capability, params) {
  const outputs = {};
  const stepResults = [];
  const recoveries = [];

  for (const step of capability.steps) {
    const record = { index: step.index, intent: step.intent, action: step.action };
    const started = Date.now();

    try {
      // --- act -------------------------------------------------------------
      const actionResult = await performAction(ctx, step.action, argsForStep(step, params));

      // --- 1. declared business outcomes, BEFORE the checkpoint -------------
      const business = await matchBusinessOutcome(ctx.page, step);
      if (business) {
        record.outcome = 'BUSINESS_OUTCOME';
        record.business_outcome = business;
        record.duration_ms = Date.now() - started;
        stepResults.push(record);
        return {
          outcome: 'BUSINESS_OUTCOME',
          business_outcome: { ...business, step: step.index, intent: step.intent },
          outputs,
          steps: stepResults,
          recoveries,
          failure: null,
        };
      }

      // --- 2. the success checkpoint ---------------------------------------
      let check = await evaluateCondition(ctx.page, step.expected_outcome);

      // --- 3. bounded recovery, then re-check exactly once ------------------
      if (!check.ok) {
        const applied = await attemptRecovery(ctx, { evaluateCondition, click });
        if (applied.length > 0) {
          recoveries.push({ step: step.index, applied });
          check = await evaluateCondition(ctx.page, step.expected_outcome);
          if (check.ok) record.outcome = 'RECOVERABLE';
        }
      }

      // --- 4. still failing => hard failure ---------------------------------
      if (!check.ok) {
        const state = await captureState(ctx.page, { screenshot: true });
        record.outcome = 'HARD_FAILURE';
        record.duration_ms = Date.now() - started;
        stepResults.push(record);
        return {
          outcome: 'HARD_FAILURE',
          outputs,
          steps: stepResults,
          recoveries,
          business_outcome: null,
          failure: {
            step: step.index,
            intent: step.intent,
            action: step.action,
            expected: step.expected_outcome,
            observed: check.observed,
            url: state.url,
            screenshot_base64: state.screenshotBase64,
          },
        };
      }

      // --- bind declared outputs -------------------------------------------
      if (step.extract_as) {
        outputs[step.extract_as] = actionResult.extracted ?? actionResult.raw ?? null;
        record.extracted_to = step.extract_as;
      }

      record.outcome = record.outcome ?? 'SUCCESS';
      record.duration_ms = Date.now() - started;
      stepResults.push(record);
    } catch (err) {
      // An element that isn't there may not be a fault — it may BE the answer.
      //
      // "This member holds no savings account" shows up as a locator that resolves to
      // nothing, and reporting that as a hard failure would repeat exactly the mistake
      // this outcome contract exists to prevent. So a LocatorResolutionError gets one
      // more question asked of it before being called a failure: does the page match a
      // business outcome this step declared?
      //
      // Deliberately narrow. A MalformedStep is a fault in us, never
      // a business answer, and must never be reclassified this way.
      if (err instanceof LocatorResolutionError) {
        const business = await matchBusinessOutcome(ctx.page, step);
        if (business) {
          record.outcome = 'BUSINESS_OUTCOME';
          record.business_outcome = business;
          record.duration_ms = Date.now() - started;
          stepResults.push(record);
          return {
            outcome: 'BUSINESS_OUTCOME',
            business_outcome: { ...business, step: step.index, intent: step.intent },
            outputs,
            steps: stepResults,
            recoveries,
            failure: null,
          };
        }
      }

      // Locator, policy, and malformed-step errors are all HARD_FAILURE — but each
      // carries different debugging detail, so the report keeps the distinction.
      const state = await captureState(ctx.page, { screenshot: true }).catch(() => ({}));
      record.outcome = 'HARD_FAILURE';
      record.duration_ms = Date.now() - started;
      stepResults.push(record);

      return {
        outcome: 'HARD_FAILURE',
        outputs,
        steps: stepResults,
        recoveries,
        business_outcome: null,
        failure: {
          step: step.index,
          intent: step.intent,
          action: step.action,
          error_type: err.name,
          message: err.message,
          expected: step.expected_outcome,
          observed: err instanceof LocatorResolutionError ? err.attempts : (err.detail ?? null),
          url: state.url ?? null,
          screenshot_base64: state.screenshotBase64 ?? null,
        },
      };
    }
  }

  // --- overall success checkpoint ------------------------------------------
  const finalCheck = await evaluateCondition(ctx.page, capability.success_checkpoint);
  if (!finalCheck.ok) {
    const state = await captureState(ctx.page, { screenshot: true });
    return {
      outcome: 'HARD_FAILURE',
      outputs,
      steps: stepResults,
      recoveries,
      business_outcome: null,
      failure: {
        step: 'success_checkpoint',
        intent: 'Overall goal verification',
        expected: capability.success_checkpoint,
        observed: finalCheck.observed,
        url: state.url,
        screenshot_base64: state.screenshotBase64,
      },
    };
  }

  return {
    outcome: recoveries.length > 0 ? 'RECOVERABLE' : 'SUCCESS',
    outputs,
    steps: stepResults,
    recoveries,
    business_outcome: null,
    failure: null,
  };
}

/**
 * Replay a capability end to end, managing the browser lifecycle.
 *
 * @param {object} args
 * @param {object} args.capability a validated Capability
 * @param {object} args.params     caller-supplied inputs
 * @param {boolean} [args.headless]
 * @param {object} [args.logger]   evidence logger
 * @returns {Promise<object>} structured result — never throws for an expected outcome
 */
export async function replayCapability({ capability, params = {}, headless = true, logger = null }) {
  const startedAt = Date.now();

  const base = {
    capability: { id: capability.id, version: capability.version, name: capability.name },
    params_supplied: Object.keys(params),
    started_at: new Date(startedAt).toISOString(),
  };

  // --- typed parameter validation -------------------------------------------
  try {
    validateParams(capability.input_schema, params);
  } catch (err) {
    return {
      ...base,
      outcome: 'HARD_FAILURE',
      outputs: null,
      steps: [],
      recoveries: [],
      business_outcome: null,
      failure: { step: 'pre-flight', error_type: err.name, message: err.message, errors: err.errors },
      duration_ms: Date.now() - startedAt,
    };
  }

  let target;
  try {
    target = getTarget(capability.target.app_id);
  } catch (err) {
    return {
      ...base,
      outcome: 'HARD_FAILURE',
      outputs: null,
      steps: [],
      recoveries: [],
      business_outcome: null,
      failure: { step: 'pre-flight', error_type: err.name, message: err.message },
      duration_ms: Date.now() - startedAt,
    };
  }

  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage({ viewport: target.viewport ?? { width: 1024, height: 768 } });
    const ctx = { page, target, logger, actor: 'replay' };

    await page.goto(resolveUrl(target, capability.target.entry_route), {
      waitUntil: 'domcontentloaded',
    });

    const result = await executeSteps(ctx, capability, params);

    // Fold this outcome into the artifact's rolling confidence signal. Only runs that
    // actually exercised the recording count — pre-flight refusals and infrastructure
    // errors say nothing about the recording's reliability. Best-effort by design: a
    // capability that never came from the store (a test fixture) has nowhere to record
    // to, and telemetry must never turn a completed replay into a failure.
    try {
      recordReplayOutcome(capability.id, capability.version, result.outcome);
    } catch {
      /* see above — telemetry never fails a completed replay */
    }

    return { ...base, ...result, duration_ms: Date.now() - startedAt };
  } catch (err) {
    // Anything escaping executeSteps is infrastructure, not a flow outcome.
    return {
      ...base,
      outcome: 'HARD_FAILURE',
      outputs: null,
      steps: [],
      recoveries: [],
      business_outcome: null,
      failure: {
        step: 'infrastructure',
        error_type: err.name,
        message: err.message,
      },
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    await browser.close();
  }
}
