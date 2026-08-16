/**
 * Operator panel: appears ONLY when a run is paused and needs a human, and closes
 * itself once control is handed back. The human drives the run's own live page
 * through the same action primitives the agent uses.
 * Scoped to the selected app, like everything else in the console: the panel drives one
 * specific run's live page, so it must belong to the app you are looking at.
 * API: GET /api/escalations?status=pending, POST /api/escalations/:id/{action,resume}.
 */

import { onSelectedApp, selectedAppId } from '/lib/selected-app.js';

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

  panel.replaceChildren(root.querySelector('[data-panel-template]').content.cloneNode(true));
  panel.querySelector('[data-goal]').textContent = pending.context.goal ?? 'Run';
  panel.querySelector('[data-reason]').textContent = pending.reason;
  panel.querySelector('[data-url]').textContent = pending.context.url ?? '';

  const feedback = panel.querySelector('[data-feedback]');
  panel.querySelector('[data-act]').addEventListener('click', async () => {
    try {
      feedback.className = 'feedback muted';
      const outcome = await post(`/api/escalations/${encodeURIComponent(pending.id)}/action`, buildAction(panel));
      feedback.textContent = `Done — now at ${outcome.url}`;
    } catch (err) {
      feedback.textContent = err.message;
      feedback.className = 'feedback error';
    }
  });
  panel.querySelector('[data-resume]').addEventListener('click', async () => {
    try {
      await post(`/api/escalations/${encodeURIComponent(pending.id)}/resume`, { note: panel.querySelector('[name=note]').value });
      delete panel.dataset.intervention;
      root.hidden = true; // the panel's job is done; the live viewer shows the rest
    } catch (err) {
      feedback.textContent = err.message;
      feedback.className = 'feedback error';
    }
  });
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/operator-console/operator-console.html')).text();

  const refresh = async () => {
    try {
      const appId = selectedAppId();
      const pending = appId
        ? ((await fetchPending()).find((p) => p.context?.app_id === appId) ?? null)
        : null;
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
  onSelectedApp(() => {
    // A different app means a different (or no) pending run; drop the rendered panel so
    // its buttons can never post to the previous app's run.
    root.querySelector('[data-panel]').dataset.intervention = '';
    refresh();
  });
}
