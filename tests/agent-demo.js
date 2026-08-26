/**
 * An AI agent using the capability catalog. NOT part of the system.
 *
 * This file lives outside src/ on purpose. The brief's framing is that the
 * agent-facing product decides WHAT to do and this system is HOW it does it —
 * so the agent is a consumer, not a component. It talks to the control plane
 * over HTTP and imports nothing from src/: no store, no policy modules, no
 * browser. If it could reach into the codebase, it would prove nothing about
 * what an outside caller can do.
 *
 * The loop is the whole demonstration:
 *
 *   1. GET /api/catalog            → approved capabilities only
 *   2. hand them to Claude as `tools`   → no translation: the catalog is
 *                                          already shaped like tool definitions
 *   3. Claude picks one and fills in    → the model chooses by reading the
 *      its typed arguments                 description; it never sees the steps
 *   4. POST /api/catalog/:id/invoke → deterministic replay, no LLM
 *   5. feed the result back             → Claude reports what it got
 *
 * Revoke the capability in the console and run this again: the model is told
 * it has no tools. A human's approval decision is what an agent can do.
 *
 *   npm run agent-demo -- "log in with test@example.com and open the study space"
 *
 * Requires ANTHROPIC_API_KEY and a running control plane (npm start).
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const BASE = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';

/**
 * The catalog, as an Anthropic `tools` array.
 *
 * The mapping is three renames and nothing else — `id` becomes `name`, and
 * `input_schema` passes through untouched. That is the point of shaping the
 * catalog this way: an agent needs no adapter to consume it.
 */
async function loadTools() {
  const res = await fetch(`${BASE}/api/catalog`).catch(() => null);
  if (!res?.ok) throw new Error(`No control plane at ${BASE} — start it with: npm start`);

  const catalog = await res.json();
  return catalog.map((c) => ({
    name: c.id,
    description: c.description,
    input_schema: c.input_schema,
  }));
}

/** Invoke one capability. The four-way result goes back to the model verbatim. */
async function invoke(id, params) {
  const res = await fetch(`${BASE}/api/catalog/${id}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  });
  const body = await res.json();

  // A refusal is an answer the model should see and explain, not a crash: this
  // is exactly what an agent meets when a human revokes a capability mid-flight.
  if (!res.ok) return { error: body.error ?? res.statusText };
  return body;
}

const task = process.argv.slice(2).join(' ');
if (!task) {
  console.error('agent-demo: give it a task, e.g.\n  npm run agent-demo -- "look up member 10001"');
  process.exit(1);
}

const tools = await loadTools();
if (!tools.length) {
  console.log('The catalog is empty, so the agent has no tools at all.');
  console.log('Approve a capability in the console (Capabilities tab), then run this again.');
  process.exit(0);
}

console.log(`Catalog: ${tools.map((t) => t.name).join(', ')}`);
console.log(`Task:    ${task}\n`);

const client = new Anthropic();
const messages = [{ role: 'user', content: task }];

// Bounded, because an agent that can loop forever is not a demo. Each pass is
// one model turn plus however many capabilities it chose to call.
for (let turn = 0; turn < 5; turn += 1) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system:
      "You operate a bank's back-office software through recorded capabilities. " +
      'Each tool is a flow a human already approved. Call one when it answers the ' +
      "user's request; if none fits, say plainly that you have no capability for it " +
      'and stop. Report the outcome a call returns exactly as given — SUCCESS, ' +
      'BUSINESS_OUTCOME, RECOVERABLE, or HARD_FAILURE. Those four words describe ' +
      'what the recorded flow found; never apply them to your own reasoning. ' +
      'A BUSINESS_OUTCOME such as "no such member" is a real answer, not a failure.',
    tools,
    messages,
  });

  for (const block of response.content) {
    if (block.type === 'text' && block.text.trim()) console.log(block.text);
  }

  if (response.stop_reason !== 'tool_use') break;

  messages.push({ role: 'assistant', content: response.content });

  const results = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;

    console.log(`\n→ invoking ${block.name}(${JSON.stringify(block.input)})`);
    const result = await invoke(block.name, block.input);
    console.log(`← ${result.outcome ?? 'REFUSED'}${result.run_id ? ` · run ${result.run_id}` : ''}\n`);

    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(result),
      is_error: Boolean(result.error),
    });
  }

  messages.push({ role: 'user', content: results });
}
