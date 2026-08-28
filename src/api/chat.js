/**
 * The chatbot's back end: one conversational turn, streamed.
 *
 * This is the demo driver over the capability API, not a second product. It owns no
 * state, no memory, and no idea how any flow works — the browser holds the transcript
 * and sends it back each turn, and everything the model can do it does by calling a
 * capability from the catalog.
 *
 * Two things are load-bearing:
 *
 *   1. The key stays here. The Anthropic call happens server-side because a browser that
 *      held ANTHROPIC_API_KEY would be handing it to anyone who opened devtools.
 *   2. The guardrails are not re-implemented. Invocation goes through catalog.js's
 *      invokeByName, so approval, allowlist, risk and evidence apply exactly as they do
 *      to an outside HTTP caller. The chatbot cannot reach a capability a human has not
 *      approved, and a refusal comes back as a message rather than an exception.
 *
 * Streamed as server-sent events because a replay takes real seconds against a real
 * browser: the reader needs to see WHICH capability was chosen while it is still
 * running, not a spinner that resolves into a wall of text.
 *
 *   event: text        the model said something
 *   event: tool_start  it chose a capability; args included
 *   event: tool_end    the replay finished; the four-way result included
 *   event: done        the turn is over; the updated transcript comes back
 *   event: error       the turn died
 *
 * Hands off to: api/catalog.js (listAgentCatalog, invokeByName).
 */

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { invokeByName, listAgentCatalog } from './catalog.js';

const router = Router();

const MODEL = 'claude-opus-5';
/** Bounded: an agent that can loop forever is not a demo. */
const MAX_TURNS = 5;
/** The browser owns the transcript, so cap what it can hand back. */
const MAX_MESSAGES = 60;

const SYSTEM = [
  "You operate a bank's back-office software through recorded capabilities.",
  'Each tool is a flow a human already approved, replayed deterministically against the',
  'real UI — there is no other way for you to touch the application. Call one when it',
  "answers the user's request; if none fits, say plainly that you have no capability for",
  'it and stop. Never invent a member, a balance, or a confirmation number: every figure',
  'you report must have come back from a capability call.',
  '',
  'Report the outcome a call returns exactly as given — SUCCESS, BUSINESS_OUTCOME,',
  'RECOVERABLE, or HARD_FAILURE. Those four words describe what the recorded flow found;',
  'never apply them to your own reasoning. A BUSINESS_OUTCOME such as "no such member" is',
  'a real answer, not a failure. A refusal ("needs approval") is not a failure either —',
  'say who has to approve it and stop.',
  '',
  'Answer in two or three sentences. The console shows the run, its status and its',
  'evidence beside you, so do not restate them as a list.',
].join(' ');

/**
 * A replay result, reduced to its contract. Both the model and the panel get this one.
 *
 * The step-by-step trace is deliberately withheld from both: it is long, it is evidence
 * for a human reading the run report, and a model that reads it starts narrating the UI
 * it was never supposed to reason about. `evidence_dir` stays out too — a server
 * filesystem path has no business in a web page. The run id is the link to both.
 */
const summarize = (result) => ({
  outcome: result.outcome,
  outputs: result.outputs ?? null,
  business_outcome: result.business_outcome ?? null,
  failure: result.failure ? { step: result.failure.step, reason: result.failure.message ?? 'checkpoint did not hold' } : null,
  recoveries: result.recoveries?.map((r) => r.code) ?? [],
  run_id: result.run_id,
});

/** Only the two roles the API accepts, and only as many turns as we agreed to hold. */
const sanitize = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-MAX_MESSAGES);

/**
 * One turn. Body: { messages: [...], app_id }
 *
 * `app_id` scopes the tool list to the app selected in the console. Without it the
 * chatbot would be offered every approved capability across every registered target,
 * and "check the balance" would be ambiguous between two banks.
 */
router.post('/', async (req, res) => {
  const { messages, app_id: appId = null } = req.body ?? {};
  const transcript = sanitize(messages);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add it to .env and restart.' });
  }
  if (!transcript.length) return res.status(400).json({ error: 'No messages.' });

  let catalog;
  try {
    catalog = await listAgentCatalog(appId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // The mapping is three renames and nothing else — `id` becomes `name`, and
  // `input_schema` passes through untouched. That is the point of shaping the catalog
  // this way: an agent needs no adapter to consume it.
  const tools = catalog.map((c) => ({ name: c.id, description: c.description, input_schema: c.input_schema }));

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // A closed tab must not leave a replay driving a browser for a reader who has gone.
  let aborted = false;
  req.on('close', () => { aborted = true; });

  if (!tools.length) {
    send({
      type: 'text',
      text: 'I have no approved capabilities for this app, so there is nothing I can do yet. Record one, then approve it in the Capabilities tab.',
    });
    send({ type: 'done', messages: transcript });
    return res.end();
  }

  const client = new Anthropic();

  try {
    for (let turn = 0; turn < MAX_TURNS && !aborted; turn += 1) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        tools,
        messages: transcript,
      });

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) send({ type: 'text', text: block.text });
      }

      transcript.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use') break;

      const results = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use' || aborted) continue;

        const entry = catalog.find((c) => c.id === block.name);
        send({
          type: 'tool_start',
          id: block.id,
          capability: block.name,
          name: entry?.name ?? block.name,
          risk_level: entry?.risk_level ?? null,
          input: block.input,
        });

        let payload;
        try {
          const result = await invokeByName(block.name, block.input);
          payload = summarize(result);
          send({ type: 'tool_end', id: block.id, result: payload });
        } catch (err) {
          // A refusal is an answer the model should see and explain, not a crash: this is
          // exactly what an agent meets when a human revokes a capability mid-flight.
          payload = { refused: err.status === 403, error: err.message, detail: err.detail ?? null };
          send({ type: 'tool_end', id: block.id, result: payload });
        }

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(payload),
          is_error: Boolean(payload.error),
        });
      }

      if (!results.length) break;
      transcript.push({ role: 'user', content: results });
    }

    if (!aborted) send({ type: 'done', messages: transcript });
  } catch (err) {
    if (!aborted) send({ type: 'error', error: err.message });
  }
  res.end();
});

export default router;
