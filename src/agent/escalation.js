/**
 * Escalation & control transfer: who owns a live browser session, and how it changes hands.
 *
 * The brief's requirement is specific: the human operates the SAME live session the
 * automation was using, then hands control back. So a paused run keeps its Playwright
 * page open, an operator drives it through the same action primitives the agent uses,
 * and resume re-enters the discovery loop from the page's current state.
 *
 * Two mechanisms make the handoff safe, and both are needed:
 *   1. An explicit `owner` flag ('agent' | 'paused' | 'human') — who SHOULD be acting.
 *   2. A per-run async mutex — who IS acting. Node is single-threaded, but async
 *      handlers interleave at every await, so an operator's click and an agent's click
 *      can otherwise both be mid-flight on the same page. "It's single-threaded so
 *      it's fine" would be wrong.
 *
 * Hands off to: agent/discovery.js (pause/await/resume), api/escalation.js (operator HTTP).
 */

import { performAction } from '../engine/actions.js';
import { captureState } from '../engine/perception.js';
import { createIntervention, deleteRun, resolveIntervention, updateRun } from '../evidence/runs.js';

/** Per-run mutex: a promise chain. Each withLock() call runs strictly after the last. */
export class RunLock {
  #tail = Promise.resolve();

  withLock(fn) {
    const result = this.#tail.then(() => fn());
    // Keep the chain alive even when fn rejects; the caller still sees the rejection.
    this.#tail = result.catch(() => {});
    return result;
  }
}

/** Every live run: runId → session. One entry per open Playwright context. */
const SESSION_REGISTRY = new Map();

/**
 * Register a live session. Called once per run by the discovery loop.
 * @returns the session object the loop threads through everything it does
 */
export function registerSession({ runId, goal, appId, params, browser, context, page, target, logger }) {
  const session = {
    runId,
    goal,
    appId,
    params,
    browser,
    context,
    page,
    target,
    logger,
    owner: 'agent',
    lock: new RunLock(),
    interventionId: null,
    manualActions: 0,
    resumeSignal: null,
  };
  SESSION_REGISTRY.set(runId, session);
  return session;
}

export const getSession = (runId) => SESSION_REGISTRY.get(runId) ?? null;
export const unregisterSession = (runId) => SESSION_REGISTRY.delete(runId);

/** Public view of live sessions, for the console's run list. */
export function listSessions() {
  return [...SESSION_REGISTRY.values()].map((s) => ({
    run_id: s.runId,
    goal: s.goal,
    app_id: s.appId,
    owner: s.owner,
    intervention_id: s.interventionId,
  }));
}

/**
 * Run one agent action under the session's lock, refusing unless the agent owns the
 * session. The refusal is a throw, not a wait: an agent acting while a human holds the
 * page is a bug to surface, never something to queue silently.
 */
export function guardedAgentAction(session, fn) {
  return session.lock.withLock(() => {
    if (session.owner !== 'agent') {
      throw new Error(`Agent action refused: session owner is "${session.owner}"`);
    }
    return fn();
  });
}

/**
 * Pause a run for human intervention. Sets owner to 'paused', writes the intervention
 * row with enough context to act on (goal, url, screenshot, reason), and arms the
 * resume signal the discovery loop will await.
 *
 * @returns {{interventionId: number, resumed: Promise<{note: string|null}>}}
 */
export async function pauseForIntervention(session, { reason, source }) {
  const state = await captureState(session.page);
  const screenshot = session.logger.saveScreenshot(state.screenshotBase64, 'escalation');

  session.owner = 'paused';
  session.interventionId = createIntervention({
    runId: session.runId,
    reason,
    context: {
      goal: session.goal,
      app_id: session.appId,
      url: state.url,
      title: state.title,
      screenshot,
      source, // 'model' (the escalate tool) or 'step_budget'
    },
  }).id;

  const { promise, resolve } = Promise.withResolvers();
  session.resumeSignal = { promise, resolve };

  session.logger.logEvent('paused', { intervention_id: session.interventionId, reason, source });
  try {
    updateRun(session.runId, { status: 'paused' });
  } catch {
    // A run row only exists for runs started after run-row tracking; never fatal here.
  }

  return { interventionId: session.interventionId, resumed: promise };
}

/**
 * One manual step by the operator, on the live page, through the SAME primitives the
 * agent and replay use. Owner flips paused → human → paused around the action, under
 * the lock, so an agent resume cannot interleave with a human mid-action.
 *
 * @param {string} runId
 * @param {{action: string, args: object}} step e.g. { action: 'click', args: { locator } }
 * @returns {Promise<{result: object, url: string, screenshot: string|null}>}
 */
export function performManualAction(runId, { action, args }) {
  const session = getSession(runId);
  if (!session) throw new Error(`No live session for run "${runId}"`);

  return session.lock.withLock(async () => {
    if (session.owner !== 'paused') {
      throw new Error(`Manual action refused: session owner is "${session.owner}", not "paused"`);
    }
    session.owner = 'human';
    try {
      const ctx = { page: session.page, target: session.target, logger: session.logger, actor: 'human' };
      const result = await performAction(ctx, action, args);
      session.manualActions += 1;

      const state = await captureState(session.page);
      const screenshot = session.logger.saveScreenshot(state.screenshotBase64, `human-${action}`);
      return { result, url: state.url, screenshot };
    } finally {
      session.owner = 'paused';
    }
  });
}

/**
 * Hand control back to the agent. Resolves the intervention and releases the discovery
 * loop, which re-observes the CURRENT page state — whatever the human left it as.
 */
export function resumeRun(runId, { note = null } = {}) {
  const session = getSession(runId);
  if (!session) throw new Error(`No live session for run "${runId}"`);
  if (session.owner !== 'paused') {
    throw new Error(`Resume refused: session owner is "${session.owner}", not "paused"`);
  }
  if (!session.resumeSignal) throw new Error(`Run "${runId}" is not awaiting resume`);

  resolveIntervention(session.interventionId, { note, manual_actions: session.manualActions });
  session.logger.logEvent('resumed', {
    intervention_id: session.interventionId,
    note,
    manual_actions: session.manualActions,
  });

  session.owner = 'agent';
  session.interventionId = null;
  const { resolve } = session.resumeSignal;
  session.resumeSignal = null;
  try {
    updateRun(runId, { status: 'running' });
  } catch {
    /* see pauseForIntervention */
  }
  resolve({ note });
}

/**
 * Stop a run and discard it: close the browser, then delete its evidence folder.
 *
 * A stopped run is an abandoned attempt, not a result. Keeping half a transcript would
 * put a run in the history that never reached an outcome and a folder that can never
 * produce a capability, so the whole folder goes.
 *
 * A paused run is parked on a promise that only resume() settles, so stopping has to
 * release that promise too — otherwise the discovery loop waits forever for a human who
 * has already walked away. The loop checks the stop when it wakes and unwinds without
 * writing anything further, which is what makes deleting the folder safe.
 *
 * Works on a run with no live session too (a leftover "running" row after a restart),
 * because that is exactly the row an operator most wants to clear.
 */
export async function stopRun(runId, { reason = 'Stopped by operator' } = {}) {
  const session = getSession(runId);

  if (session) {
    session.stopped = true;
    session.owner = 'stopped';

    // Release the parked loop BEFORE closing the browser, so it wakes to a clean exit
    // rather than to a torn-down page.
    const signal = session.resumeSignal;
    session.resumeSignal = null;
    signal?.resolve({ note: reason, stopped: true });

    await session.browser?.close().catch(() => {});
    unregisterSession(runId);
  }

  // Last, once nothing is left that could write into it.
  deleteRun(runId);
  return { stopped: true, deleted: true, was_live: Boolean(session) };
}
