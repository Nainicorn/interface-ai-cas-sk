/**
 * Operator console: the human side of the handoff. Shows the pending intervention
 * with its context, lets the operator drive the SAME live page through the same
 * action primitives the agent uses, then hand control back.
 * API: GET /api/escalations?status=pending, POST /api/escalations/:id/{action,resume}.
 */

const fetchPending = () => fetch('/api/escalations?status=pending').then((r) => r.json());

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

/** Build the {action, args} body from the form's fields. */
function buildAction(root) {
  const value = (name) => root.querySelector(`[name=${name}]`).value.trim();
  const action = value('action');

  if (action === 'navigate') return { action, args: { url: value('url') } };

  const locator = {
    description: `operator ${action}`,
    candidates: [
      {
        kind: value('kind'),
        value: value('locator'),
        ...(value('kind') === 'role' ? { role: value('role') } : {}),
        confidence: 1,
      },
    ],
  };
  if (action === 'type') {
    return { action, args: { locator, value: value('text'), fieldName: 'operator_input' } };
  }
  return { action, args: { locator } };
}

function render(root, pending) {
  const panel = root.querySelector('[data-panel]');
  if (!pending) {
    panel.innerHTML = `<p class="muted">No pending interventions. Escalations appear here with context.</p>`;
    return;
  }
  // Re-render only when a different intervention arrives, so form input isn't clobbered.
  if (panel.dataset.intervention === String(pending.id)) {
    root.querySelector('img').src = `/api/runs/${pending.run_id}/screenshot?t=${Date.now()}`;
    return;
  }
  panel.dataset.intervention = String(pending.id);

  panel.innerHTML = `
    <p><span class="badge paused">paused</span> <b>${pending.context.goal ?? ''}</b></p>
    <p>Run <code>${pending.run_id}</code> stopped: <b>${pending.reason}</b><br>
       <span class="muted">at ${pending.context.url ?? '?'}</span></p>

    <div class="row">
      <div><label>Action</label>
        <select name="action">
          <option>click</option><option>type</option><option>navigate</option><option>read</option>
        </select></div>
      <div><label>Locator kind</label>
        <select name="kind">
          <option>role</option><option>label</option><option>placeholder</option><option>text</option><option>css</option>
        </select></div>
    </div>
    <div class="row">
      <div><label>Locator value / accessible name</label><input name="locator" placeholder="Search" /></div>
      <div><label>Role (for kind=role)</label><input name="role" placeholder="button" /></div>
    </div>
    <div class="row">
      <div><label>Text to type (type only)</label><input name="text" /></div>
      <div><label>URL (navigate only)</label><input name="url" placeholder="/search" /></div>
    </div>
    <button data-act>Perform manual step</button>
    <label>Note to the agent on resume</label>
    <input name="note" placeholder="Signed back in; session had expired" />
    <button data-resume class="secondary">Resume agent</button>
    <p data-feedback class="muted"></p>
  `;

  const feedback = panel.querySelector('[data-feedback]');
  panel.querySelector('[data-act]').addEventListener('click', async () => {
    try {
      const outcome = await post(`/api/escalations/${pending.id}/action`, buildAction(panel));
      feedback.textContent = `Done — now at ${outcome.url}`;
    } catch (err) {
      feedback.textContent = `Error: ${err.message}`;
      feedback.className = 'error';
    }
  });
  panel.querySelector('[data-resume]').addEventListener('click', async () => {
    try {
      await post(`/api/escalations/${pending.id}/resume`, { note: panel.querySelector('[name=note]').value });
      feedback.textContent = 'Control handed back to the agent.';
      delete panel.dataset.intervention;
    } catch (err) {
      feedback.textContent = `Error: ${err.message}`;
      feedback.className = 'error';
    }
  });
}

export function mount(root) {
  root.innerHTML = `
    <h2>Operator console</h2>
    <div data-panel></div>
    <img class="shot" alt="live page at pause" style="display:none" />
  `;

  const refresh = async () => {
    try {
      const pending = (await fetchPending())[0] ?? null;
      const img = root.querySelector('img');
      img.style.display = pending ? '' : 'none';
      render(root, pending);
    } catch {
      /* transient poll failure — next tick retries */
    }
  };
  refresh();
  setInterval(refresh, 2000);
}
