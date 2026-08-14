/**
 * Escalation mechanics: ownership, the per-run mutex, manual actions, and the resume
 * signal — everything about the handoff EXCEPT the model (which costs money and is
 * proven by the committed evidence runs instead).
 *
 * The browser-backed tests drive the live mock bank, because a manual action is only
 * proven real if it lands on a real page through the same gated primitives.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// The database must point at a throwaway file BEFORE any module touches it, which is
// why everything below is imported dynamically after this line.
process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'cas-db-')), 'test.db');

const {
  RunLock,
  guardedAgentAction,
  pauseForIntervention,
  performManualAction,
  registerSession,
  resumeRun,
  unregisterSession,
} = await import('../src/agent/escalation.js');
const { createRun, getIntervention } = await import('../src/db/sqlite.js');
const { getTarget } = await import('../src/policy/allowlist.js');
const { RunLogger } = await import('../src/evidence/logger.js');
const { chromium } = await import('playwright');

const evidenceTmp = mkdtempSync(path.join(tmpdir(), 'cas-evidence-'));

describe('RunLock: the per-run async mutex', () => {
  it('serializes overlapping work', async () => {
    const lock = new RunLock();
    const order = [];
    let inFlight = 0;
    let overlapped = false;

    const job = (id, delay) =>
      lock.withLock(async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, delay));
        order.push(id);
        inFlight -= 1;
      });

    await Promise.all([job('slow', 60), job('fast', 0)]);
    assert.deepEqual(order, ['slow', 'fast'], 'second job must wait for the first');
    assert.equal(overlapped, false, 'jobs must never run concurrently');
  });

  it('a rejection does not wedge the chain', async () => {
    const lock = new RunLock();
    await assert.rejects(lock.withLock(() => Promise.reject(new Error('boom'))));
    assert.equal(await lock.withLock(() => 'still works'), 'still works');
  });
});

describe('control transfer on a live session', () => {
  const runId = 'test-escalation-run';
  let browser;
  let session;

  before(async () => {
    const target = getTarget('mock-bank');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: target.viewport });
    const page = await context.newPage();
    createRun({ id: runId, kind: 'discovery', appId: 'mock-bank', goal: 'escalation mechanics test' });
    session = registerSession({
      runId,
      goal: 'escalation mechanics test',
      appId: 'mock-bank',
      params: {},
      browser,
      context,
      page,
      target,
      logger: new RunLogger(runId, { baseDir: evidenceTmp }),
    });
  });

  after(async () => {
    unregisterSession(runId);
    await browser?.close();
  });

  it('refuses a manual action while the agent owns the session', async () => {
    await assert.rejects(
      performManualAction(runId, { action: 'navigate', args: { url: '/login' } }),
      /owner is "agent"/,
    );
  });

  it('pause flips ownership and writes a pending intervention with context', async () => {
    // Park the page somewhere real first, as the agent would have.
    await guardedAgentAction(session, () =>
      import('../src/engine/actions.js').then(({ performAction }) =>
        performAction({ page: session.page, target: session.target, actor: 'llm' }, 'navigate', { url: '/login' }),
      ),
    );

    const { interventionId } = await pauseForIntervention(session, {
      reason: 'test: needs a human',
      source: 'model',
    });

    assert.equal(session.owner, 'paused');
    const row = getIntervention(interventionId);
    assert.equal(row.status, 'pending');
    assert.equal(row.run_id, runId);
    assert.ok(row.context.url.includes('/login'), 'context carries where the run stopped');
    assert.ok(row.context.screenshot, 'context carries a screenshot reference');
  });

  it('refuses agent actions while paused', async () => {
    await assert.rejects(
      guardedAgentAction(session, () => 'should not run'),
      /owner is "paused"/,
    );
  });

  it('the human drives the SAME live page through the same primitives', async () => {
    const typed = await performManualAction(runId, {
      action: 'type',
      args: {
        locator: { description: 'Username field', candidates: [{ kind: 'placeholder', value: 'Username' }] },
        value: 'teller01',
        fieldName: 'username',
      },
    });
    assert.ok(typed.url.includes('/login'), 'the action landed on the run’s own page');
    assert.equal(session.owner, 'paused', 'ownership returns to paused after each manual step');

    const value = await session.page.getByPlaceholder('Username').inputValue();
    assert.equal(value, 'teller01', 'the live page actually changed');
  });

  it('resume resolves the intervention and releases the parked loop', async () => {
    const interventionId = session.interventionId;
    const resumed = session.resumeSignal.promise;

    resumeRun(runId, { note: 'typed the username for you' });

    assert.equal(session.owner, 'agent');
    assert.deepEqual(await resumed, { note: 'typed the username for you' });

    const row = getIntervention(interventionId);
    assert.equal(row.status, 'resolved');
    assert.equal(row.resolution.manual_actions, 1, 'what the human did is recorded');
  });

  it('a second resume is refused — control is already back', () => {
    assert.throws(() => resumeRun(runId, {}), /not "paused"/);
  });
});
