/**
 * Operator panel: appears ONLY when a run is paused and needs a human, and closes
 * itself once control is handed back. The human drives the run's own live page
 * through the same action primitives the agent uses.
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
function buildAction(panel) {
  const value = (name) => panel.querySelector(`[name=${name}]`).value.trim();
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
  // Re-render only when a different intervention arrives, so form input isn't clobbered.
  // (The live viewer above this panel already shows the paused page.)
  if (panel.dataset.intervention === String(pending.id)) return;
  panel.dataset.intervention = String(pending.id);

  panel.innerHTML = `
    <p style="margin:0 0 4px"><b>${pending.context.goal ?? 'Run'}</b> needs you:</p>
    <p style="margin:0 0 10px">${pending.reason}<br>
       <span class="muted mono">${pending.context.url ?? ''}</span></p>

    <div class="row">
      <div><label>Action</label>
        <select name="action">
          <option>click</option><option>type</option><option>navigate</option><option>read</option>
        </select></div>
      <div><label>Find element by</label>
        <select name="kind">
          <option>role</option><option>label</option><option>placeholder</option><option>text</option><option>css</option>
        </select></div>
    </div>
    <div class="row">
      <div><label>Element name / value</label><input name="locator" placeholder="Search" /></div>
      <div><label>Role (when finding by role)</label><input name="role" placeholder="button" /></div>
    </div>
    <div class="row">
      <div><label>Text to type (type only)</label><input name="text" /></div>
      <div><label>Route (navigate only)</label><input name="url" placeholder="/search" /></div>
    </div>
    <button data-act class="small">Perform manual step</button>
    <label>Note for the agent</label>
    <div class="row">
      <input name="note" placeholder="Signed back in; session had expired" />
      <button data-resume class="small secondary" style="flex:0 0 auto">Hand control back</button>
    </div>
    <p data-feedback class="muted" style="margin:8px 0 0"></p>
  `;

  const feedback = panel.querySelector('[data-feedback]');
  panel.querySelector('[data-act]').addEventListener('click', async () => {
    try {
      feedback.className = 'muted';
      const outcome = await post(`/api/escalations/${pending.id}/action`, buildAction(panel));
      feedback.textContent = `Done — now at ${outcome.url}`;
    } catch (err) {
      feedback.textContent = err.message;
      feedback.className = 'error';
    }
  });
  panel.querySelector('[data-resume]').addEventListener('click', async () => {
    try {
      await post(`/api/escalations/${pending.id}/resume`, { note: panel.querySelector('[name=note]').value });
      delete panel.dataset.intervention;
      root.hidden = true; // the panel's job is done; the live viewer shows the rest
    } catch (err) {
      feedback.textContent = err.message;
      feedback.className = 'error';
    }
  });
}

export function mount(root) {
  root.innerHTML = `
    <h2>Human needed <span class="hint">the run is paused; you are driving its live browser (above)</span></h2>
    <div class="context">
      <div data-panel></div>
    </div>
  `;

  const refresh = async () => {
    try {
      const pending = (await fetchPending())[0] ?? null;
      if (!pending) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      render(root, pending);
    } catch {
      /* transient poll failure */
    }
  };
  refresh();
  setInterval(refresh, 2000);
}
