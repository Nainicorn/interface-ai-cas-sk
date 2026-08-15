/**
 * New test run: goal + login (persona) + params against the app selected in the
 * sidebar. Fires `run-started` so the run list and live viewer pick it up.
 * API: POST /api/runs.
 */

import { esc, parseParams, postJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/goal-form/goal-form.html')).text();

  const noApp = root.querySelector('[data-noapp]');
  const form = root.querySelector('[data-form]');
  const appName = root.querySelector('[data-app-name]');
  const goalInput = root.querySelector('[name=goal]');
  const goalsWrap = root.querySelector('[data-goals-wrap]');
  const goalsSelect = root.querySelector('[name=saved_goal]');
  const personaWrap = root.querySelector('[data-persona-wrap]');
  const personaSelect = root.querySelector('[name=persona]');
  const status = root.querySelector('[data-status]');

  let target = null;
  let savedGoals = [];
  let prefilled = '';

  window.addEventListener('app-selected', (event) => {
    target = event.detail.target;
    noApp.hidden = true;
    form.hidden = false;
    appName.textContent = target.display_name;

    // Saved goals are named tests — picking one fills the goal box, still editable.
    savedGoals = target.goals ?? [];
    goalsWrap.hidden = savedGoals.length === 0;
    goalsSelect.innerHTML = savedGoals.map((g, i) => `<option value="${i}">${esc(g.name)}</option>`).join('');

    // Prefill from the first saved goal, but never clobber the user's typing.
    if (!goalInput.value || goalInput.value === prefilled) {
      goalInput.value = savedGoals[0]?.text ?? '';
      prefilled = goalInput.value;
    }

    const personas = target.personas ?? [];
    personaWrap.hidden = personas.length === 0;
    personaSelect.innerHTML = personas
      .map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.note ? ` — ${esc(p.note)}` : ''}</option>`)
      .join('');
  });

  goalsSelect.addEventListener('change', () => {
    const picked = savedGoals[Number(goalsSelect.value)];
    if (!picked) return;
    goalInput.value = picked.text;
    prefilled = picked.text;
  });

  window.addEventListener('apps-empty', () => {
    target = null;
    noApp.hidden = false;
    form.hidden = true;
  });

  root.querySelector('button').addEventListener('click', async () => {
    if (!target) return;
    try {
      status.textContent = 'Starting…';
      const { run_id: runId } = await postJson('/api/runs', {
        app_id: target.app_id,
        goal: goalInput.value,
        params: parseParams(root.querySelector('[name=params]').value),
        ...(personaWrap.hidden ? {} : { persona: personaSelect.value }),
      });
      status.textContent = `Started ${runId} — watch it live below.`;
      window.dispatchEvent(new CustomEvent('run-started', { detail: { runId } }));
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });
}
