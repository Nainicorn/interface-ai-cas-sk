/**
 * Operator panel: appears ONLY when a run is paused and needs a human, and closes
 * itself once control is handed back.
 *
 * The human's channel back to the agent is language, not selectors. The goal was
 * written in plain English and the model reasons in plain English, so asking an
 * operator to hand-assemble an action type, a locator kind, and a role inverted the
 * premise — and it was never necessary: the run is headed Chromium, so a human can
 * simply use the window, and `resume` already passes a note into the model's context
 * before it re-observes the page (src/agent/discovery.js resumeMessage).
 *
 * So this panel offers exactly two things: a place to say what happened or what should
 * happen next, and a button to hand control back. Manual clicking happens in the real
 * browser window, which is the same session by construction — which is precisely what
 * the brief's "operate the SAME live session" requirement asks for.
 *
 * performManualAction (src/agent/escalation.js) is still there and still routes human
 * actions through the same five primitives, tagged `actor: "human"` in the evidence.
 * It is a real part of the design; it just stops being what the operator is asked to
 * fill in by hand.
 *
 * Scoped to the selected app, like everything else in the console: the panel drives one
 * specific run's live page, so it must belong to the app you are looking at.
 * API: GET /api/escalations?status=pending, POST /api/escalations/:id/resume.
 */

import { onSelectedApp, selectedAppId } from '/global/selected-app.js';
import { getJson, postJson } from '/global/ui.js';

const fetchPending = () => getJson('/api/escalations?status=pending');

function render(root, pending) {
  const panel = root.querySelector('[data-panel]');
  // Re-render only when a different intervention arrives, so a half-typed note survives
  // the poll. (The live viewer above this panel already shows the paused page.)
  if (panel.dataset.intervention === String(pending.id)) return;
  panel.dataset.intervention = String(pending.id);

  panel.replaceChildren(root.querySelector('[data-panel-template]').content.cloneNode(true));
  panel.querySelector('[data-goal]').textContent = pending.context.goal ?? 'Run';
  panel.querySelector('[data-reason]').textContent = pending.reason;
  panel.querySelector('[data-url]').textContent = pending.context.url ?? '';

  const feedback = panel.querySelector('[data-feedback]');
  const resume = panel.querySelector('[data-resume]');

  resume.addEventListener('click', async () => {
    resume.disabled = true;
    try {
      const note = panel.querySelector('[name=note]').value.trim();
      await postJson(`/api/escalations/${encodeURIComponent(pending.id)}/resume`, { note: note || null });
      delete panel.dataset.intervention;
      root.hidden = true; // the panel's job is done; the live viewer shows the rest
    } catch (err) {
      resume.disabled = false;
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
    // its button can never post to the previous app's run.
    root.querySelector('[data-panel]').dataset.intervention = '';
    refresh();
  });
}
